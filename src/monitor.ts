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
import { DEFAULT_DURABILITY_CONFIG, type DurabilityStore } from "./durability.js";
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
  /** Inbound durability store (#8); replay runs once after connect. */
  durability?: DurabilityStore | null;
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

    // Shared dispatch path for live intake and durability replay (#8, m4):
    // one builder, identical params, channel filter applied in both modes.
    const dmSendReply = async (target: string, text: string, replyToId?: string) => {
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
    };

    const durCfg = { ...DEFAULT_DURABILITY_CONFIG, ...account.config.durability };

    const dispatchNormalized = async (
      message: MeshtasticInboundMessage,
      dispatchOpts?: { replayOf?: number; replayReceivedAt?: number; decrypted?: boolean },
    ): Promise<void> => {
      if (message.isGroup && !allowedChannels.has(message.meshChannel)) {
        if (dispatchOpts?.replayOf !== undefined) {
          opts.durability?.deadLetter(account.accountId, dispatchOpts.replayOf, "channel-not-monitored");
        } else if (core.logging.shouldLogVerbose()) {
          logger.debug?.(
            `[${account.accountId}] skip mesh channel ${message.meshChannel} (not in allowlist)`,
          );
        }
        return;
      }
      if (dispatchOpts?.replayOf === undefined) {
        // console.log, not logger.info: the plugin child logger's info lines
        // never reach gateway.log (verified live; ctx.log and console.* do —
        // meshcore#38 pattern). Inbound mesh messages are airtime evidence
        // and must be auditable. Content redaction
        // (logInboundMessageContent) is unchanged.
        console.log(
          formatInboundLogLine({
            accountId: account.accountId,
            message,
            decrypted: dispatchOpts?.decrypted,
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
      }
      await handleMeshtasticInbound({
        message,
        account,
        config: cfg,
        runtime,
        myNodeNum: handle.myNodeNum,
        sendReply: dmSendReply,
        statusSink: opts.statusSink,
        durability: opts.durability,
        replayOf: dispatchOpts?.replayOf,
        replayReceivedAt: dispatchOpts?.replayReceivedAt,
      });
    };

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
                await dispatchNormalized(message, { decrypted: true });
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
            await dispatchNormalized(message);
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
    // Wired to the settlement promise's reject once it exists (below). A
    // mid-session disconnect must reject that promise — leaving it pending
    // keeps the gateway health-monitor blind and the channel dark
    // indefinitely (meshcore#4 class bug).
    let rejectLifecycle: ((reason: Error) => void) | null = null;
    // minor 3: resolved by doCleanup so a replayed turn stops waiting on a
    // dead socket instead of running to the 5-minute cap.
    let resolveDisconnected: (() => void) | null = null;
    const disconnectedPromise = new Promise<void>((resolve) => {
      resolveDisconnected = resolve;
    });

    const doCleanup = () => {
      if (settled) return;
      settled = true;
      resolveDisconnected?.();
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
          rejectLifecycle?.(
            new Error(`Meshtastic device disconnected (${name})`),
          );
        }
        if (core.logging.shouldLogVerbose()) {
          logger.debug?.(`[${account.accountId}] device status: ${name}`);
        }
      }),
    );

    await handle.configure();

    // console.log, not logger.info — child-logger info lines never reach
    // gateway.log (default 'info' level, no override; ctx.log and console.*
    // lines do). The connect line is the channel's primary liveness
    // evidence. Note: this intentionally logs the endpoint (host:port or
    // serial path) — accepted tradeoff, matching the SDK's own non-redaction
    // of bare host strings.
    console.log(
      `[${account.accountId}] connected to Meshtastic (${account.transport}) at ${formatMeshtasticEndpoint(account)}`,
    );

    // Durability replay (#8): runs AFTER all listeners and the disconnect
    // handler are registered (review M-3), so an abort or socket loss during
    // replay is seen immediately. claimNext counts each attempt at claim;
    // afterId skips rows already tried this pass (review M-1); each event
    // races the remaining deadline so one slow turn cannot stall startup.
    if (opts.durability) {
      const store = opts.durability;
      opts.statusSink?.({
        connected: true,
        lastConnectedAt: Date.now(),
        lastTransportActivityAt: Date.now(),
      });
      const stale = store.sweepStale(account.accountId, durCfg.maxReplayAgeMs);
      if (stale.length > 0) {
        runtime.log?.(
          `[${account.accountId}] durability: ${stale.length} stale pending event(s) dead-lettered (older than maxReplayAgeMs)`,
        );
      }
      const deadline = Date.now() + 5 * 60_000;
      let claimed = 0;
      let lastClaimId = 0;
      let nullStreak = 0;
      for (;;) {
        // M1: stop on abort AND on a dropped socket (settled) — replaying over
        // a dead connection loses replies while marking rows dispatched.
        if (opts.abortSignal?.aborted || settled) {
          break;
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          runtime.log?.(
            `[${account.accountId}] durability replay time-capped after ${claimed} event(s); remainder replays next start`,
          );
          break;
        }
        const ev = store.claimNext(
          account.accountId,
          durCfg.maxDispatchAttempts,
          durCfg.leaseMs,
          lastClaimId,
        );
        if (!ev) {
          // nit 2: a guard-truncated pass resumes once before declaring empty.
          nullStreak += 1;
          if (nullStreak >= 2) {
            break;
          }
          continue;
        }
        nullStreak = 0;
        lastClaimId = ev.id;
        claimed += 1;
        let raw: MeshtasticInboundMessage | null = null;
        try {
          const rawJson = store.rawJsonOf(ev.id);
          raw = rawJson ? (JSON.parse(rawJson) as MeshtasticInboundMessage) : null;
        } catch {
          raw = null;
        }
        // minor 4: unparseable rows dead-letter immediately instead of
        // looping boots.
        if (!raw || typeof raw.text !== "string") {
          store.deadLetter(account.accountId, ev.id, raw ? "not-replayable" : "corrupt-raw");
          continue;
        }
        let onAbortOnce: (() => void) | null = null;
        const abortPromise = new Promise((resolve) => {
          if (opts.abortSignal?.aborted || settled) {
            resolve(undefined);
            return;
          }
          onAbortOnce = () => resolve(undefined);
          opts.abortSignal?.addEventListener("abort", onAbortOnce, { once: true });
        });
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            dispatchNormalized(raw, { replayOf: ev.id, replayReceivedAt: ev.receivedAt }),
            abortPromise,
            disconnectedPromise,
            new Promise((resolve) => {
              timer = setTimeout(resolve, remaining);
            }),
          ]);
        } catch (err) {
          store.releaseClaim(
            account.accountId,
            ev.id,
            err instanceof Error ? err.message : String(err),
          );
        } finally {
          if (timer !== undefined) {
            clearTimeout(timer);
          }
          if (onAbortOnce) {
            opts.abortSignal?.removeEventListener("abort", onAbortOnce);
          }
        }
      }
      if (claimed > 0) {
        runtime.log?.(`[${account.accountId}] durability replay: ${claimed} event(s) claimed`);
      }
      if (opts.abortSignal?.aborted) {
        runtime.log?.(`[${account.accountId}] durability replay aborted after ${claimed} event(s)`);
        doCleanup();
        return { stop: () => {} };
      }
    }

    // Return a promise that stays pending while connected. It resolves on
    // external abort and rejects on device disconnect — in both cases the
    // gateway's health-monitor can restart the channel.
    return new Promise<{ stop: () => void }>((resolve, reject) => {
      rejectLifecycle = reject;
      const onAbort = () => {
        if (settled) return;
        // External abort resolves (clean stop) — never route through reject.
        rejectLifecycle = null;
        doCleanup();
        resolve({ stop: () => {} });
      };
      opts.abortSignal?.addEventListener("abort", onAbort, { once: true });

      // M1: an abort that fired before this point (incl. while durability is
      // off) must still settle the monitor.
      if (opts.abortSignal?.aborted && !settled) {
        onAbort();
        return;
      }

      // Poll `settled` — if doCleanup() already ran (device disconnected
      // between configure() and this promise construction) reject immediately.
      if (settled) {
        opts.abortSignal?.removeEventListener("abort", onAbort);
        rejectLifecycle = null;
        reject(new Error("Meshtastic device disconnected during startup"));
      }
    });
  })();
}
