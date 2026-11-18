/**
 * Pre-delivery, per-session outbound flood guard (#5).
 *
 * Buckets use only trusted channel+account+canonical session identity (plus
 * the host-target-derived DM/group class). Accepted payloads are charged
 * synchronously, making Promise.all-style concurrent bursts atomic in JS.
 * Refusals return cancel=true because the host fails open on thrown hooks.
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-entry-contract";
import { resolveMeshtasticAccount } from "./accounts.js";
import { isMeshtasticGroupTarget } from "./normalize.js";
import { chunkMeshtasticOutboundText } from "./send.js";
import type { CoreConfig } from "./types.js";

export type SessionSendRateLimitConfig = {
  enabled: boolean;
  maxSends: number;
  /** UTF-8 bytes of trimmed outbound text per session/class and window. */
  maxBytes: number;
  windowMs: number;
  /** Stricter session share of the independent three-packet account group budget. */
  groupMaxSends: number;
};

export const SESSION_SEND_RATE_LIMIT_DEFAULTS: SessionSendRateLimitConfig = {
  enabled: true,
  maxSends: 8,
  maxBytes: 768,
  windowMs: 600_000,
  groupMaxSends: 1,
};

export function resolveSessionSendRateLimitConfig(
  raw: Record<string, unknown> | undefined,
): SessionSendRateLimitConfig {
  const value = raw ?? {};
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : SESSION_SEND_RATE_LIMIT_DEFAULTS.enabled,
    maxSends: typeof value.maxSends === "number" && Number.isInteger(value.maxSends) && value.maxSends >= 1
      ? value.maxSends : SESSION_SEND_RATE_LIMIT_DEFAULTS.maxSends,
    maxBytes: typeof value.maxBytes === "number" && Number.isInteger(value.maxBytes) && value.maxBytes >= 1
      ? value.maxBytes : SESSION_SEND_RATE_LIMIT_DEFAULTS.maxBytes,
    windowMs: typeof value.windowMs === "number" && Number.isInteger(value.windowMs) && value.windowMs >= 1_000
      ? value.windowMs : SESSION_SEND_RATE_LIMIT_DEFAULTS.windowMs,
    groupMaxSends: typeof value.groupMaxSends === "number" && Number.isInteger(value.groupMaxSends) && value.groupMaxSends >= 1
      ? value.groupMaxSends : SESSION_SEND_RATE_LIMIT_DEFAULTS.groupMaxSends,
  };
}

type Usage = { at: number; packets: number; bytes: number };
type Bucket = { windowMs: number; events: Usage[] };
const buckets = new Map<string, Bucket>();
let lastSweepAt: number | undefined;

export function clearSessionSendRateLimitState(): void {
  buckets.clear();
  lastSweepAt = undefined;
}

function sweepStaleBuckets(now: number): void {
  if (lastSweepAt !== undefined && now >= lastSweepAt && now - lastSweepAt < 60_000) return;
  lastSweepAt = now;
  for (const [key, bucket] of buckets) {
    bucket.events = bucket.events.filter((event) => event.at > now - bucket.windowMs);
    if (bucket.events.length === 0) buckets.delete(key);
  }
}

export type SessionSendRateLimitDecision =
  | { allowed: true }
  | { allowed: false; retryAfterMs: number; cancelReason: string };

function retryDelay(
  events: Usage[],
  packets: number,
  bytes: number,
  packetCap: number,
  config: SessionSendRateLimitConfig,
  now: number,
): number {
  let usedPackets = events.reduce((sum, event) => sum + event.packets, 0);
  let usedBytes = events.reduce((sum, event) => sum + event.bytes, 0);
  for (let index = 0; index <= events.length; index += 1) {
    if (usedPackets + packets <= packetCap && usedBytes + bytes <= config.maxBytes) {
      return Math.max(1_000, (index === 0 ? now : events[index - 1]!.at + config.windowMs) - now);
    }
    const event = events[index];
    if (!event) break;
    usedPackets -= event.packets;
    usedBytes -= event.bytes;
  }
  const latest = events.at(-1)?.at ?? now;
  return Math.max(1_000, latest + config.windowMs - now);
}

export function consumeMeshtasticSessionSendRateLimit(params: {
  accountId: string;
  sessionKey: string;
  kind?: "dm" | "group";
  packets: number;
  bytes: number;
  config: SessionSendRateLimitConfig;
  nowMs?: number;
}): SessionSendRateLimitDecision {
  if (!params.config.enabled || (params.packets <= 0 && params.bytes <= 0)) return { allowed: true };
  const now = params.nowMs ?? Date.now();
  sweepStaleBuckets(now);
  const kind = params.kind ?? "dm";
  const key = JSON.stringify(["meshtastic", params.accountId, params.sessionKey, kind]);
  const events = (buckets.get(key)?.events ?? []).filter(
    (event) => event.at > now - params.config.windowMs,
  );
  const usedPackets = events.reduce((sum, event) => sum + event.packets, 0);
  const usedBytes = events.reduce((sum, event) => sum + event.bytes, 0);
  const packetCap = kind === "group" ? params.config.groupMaxSends : params.config.maxSends;
  const overPackets = usedPackets + params.packets > packetCap;
  const overBytes = usedBytes + params.bytes > params.config.maxBytes;
  if (overPackets || overBytes) {
    if (events.length === 0) buckets.delete(key);
    else buckets.set(key, { windowMs: params.config.windowMs, events });
    const retryAfterMs = retryDelay(events, params.packets, params.bytes, packetCap, params.config, now);
    const exceeded = [
      overPackets ? `${kind} estimated radio packets ${usedPackets}+${params.packets}/${packetCap}` : undefined,
      overBytes ? `${kind} UTF-8 text bytes ${usedBytes}+${params.bytes}/${params.config.maxBytes}` : undefined,
    ].filter(Boolean).join(", ");
    const oversized = params.packets > packetCap || params.bytes > params.config.maxBytes;
    return {
      allowed: false,
      retryAfterMs,
      cancelReason:
        `Meshtastic per-session flood guard refused the whole payload before any radio send: ` +
        `${exceeded} in the rolling ${Math.round(params.config.windowMs / 60_000)}m window. ` +
        `Retry in ~${Math.ceil(retryAfterMs / 1_000)}s (retryAfterMs=${retryAfterMs}). ` +
        (oversized
          ? "This payload alone exceeds the per-session budget; split it or tune channels.meshtastic.sessionSendRateLimit. "
          : "") +
        "Nothing was queued. The independent channels.meshtastic.sendRateLimit account guard remains active.",
    };
  }
  events.push({ at: now, packets: params.packets, bytes: params.bytes });
  buckets.set(key, { windowMs: params.config.windowMs, events });
  return { allowed: true };
}

export function registerMeshtasticSessionSendRateLimit(api: OpenClawPluginApi): void {
  // registerHook is the legacy bus and ignores typed message_sending hooks.
  api.on("message_sending", (event, ctx) => {
    if (ctx.channelId !== "meshtastic") return;
    const sessionKey = typeof ctx.sessionKey === "string" && ctx.sessionKey.length > 0
      ? ctx.sessionKey
      : undefined;
    if (!sessionKey) return; // Account-only for internal/no-session sends.
    const account = resolveMeshtasticAccount({
      cfg: api.config as CoreConfig,
      accountId: ctx.accountId,
    });
    const kind = isMeshtasticGroupTarget(event.to) ? "group" : "dm";
    const chunks = chunkMeshtasticOutboundText(event.content, account.config);
    const bytes = new TextEncoder().encode(event.content.trim()).length;
    const decision = consumeMeshtasticSessionSendRateLimit({
      accountId: account.accountId,
      sessionKey,
      kind,
      packets: chunks.length,
      bytes,
      config: resolveSessionSendRateLimitConfig(
        account.config.sessionSendRateLimit as Record<string, unknown> | undefined,
      ),
    });
    if (!decision.allowed) return { cancel: true, cancelReason: decision.cancelReason };
  });
}
