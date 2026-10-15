import { resolveLoggerBackedRuntime } from "openclaw/plugin-sdk/extension-shared";
import { Types } from "@meshtastic/core";
import { resolveMeshtasticAccount } from "./accounts.js";
import {
  connectMeshtasticDevice,
  disconnectMeshtasticDevice,
  type MeshtasticDeviceHandle,
} from "./device-client.js";
import { decryptChannelPacket, expandPsk } from "./crypto.js";
import { isOutboundEcho, rememberOutboundEcho } from "./echo-dedupe.js";
import { handleMeshtasticInbound } from "./inbound.js";
import { formatMeshtasticChannelTarget, formatMeshtasticNodeId } from "./normalize.js";
import { formatMeshtasticEndpoint } from "./transport.js";
import type { RuntimeEnv } from "./runtime-api.js";
import { getMeshtasticRuntime } from "./runtime.js";
import type { CoreConfig, MeshtasticInboundMessage } from "./types.js";

type MeshtasticMonitorOptions = {
  accountId?: string;
  config?: CoreConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  statusSink?: (patch: {
    lastInboundAt?: number;
    lastOutboundAt?: number;
    lastError?: string;
    connected?: boolean;
    lastConnectedAt?: number;
    lastEventAt?: number;
    lastTransportActivityAt?: number;
  }) => void;
  onMessage?: (
    message: MeshtasticInboundMessage,
    handle: MeshtasticDeviceHandle,
  ) => void | Promise<void>;
};

function channelIndexFromPacket(channel: number): number {
  if (Number.isFinite(channel) && channel >= 0 && channel <= 7) {
    return channel;
  }
  return 0;
}

function statusName(status: unknown): string {
  return typeof status === "number"
    ? (Types.DeviceStatusEnum[status] ?? String(status))
    : String(status);
}

/** Inbound log line — message body only when logInboundMessageContent is enabled. */
export function formatInboundLogLine(params: {
  accountId: string;
  message: MeshtasticInboundMessage;
  decrypted?: boolean;
  logMessageContent: boolean;
}): string {
  const kind = params.message.isGroup ? "group" : "dm";
  const prefix = params.decrypted ? "inbound (decrypted)" : "inbound";
  const meta = `[${params.accountId}] ${prefix} ${kind} from ${params.message.senderId} on ${params.message.target} id=${params.message.messageId}`;
  if (!params.logMessageContent) {
    return `${meta} (${params.message.text.length} chars)`;
  }
  return `${meta}: ${params.message.text.slice(0, 80)}`;
}

type MeshtasticPacket = {
  id: number;
  rxTime: Date;
  type: "broadcast" | "direct";
  from: number;
  to: number;
  channel: number;
  data: string;
};

export function buildInboundMessage(params: {
  packet: MeshtasticPacket;
  myNodeNum: number | null;
}): MeshtasticInboundMessage | null {
  const text = params.packet.data?.trim() ?? "";
  if (!text) {
    return null;
  }
  if (params.packet.from === 0) {
    return null;
  }
  if (params.myNodeNum !== null && params.packet.from === params.myNodeNum) {
    return null;
  }
  if (isOutboundEcho(text)) {
    return null;
  }

  const meshChannel = channelIndexFromPacket(params.packet.channel);
  const senderId = formatMeshtasticNodeId(params.packet.from);
  const isGroup = params.packet.type === "broadcast";
  const target = isGroup ? formatMeshtasticChannelTarget(meshChannel) : senderId;

  if (!isGroup && params.myNodeNum !== null && params.packet.to !== params.myNodeNum) {
    return null;
  }

  return {
    messageId: String(params.packet.id),
    target,
    senderNodeNum: params.packet.from,
    senderId,
    text,
    timestamp: params.packet.rxTime?.getTime?.() ?? Date.now(),
    isGroup,
    meshChannel,
    replyToId: String(params.packet.id),
  };
}

/**
 * Monitor the Meshtastic device for inbound messages.
 *
 * The returned promise **stays pending** while the device is connected and
 * **rejects** when the device disconnects (or the abort signal fires). This
 * lets the gateway's health-monitor detect the failure and restart the channel
 * cleanly instead of getting stuck in a "stopped" loop.
 */
export function monitorMeshtasticProvider(
  opts: MeshtasticMonitorOptions,
): Promise<{ stop: () => void }> {
  const core = getMeshtasticRuntime();
  const cfg = opts.config ?? (core.config.current() as CoreConfig);
  const account = resolveMeshtasticAccount({
    cfg,
    accountId: opts.accountId,
  });

  const runtime: RuntimeEnv = resolveLoggerBackedRuntime(
    opts.runtime,
    core.logging.getChildLogger(),
  );

  if (!account.configured) {
    return Promise.reject(
      new Error(
        account.transport === "serial"
          ? `Meshtastic is not configured for account "${account.accountId}" (need serialPath in channels.meshtastic).`
          : `Meshtastic is not configured for account "${account.accountId}" (need host in channels.meshtastic).`,
      ),
    );
  }

  const logger = core.logging.getChildLogger({
    channel: "meshtastic",
    accountId: account.accountId,
  });
  const logMessageContent = account.config.logInboundMessageContent === true;

  // --- Start the async work and return a promise that settles on disconnect / abort ---
  return (async () => {
    const handle = await connectMeshtasticDevice({
      accountId: account.accountId,
      transport: account.transport,
      host: account.host,
      port: account.port,
      tls: account.tls,
      serialPath: account.serialPath,
      baudRate: account.baudRate,
      autoConfigure: false,
    });

    const allowedChannels = new Set(account.config.channels ?? [0]);
    const unsubscribers: Array<() => void> = [];

    const channelPsks = new Map<number, Uint8Array>();

    unsubscribers.push(
      handle.device.events.onChannelPacket.subscribe(
        (channel: { index?: number; settings?: { psk?: Uint8Array } }) => {
          opts.statusSink?.({
            lastEventAt: Date.now(),
            lastTransportActivityAt: Date.now(),
          });
          const idx = channel.index ?? 0;
          const rawPsk = channel.settings?.psk;
          if (rawPsk && rawPsk.length > 0) {
            const expanded = expandPsk(rawPsk);
            if (expanded) {
              channelPsks.set(idx, expanded);
            }
          }
        },
      ),
    );

    if (account.transport !== "http") {
      unsubscribers.push(
        handle.device.events.onMeshPacket.subscribe(
          (meshPacket: {
            id: number;
            from: number;
            to: number;
            channel: number;
            rxTime: number;
            payloadVariant: { case: string; value: unknown };
          }) => {
            opts.statusSink?.({
              lastEventAt: Date.now(),
              lastTransportActivityAt: Date.now(),
            });
            if (meshPacket.payloadVariant.case !== "encrypted") {
              return;
            }
            const encrypted = meshPacket.payloadVariant.value as Uint8Array;
            const chIdx = channelIndexFromPacket(meshPacket.channel);
            const psk = channelPsks.get(chIdx);
            if (!psk) {
              logger.debug?.(
                `[${account.accountId}] no PSK for channel ${chIdx}, cannot decrypt packet ${meshPacket.id}`,
              );
              return;
            }
            const decrypted = decryptChannelPacket(
              encrypted,
              psk,
              meshPacket.from,
              meshPacket.id,
              chIdx,
            );
            if (!decrypted) {
              logger.debug?.(
                `[${account.accountId}] decrypt failed for packet ${meshPacket.id} on channel ${chIdx}`,
              );
              return;
            }
            const syntheticPacket: MeshtasticPacket = {
              id: meshPacket.id,
              rxTime: new Date(meshPacket.rxTime ? meshPacket.rxTime * 1000 : Date.now()),
              type: meshPacket.to === 0xffffffff ? "broadcast" : "direct",
              from: meshPacket.from,
              to: meshPacket.to,
              channel: meshPacket.channel,
              data: new TextDecoder().decode(decrypted),
            };
            void (async () => {
              try {
                const message = buildInboundMessage({
                  packet: syntheticPacket,
                  myNodeNum: handle.myNodeNum,
                });
                if (!message) {
                  return;
                }
                if (message.isGroup && !allowedChannels.has(message.meshChannel)) {
                  return;
                }
                // console.log, not logger.info: the plugin child logger's
                // info lines never reach gateway.log (meshcore#38 pattern,
                // verified live on this channel) — inbound mesh messages are
                // airtime evidence and must be auditable. Content redaction
                // (logInboundMessageContent) is unchanged.
                console.log(
                  formatInboundLogLine({
                    accountId: account.accountId,
                    message,
                    decrypted: true,
                    logMessageContent,
                  }),
                );
                core.channel.activity.record({
                  channel: "meshtastic",
                  accountId: account.accountId,
                  direction: "inbound",
                  at: message.timestamp,
                });
                if (opts.onMessage) {
                  await opts.onMessage(message, handle);
                  return;
                }
                await handleMeshtasticInbound({
                  message,
                  account,
                  config: cfg,
                  runtime,
                  myNodeNum: handle.myNodeNum,
                  sendReply: async (target, text, replyToId) => {
                    const { sendMessageMeshtastic } = await import("./send.js");
                    await sendMessageMeshtastic(target, text, {
                      cfg,
                      accountId: account.accountId,
                      replyTo: replyToId,
                      deviceHandle: handle,
                    });
                    rememberOutboundEcho(text);
                    opts.statusSink?.({ lastOutboundAt: Date.now() });
                    core.channel.activity.record({
                      channel: "meshtastic",
                      accountId: account.accountId,
                      direction: "outbound",
                    });
                  },
                  statusSink: opts.statusSink,
                });
              } catch (err) {
                const line = `[${account.accountId}] decrypted inbound handler failed: ${String(err)}`;
                logger.error?.(line);
                runtime.error?.(line);
              }
            })();
          },
        ),
      );
    }

    unsubscribers.push(
      handle.device.events.onMessagePacket.subscribe((packet: MeshtasticPacket) => {
        opts.statusSink?.({
          lastEventAt: Date.now(),
          lastTransportActivityAt: Date.now(),
        });
        void (async () => {
          try {
            const message = buildInboundMessage({
              packet,
              myNodeNum: handle.myNodeNum,
            });
            if (!message) {
              return;
            }
            if (message.isGroup && !allowedChannels.has(message.meshChannel)) {
              if (core.logging.shouldLogVerbose()) {
                logger.debug?.(
                  `[${account.accountId}] skip mesh channel ${message.meshChannel} (not in allowlist)`,
                );
              }
              return;
            }

            // console.log, not logger.info — see above (child logger black hole).
            console.log(
              formatInboundLogLine({
                accountId: account.accountId,
                message,
                logMessageContent,
              }),
            );

            core.channel.activity.record({
              channel: "meshtastic",
              accountId: account.accountId,
              direction: "inbound",
              at: message.timestamp,
            });

            if (opts.onMessage) {
              await opts.onMessage(message, handle);
              return;
            }

            await handleMeshtasticInbound({
              message,
              account,
              config: cfg,
              runtime,
              myNodeNum: handle.myNodeNum,
              sendReply: async (target, text, replyToId) => {
                const { sendMessageMeshtastic } = await import("./send.js");
                await sendMessageMeshtastic(target, text, {
                  cfg,
                  accountId: account.accountId,
                  replyTo: replyToId,
                  deviceHandle: handle,
                });
                rememberOutboundEcho(text);
                opts.statusSink?.({ lastOutboundAt: Date.now() });
                core.channel.activity.record({
                  channel: "meshtastic",
                  accountId: account.accountId,
                  direction: "outbound",
                });
              },
              statusSink: opts.statusSink,
            });
          } catch (err) {
            const line = `[${account.accountId}] inbound handler failed: ${String(err)}`;
            logger.error?.(line);
            runtime.error?.(line);
          }
        })();
      }),
    );

    // ---- Disconnect detector: reject the outer promise when the device drops ----
    let settled = false;

    const doCleanup = () => {
      if (settled) return;
      settled = true;
      for (const unsubscribe of unsubscribers) {
        unsubscribe();
      }
      void disconnectMeshtasticDevice(account.accountId);
    };

    unsubscribers.push(
      handle.device.events.onDeviceStatus.subscribe((status: unknown) => {
        const name = statusName(status);
        const now = Date.now();
        if (
          status === Types.DeviceStatusEnum.DeviceConnected ||
          status === Types.DeviceStatusEnum.DeviceConfigured ||
          name.includes("DeviceConnected") ||
          name.includes("DeviceConfigured")
        ) {
          opts.statusSink?.({
            connected: true,
            lastConnectedAt: now,
            lastEventAt: now,
            lastTransportActivityAt: now,
          });
        } else if (
          status === Types.DeviceStatusEnum.DeviceDisconnected ||
          name.includes("DeviceDisconnected") ||
          name.toLowerCase().includes("disconnect")
        ) {
          opts.statusSink?.({
            connected: false,
            lastEventAt: now,
            lastTransportActivityAt: now,
          });
          // Device dropped — reject the lifecycle so the health-monitor restarts.
          doCleanup();
        }
        if (core.logging.shouldLogVerbose()) {
          logger.debug?.(`[${account.accountId}] device status: ${name}`);
        }
      }),
    );

    await handle.configure();

    // console.log, not logger.info: the child logger's info lines never
    // reach gateway.log (verified live: zero "connected to Meshtastic"
    // lines across months of uptime) — the connect line is the channel's
    // primary liveness evidence.
    console.log(
      `[${account.accountId}] connected to Meshtastic (${account.transport}) at ${formatMeshtasticEndpoint(account)}`,
    );

    // Return a promise that stays pending while connected. It resolves on
    // external abort and rejects on device disconnect — in both cases the
    // gateway's health-monitor can restart the channel.
    return new Promise<{ stop: () => void }>((resolve, reject) => {
      const onAbort = () => {
        if (settled) return;
        settled = true;
        doCleanup();
        resolve({ stop: () => {} });
      };
      opts.abortSignal?.addEventListener("abort", onAbort, { once: true });

      // Poll `settled` — if doCleanup() already ran (device disconnected
      // between configure() and this promise construction) reject immediately.
      if (settled) {
        opts.abortSignal?.removeEventListener("abort", onAbort);
        reject(new Error("Meshtastic device disconnected during startup"));
      }
    });
  })();
}
