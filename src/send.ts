import {
  createMessageReceiptFromOutboundResults,
  type MessageReceipt,
} from "openclaw/plugin-sdk/channel-outbound";
import { requireRuntimeConfig } from "openclaw/plugin-sdk/plugin-config-runtime";
import { resolveMeshtasticAccount } from "./accounts.js";
import {
  connectMeshtasticDevice,
  getMeshtasticDevice,
  resolveChannelNumber,
  type MeshtasticDeviceHandle,
} from "./device-client.js";
import { rememberOutboundEcho } from "./echo-dedupe.js";
import {
  formatMeshtasticNodeId,
  isMeshtasticGroupTarget,
  isReservedMeshtasticBroadcastTarget,
  isValidMeshtasticNodeNum,
  MESHTASTIC_BROADCAST_NODE_NUM,
  normalizeMeshtasticMessagingTarget,
  parseMeshtasticChannelIndex,
  parseMeshtasticNodeNum,
} from "./normalize.js";
import { getMeshtasticRuntime } from "./runtime.js";
import { assertSendRateLimit, resolveSendRateLimitConfig } from "./rate-limit.js";
import type { CoreConfig } from "./types.js";

type SendMeshtasticOptions = {
  cfg: CoreConfig;
  accountId?: string;
  replyTo?: string;
  target?: string;
  deviceHandle?: MeshtasticDeviceHandle;
  ackWaitMs?: number;
};

type SendMeshtasticResult = {
  messageId: string;
  target: string;
  receipt: MessageReceipt;
};

/** Default chunk size in UTF-8 BYTES (was: code points before issue #17). */
const DEFAULT_CHUNK_LIMIT = 200;
const DEFAULT_SEND_ACK_WAIT_MS = 5_000;

type MeshtasticQueueSnapshotItem = {
  id: number;
  added?: Date;
};

type MeshtasticSendDevice = MeshtasticDeviceHandle["device"] & {
  queue?: {
    getState?: () => MeshtasticQueueSnapshotItem[];
  };
};

function recordMeshtasticOutboundActivity(accountId: string): void {
  try {
    getMeshtasticRuntime().channel.activity.record({
      channel: "meshtastic",
      accountId,
      direction: "outbound",
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "Meshtastic runtime not initialized") {
      throw error;
    }
  }
}

// --- Outbound text chunking (issue #17) -------------------------------------
//
// The radio limit is in BYTES: the Data payload is at most 233 bytes
// (DATA_PAYLOAD_LEN) and encrypted DMs lose another 12
// (MESHTASTIC_PKC_OVERHEAD), so 221. The firmware refuses oversized packets
// with Routing_Error.TOO_LARGE instead of truncating them, so every chunk
// must fit the byte cap — the old code-point split let non-ASCII replies
// produce packets the radio refused, silently dropping parts of the reply.

const encoder = new TextEncoder();
const utf8Bytes = (s: string): number => encoder.encode(s).length;

/** Hard payload cap for one text part: DATA_PAYLOAD_LEN(233) − PKC overhead(12). */
export const MESHTASTIC_TEXT_PAYLOAD_LIMIT = 221;

let clampWarned = false;

/**
 * Effective chunk limit in UTF-8 bytes. The schema still accepts 40..500 so
 * existing configs keep validating, but anything above the radio cap is
 * clamped (and logged once per process).
 */
export function resolveChunkLimitBytes(configured?: number): number {
  const requested = configured ?? DEFAULT_CHUNK_LIMIT;
  if (requested > MESHTASTIC_TEXT_PAYLOAD_LIMIT) {
    if (!clampWarned) {
      clampWarned = true;
      console.warn(
        "[meshtastic] textChunkLimit " +
          String(requested) +
          " exceeds the radio payload cap; clamping to " +
          String(MESHTASTIC_TEXT_PAYLOAD_LIMIT) +
          " bytes",
      );
    }
    return MESHTASTIC_TEXT_PAYLOAD_LIMIT;
  }
  return requested;
}

let cachedGraphemeSegmenter: Intl.Segmenter | undefined;
let segmenterFallbackWarned = false;

/**
 * Grapheme cluster segmenter, or undefined when the runtime has no
 * Intl.Segmenter — then the hard split falls back to code points (logged
 * once) instead of crashing. Availability is re-checked per call so tests
 * can stub it.
 */
function getGraphemeSegmenter(): Intl.Segmenter | undefined {
  if (typeof Intl === "undefined" || typeof Intl.Segmenter !== "function") {
    if (!segmenterFallbackWarned) {
      segmenterFallbackWarned = true;
      console.warn(
        "[meshtastic] Intl.Segmenter unavailable — chunk hard splits fall back to code points",
      );
    }
    return undefined;
  }
  cachedGraphemeSegmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
  return cachedGraphemeSegmenter;
}

/**
 * Chunk outbound text to a UTF-8 BYTE budget: whitespace boundaries
 * preferred, hard splits only at grapheme cluster boundaries (never inside a
 * combined character); a single grapheme larger than the limit falls back to
 * code points. Validated against the shared Unicode corpus for every limit
 * 40..221: no chunk over the limit, no content lost, no broken grapheme.
 */
export function chunkUtf8(text: string, limit: number): string[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }
  if (utf8Bytes(trimmed) <= limit) {
    return [trimmed];
  }
  const chunks: string[] = [];
  let current = "";
  let currentBytes = 0;
  const push = () => {
    const part = current.trim();
    if (part) {
      chunks.push(part);
    }
    current = "";
    currentBytes = 0;
  };
  const add = (unit: string, unitBytes: number) => {
    if (currentBytes > 0 && currentBytes + unitBytes > limit) {
      push();
    }
    current += unit;
    currentBytes += unitBytes;
  };
  const segmenter = getGraphemeSegmenter();
  for (const piece of trimmed.split(/(\s+)/)) {
    const pieceBytes = utf8Bytes(piece);
    if (pieceBytes <= limit) {
      add(piece, pieceBytes);
      continue;
    }
    if (segmenter) {
      for (const { segment } of segmenter.segment(piece)) {
        const segmentBytes = utf8Bytes(segment);
        if (segmentBytes <= limit) {
          add(segment, segmentBytes);
        } else {
          for (const codePoint of segment) {
            add(codePoint, utf8Bytes(codePoint));
          }
        }
      }
    } else {
      for (const codePoint of piece) {
        add(codePoint, utf8Bytes(codePoint));
      }
    }
  }
  push();
  return chunks;
}

function resolveTarget(to: string, opts?: SendMeshtasticOptions): string {
  const fromArg = normalizeMeshtasticMessagingTarget(to);
  if (fromArg) {
    return fromArg;
  }
  const fromOpt = normalizeMeshtasticMessagingTarget(opts?.target ?? "");
  if (fromOpt) {
    return fromOpt;
  }
  throw new Error(`Invalid Meshtastic target: ${to}`);
}

function resolveLatestQueuedPacketId(device: MeshtasticSendDevice): number | undefined {
  const state = device.queue?.getState?.();
  if (!state?.length) {
    return undefined;
  }
  return state.reduce((latest, item) => {
    const latestAt = latest.added?.getTime?.() ?? 0;
    const itemAt = item.added?.getTime?.() ?? 0;
    return itemAt >= latestAt ? item : latest;
  }).id;
}

function generateFallbackTimestampId(): number {
  // Keep ids positive and reasonably unique even when HTTP bridges never return ACK ids.
  return Date.now();
}

function parseReplyPacketId(replyTo?: string): number | undefined {
  if (!replyTo || !/^\d+$/.test(replyTo)) {
    return undefined;
  }
  const parsed = Number.parseInt(replyTo, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

// @meshtastic/core rejects a queued packet with a plain {id, error} object —
// never an Error — so a routing refusal (e.g. Routing_Error.TOO_LARGE for an
// oversized part) would escape upstream as an opaque object. Convert it into
// a named, visible failure instead (issue #17).
const ROUTING_ERROR_NAMES: Record<number, string> = {
  0: "NONE",
  1: "NO_ROUTE",
  2: "GOT_NAK",
  3: "TIMEOUT",
  4: "NO_INTERFACE",
  5: "MAX_RETRANSMIT",
  6: "NO_CHANNEL",
  7: "TOO_LARGE",
  8: "NO_RESPONSE",
  9: "DUTY_CYCLE_LIMIT",
  32: "BAD_REQUEST",
  33: "NOT_AUTHORIZED",
  34: "PKI_FAILED",
  35: "PKI_UNKNOWN_PUBKEY",
  36: "ADMIN_BAD_SESSION_KEY",
  37: "ADMIN_PUBLIC_KEY_UNAUTHORIZED",
};

function describeRoutingError(error: unknown): Error {
  if (error && typeof error === "object" && "error" in error) {
    const routing = error as { id?: unknown; error?: unknown };
    const code = typeof routing.error === "number" ? routing.error : -1;
    const name = ROUTING_ERROR_NAMES[code] ?? "code " + String(code);
    return new Error(
      "Meshtastic send refused by the radio: Routing_Error." +
        name +
        " (packet " +
        String(routing.id ?? "?") +
        ") — the part was not sent",
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}

async function waitForMeshtasticSend(params: {
  send: Promise<number>;
  device: MeshtasticSendDevice;
  timeoutMs?: number;
}): Promise<number> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const queuedPacketId = resolveLatestQueuedPacketId(params.device);

  try {
    return await Promise.race([
      params.send.catch((error: unknown) => {
        throw describeRoutingError(error);
      }),
      new Promise<number>((resolve) => {
        timer = setTimeout(() => {
          resolve(resolveLatestQueuedPacketId(params.device) ?? queuedPacketId ?? 0);
        }, params.timeoutMs ?? DEFAULT_SEND_ACK_WAIT_MS);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    params.send.catch(() => undefined);
  }
}

/** Exported for tests; production callers go through sendMessageMeshtastic. */
export async function sendTextWithoutBlockingForAck(params: {
  handle: MeshtasticDeviceHandle;
  text: string;
  destination: number | "broadcast";
  channel?: ReturnType<typeof resolveChannelNumber>;
  replyId?: number;
  ackWaitMs?: number;
}): Promise<number> {
  // Last-exit guard: a numeric destination must be a valid node number.
  // @meshtastic/core writes the destination verbatim into the 32-bit
  // MeshPacket.to field, so out-of-range values silently wrap (0x1FFFFFFFF
  // becomes the broadcast address). "broadcast" is the channel-scoped form
  // and stays gated upstream by groupTransmit.
  if (typeof params.destination === "number" && !isValidMeshtasticNodeNum(params.destination)) {
    throw new Error(
      `Meshtastic send refused at the device exit: destination ${params.destination} is not a valid node number (1-4294967294).`,
    );
  }
  rememberOutboundEcho(params.text);
  const send = params.handle.device.sendText(
    params.text,
    params.destination,
    true,
    params.channel,
    params.replyId,
  );
  return await waitForMeshtasticSend({
    send,
    device: params.handle.device as MeshtasticSendDevice,
    timeoutMs: params.ackWaitMs,
  });
}

export async function sendMessageMeshtastic(
  to: string,
  text: string,
  opts: SendMeshtasticOptions,
): Promise<SendMeshtasticResult> {
  const cfg = requireRuntimeConfig(opts.cfg, "Meshtastic send") as CoreConfig;
  const account = resolveMeshtasticAccount({
    cfg,
    accountId: opts.accountId,
  });

  if (!account.configured) {
    throw new Error(
      account.transport === "serial"
        ? `Meshtastic is not configured for account "${account.accountId}" (need serialPath in channels.meshtastic).`
        : `Meshtastic is not configured for account "${account.accountId}" (need host in channels.meshtastic).`,
    );
  }

  // Reserved broadcast addresses are refused unconditionally: the reserved
  // broadcast node number reaches every node in range regardless of channel
  // scoping, and no config flag (groupTransmit included) lifts this refusal
  // (LoRa airtime rule). The raw-input check runs first so broadcast aliases
  // like ^all get this clear reason instead of a generic invalid-target error.
  if (
    isReservedMeshtasticBroadcastTarget(to) ||
    isReservedMeshtasticBroadcastTarget(opts?.target ?? "")
  ) {
    throw new Error(
      `Meshtastic broadcast sends are refused: "${to}" resolves to the reserved broadcast address, which reaches every node in range (LoRa airtime rule). ` +
        "Direct node messages always work; channel sends require channels.meshtastic.groupTransmit=true.",
    );
  }
  const target = resolveTarget(to, opts);
  // Defense in depth: the normalized target must never be the reserved
  // broadcast node number either (all accepted forms are already refused
  // above; this pins the invariant at the boundary).
  if (parseMeshtasticNodeNum(target) === MESHTASTIC_BROADCAST_NODE_NUM) {
    throw new Error(
      `Meshtastic broadcast sends are refused: ${target} is the reserved broadcast address, which reaches every node in range (LoRa airtime rule). ` +
        "Direct node messages always work; channel sends require channels.meshtastic.groupTransmit=true.",
    );
  }
  if (isMeshtasticGroupTarget(target) && account.config.groupTransmit !== true) {
    throw new Error(
      `Meshtastic group sends are disabled by default: ${target} is receive-only (LoRa airtime rule). ` +
        "Set channels.meshtastic.groupTransmit=true to opt in to group transmission.",
    );
  }
  const chunks = chunkUtf8(text, resolveChunkLimitBytes(account.config.textChunkLimit));
  if (chunks.length === 0) {
    throw new Error("Message must be non-empty for Meshtastic sends");
  }

  // Flood guard: refuse the whole message (never partially aired) when the
  // account's rolling airtime budget is exhausted.
  assertSendRateLimit({
    accountId: account.accountId,
    packets: chunks.length,
    config: resolveSendRateLimitConfig(
      account.config.sendRateLimit as Record<string, unknown> | undefined,
    ),
    kind: isMeshtasticGroupTarget(target) ? "group" : "dm",
  });

  const handle =
    opts.deviceHandle ??
    getMeshtasticDevice(account.accountId) ??
    (await connectMeshtasticDevice({
      accountId: account.accountId,
      transport: account.transport,
      host: account.host,
      port: account.port,
      tls: account.tls,
      serialPath: account.serialPath,
      baudRate: account.baudRate,
    }));

  const parsedReplyId = parseReplyPacketId(opts.replyTo);

  let lastPacketId = 0;
  if (isMeshtasticGroupTarget(target)) {
    const channelIndex = parseMeshtasticChannelIndex(target) ?? 0;
    const channel = resolveChannelNumber(channelIndex);
    for (const chunk of chunks) {
      lastPacketId = await sendTextWithoutBlockingForAck({
        handle,
        text: chunk,
        destination: "broadcast",
        channel,
        replyId: parsedReplyId,
        ackWaitMs: opts.ackWaitMs,
      });
    }
  } else {
    const nodeNum = parseMeshtasticNodeNum(target);
    if (nodeNum === undefined || !isValidMeshtasticNodeNum(nodeNum)) {
      throw new Error(
        `Invalid Meshtastic node target: ${target} (valid node numbers are 1-4294967294; the reserved broadcast address and out-of-range values are refused — LoRa airtime rule)`,
      );
    }
    for (const chunk of chunks) {
      lastPacketId = await sendTextWithoutBlockingForAck({
        handle,
        text: chunk,
        destination: nodeNum,
        replyId: parsedReplyId,
        ackWaitMs: opts.ackWaitMs,
      });
    }
  }

  recordMeshtasticOutboundActivity(account.accountId);

  const messageId =
    lastPacketId > 0 ? String(lastPacketId) : `fallback:${generateFallbackTimestampId()}`;
  return {
    messageId,
    target,
    receipt: createMessageReceiptFromOutboundResults({
      results: [
        {
          channel: "meshtastic",
          messageId,
          conversationId: isMeshtasticGroupTarget(target)
            ? target
            : formatMeshtasticNodeId(parseMeshtasticNodeNum(target) ?? 0),
        },
      ],
      kind: "text",
      ...(opts.replyTo ? { replyToId: opts.replyTo } : {}),
    }),
  };
}
