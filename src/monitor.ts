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
import {
  clearNodeKeyPin,
  flushNodeBookWrites,
  getNodeKeyPin,
  getRepinMarker,
  markNodeKeyManuallyVerified,
  meshtasticKeyBytesToBase64,
  observeNodeKey,
  pruneRepinMarkers,
  senderIdentityFromObservation,
  setKeyEventSink,
  setRepinMarker,
  subscribeNodeBook,
  type NodeKeyObservation,
} from "./node-book.js";
import { parseMeshtasticNodeNum } from "./normalize.js";
import { installUnknownVariantGuard } from "./unknown-variant-guard.js";
import { formatMeshtasticEndpoint } from "./transport.js";
import type { RuntimeEnv } from "./runtime-api.js";
import { getMeshtasticRuntime } from "./runtime.js";
import type { CoreConfig, MeshtasticInboundMessage, MeshtasticSenderIdentity } from "./types.js";

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
  // Sender-identity grade (issue #7) rides the metadata line — fingerprint
  // only, never a full key, and never message content.
  const identity = params.message.senderIdentity;
  const identityTag = identity
    ? ` identity=${identity.grade}${identity.grade !== "psk-grade" && identity.keyFp ? `(${identity.keyFp})` : ""}`
    : "";
  const meta = `[${params.accountId}] ${prefix} ${kind} from ${params.message.senderId} on ${params.message.target} id=${params.message.messageId}${identityTag}`;
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
  /** Structured sender-identity annotation (issue #7) — attached to the message, never to its text. */
  senderIdentity?: MeshtasticSenderIdentity;
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
    ...(params.senderIdentity ? { senderIdentity: params.senderIdentity } : {}),
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

    // Issue #25: downgrade the library's unknown-packet throw (e.g. portnum
    // 36 NODE_STATUS_APP from firmware 2.7.x) to a DEBUG line before it can
    // surface as a library ERROR through the stream path.
    installUnknownVariantGuard(handle.device, logger, account.accountId);

    const allowedChannels = new Set(account.config.channels ?? [0]);
    const unsubscribers: Array<() => void> = [];

    // Node book (#15): passive, zero airtime. Subscribed before configure()
    // so the node database the radio replays on connect is captured.
    unsubscribers.push(
      ...subscribeNodeBook(
        account.accountId,
        handle.device.events as unknown as Record<string, unknown>,
      ),
    );

    // Key book (#7): mismatches and pin evictions are security events. They
    // go through console.log, not the child logger — the child logger's info
    // lines never reach gateway.log (see the inbound-line comment below).
    setKeyEventSink((line) => console.log(line));

    // Operator re-pin (key rotation remediation, issue #7): clear the stored
    // pins for configured nodes BEFORE the connect replay, so the replay (or
    // the node's next advert) re-pins the rotated key. IDEMPOTENT: a node
    // whose pin was already re-learned after the last re-pin is skipped, so a
    // transient reconnect never re-opens first-seen. Markers for nodes that
    // are no longer listed are pruned, which re-arms a later re-addition.
    const repinNums = new Set<number>();
    for (const entry of account.config.pkiRepin ?? []) {
      const num = parseMeshtasticNodeNum(String(entry));
      if (num === undefined) {
        logger.debug?.(
          `[${account.accountId}] pkiRepin entry ${JSON.stringify(entry)} is not a node id — ignored`,
        );
        continue;
      }
      repinNums.add(num);
      const marker = getRepinMarker(account.accountId, num);
      const currentPin = getNodeKeyPin(account.accountId, num);
      if (marker !== undefined && currentPin && currentPin.firstSeenAt >= marker) {
        logger.debug?.(
          `[${account.accountId}] pkiRepin: pin for ${formatMeshtasticNodeId(num)} was already ` +
            `re-learned after the last re-pin — nothing to clear`,
        );
        continue;
      }
      const clearedFp = clearNodeKeyPin(account.accountId, num);
      setRepinMarker(account.accountId, num, Math.floor(Date.now() / 1000));
      console.log(
        clearedFp
          ? `[${account.accountId}] pkiRepin: cleared key pin for ${formatMeshtasticNodeId(num)} (was fp=${clearedFp}); next observed key re-pins (TOFU)`
          : `[${account.accountId}] pkiRepin: no stored pin for ${formatMeshtasticNodeId(num)} (nothing to clear)`,
      );
    }
    pruneRepinMarkers(account.accountId, repinNums);

    // Packet provenance map (issue #7), keyed by (from, id) — NEVER by bare
    // packet id: ids are per-node rolling counters, unique to neither sender
    // nor time. The library dispatches the raw onMeshPacket synchronously
    // BEFORE the typed events (verified in @meshtastic/core 2.6.7
    // handleMeshPacket), so the entry for a packet exists by the time its
    // typed event is graded; the (from, id) key keeps that correct even if a
    // future library refactor breaks the ordering invariant. Bounded LRU.
    type PacketProvenance = {
      pkiEncrypted: boolean;
      publicKey?: string;
      observation?: NodeKeyObservation;
    };
    const PROVENANCE_MAX_ENTRIES = 2000;
    const packetProvenance = new Map<string, PacketProvenance>();
    const provenanceKey = (from: number, id: number) => `${from}:${id}`;
    const recordProvenance = (from: number, id: number, prov: PacketProvenance) => {
      const key = provenanceKey(from, id);
      packetProvenance.delete(key); // refresh recency
      packetProvenance.set(key, prov);
      if (packetProvenance.size > PROVENANCE_MAX_ENTRIES) {
        const oldest = packetProvenance.keys().next().value;
        if (oldest !== undefined) {
          packetProvenance.delete(oldest);
        }
      }
    };
    const senderIdentityFor = (from: number, id: number): MeshtasticSenderIdentity => {
      const key = provenanceKey(from, id);
      const prov = packetProvenance.get(key);
      if (prov) {
        // Consume the entry: a grade is never re-read by a later packet that
        // recycles the same (from, id). One packet, one graded read.
        packetProvenance.delete(key);
      }
      if (!prov || !prov.pkiEncrypted) {
        // Channel-PSK or cleartext provenance (or the HTTP transport, whose
        // decryption path is not wired here): convenience-grade identity.
        return { grade: "psk-grade" };
      }
      if (!prov.publicKey || !prov.observation) {
        // A decoded pki_encrypted packet without sender-key provenance is
        // anomalous (firmware 2.5+ always stamps it after a PKI decrypt) —
        // surfaced as mismatch, never verified.
        return { grade: "mismatch", detail: "pki_encrypted packet without public-key provenance" };
      }
      return senderIdentityFromObservation(prov.observation);
    };

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
        if (
          message.senderIdentity?.grade === "mismatch" &&
          (account.config.pkiMismatch ?? "unverified") === "drop"
        ) {
          // Same policy gate as handleMeshtasticInbound, so no dispatch path —
          // including a custom onMessage consumer — can skip it.
          console.log(
            `[${account.accountId}] meshtastic: drop ${message.isGroup ? "group" : "DM"} sender ${message.senderId} ` +
              `(pki key mismatch: ${message.senderIdentity.detail ?? "key changed"}; pkiMismatch=drop)`,
          );
          return;
        }
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
            pkiEncrypted?: boolean;
            publicKey?: Uint8Array;
            payloadVariant: { case: string; value: unknown };
          }) => {
            opts.statusSink?.({
              lastEventAt: Date.now(),
              lastTransportActivityAt: Date.now(),
            });
            if (meshPacket.payloadVariant.case === "decoded") {
              // Issue #7: record provenance for the typed-event graders. The
              // library strips pki_encrypted/public_key from typed metadata,
              // but this raw event fires synchronously first (verified in
              // @meshtastic/core 2.6.7 handleMeshPacket), so grading at
              // onMessagePacket time is race-free. A PKI packet's key is
              // first-seen-pinned here too (firmware-vouched provenance).
              // Dropped encrypted+pki packets do NOT feed the keybook.
              const pkiEncrypted = meshPacket.pkiEncrypted === true;
              const publicKey = meshtasticKeyBytesToBase64(meshPacket.publicKey) ?? undefined;
              const observation =
                pkiEncrypted && publicKey
                  ? (observeNodeKey(account.accountId, meshPacket.from, publicKey, "pki-packet") ??
                    undefined)
                  : undefined;
              recordProvenance(meshPacket.from, meshPacket.id, {
                pkiEncrypted,
                publicKey,
                observation,
              });
              return;
            }
            if (meshPacket.payloadVariant.case !== "encrypted") {
              return;
            }
            if (meshPacket.pkiEncrypted) {
              // PKI-encrypted packets (per-node keys, firmware 2.5+) cannot be
              // decrypted with the channel PSK — and AES-CTR never throws on a
              // wrong key, so attempting it would "succeed" and garble the
              // payload into plausible-looking text carrying the real,
              // cleartext sender header. Fail closed instead: drop with a
              // distinct log line. Per-node PKI support is issue #7.
              logger.debug?.(
                `[${account.accountId}] dropping PKI-encrypted packet ${meshPacket.id}: per-node PKI unsupported on this path (issue #7)`,
              );
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
                  // Plugin-side channel-PSK decrypt: convenience-grade by
                  // construction, no matter what flags the packet carried.
                  senderIdentity: { grade: "psk-grade" },
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
              senderIdentity: senderIdentityFor(packet.from, packet.id),
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
      // Persist the node book now instead of losing up to one throttle window.
      flushNodeBookWrites();
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

    // Operator manual-verification marks (issue #7), applied AFTER the
    // connect replay so pins created by the replay are covered. Pins for
    // nodes first heard later are marked at the next start while listed.
    for (const entry of account.config.pkiManuallyVerified ?? []) {
      const num = parseMeshtasticNodeNum(String(entry));
      if (num === undefined) {
        logger.debug?.(
          `[${account.accountId}] pkiManuallyVerified entry ${JSON.stringify(entry)} is not a node id — ignored`,
        );
        continue;
      }
      if (markNodeKeyManuallyVerified(account.accountId, num)) {
        console.log(
          `[${account.accountId}] pki: key for ${formatMeshtasticNodeId(num)} marked manually verified (operator list)`,
        );
      }
    }

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
