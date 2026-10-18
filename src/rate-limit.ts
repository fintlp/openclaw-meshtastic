/**
 * Outbound flood guard: caps how many airtime packets the agent may transmit
 * per rolling time window. LoRa airtime is a shared commons — a looping or
 * compromised session must not be able to monopolize the frequency.
 *
 * Counts packets (chunks), not messages: airtime cost is per frame on air.
 * The check happens before the first frame of a message is transmitted, so a
 * message is either sent whole or refused whole — never partially aired.
 *
 * Group channels carry a stricter budget than DMs: they are opt-in via
 * `groupTransmit` and heard by every node in range.
 */

export type SendRateLimitConfig = {
  enabled: boolean;
  /** Maximum DM packets per rolling window. */
  maxSends: number;
  /** Rolling window length in milliseconds. */
  windowMs: number;
  /** Maximum group-channel packets per rolling window (stricter). */
  groupMaxSends: number;
};

export const SEND_RATE_LIMIT_DEFAULTS: SendRateLimitConfig = {
  enabled: true,
  maxSends: 20,
  windowMs: 600_000,
  groupMaxSends: 3,
};

export function resolveSendRateLimitConfig(
  raw: Record<string, unknown> | undefined,
): SendRateLimitConfig {
  const limit = raw ?? {};
  return {
    enabled: typeof limit.enabled === "boolean" ? limit.enabled : SEND_RATE_LIMIT_DEFAULTS.enabled,
    maxSends:
      typeof limit.maxSends === "number" && Number.isInteger(limit.maxSends) && limit.maxSends >= 1
        ? limit.maxSends
        : SEND_RATE_LIMIT_DEFAULTS.maxSends,
    windowMs:
      typeof limit.windowMs === "number" && limit.windowMs >= 1_000
        ? limit.windowMs
        : SEND_RATE_LIMIT_DEFAULTS.windowMs,
    groupMaxSends:
      typeof limit.groupMaxSends === "number" &&
      Number.isInteger(limit.groupMaxSends) &&
      limit.groupMaxSends >= 1
        ? limit.groupMaxSends
        : SEND_RATE_LIMIT_DEFAULTS.groupMaxSends,
  };
}

export class SendRateLimitExceededError extends Error {
  readonly retryAfterMs: number;

  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.name = "SendRateLimitExceededError";
    this.retryAfterMs = retryAfterMs;
  }
}

/** Packet timestamps per account+class bucket, pruned to the window on each check. */
const buckets = new Map<string, number[]>();

/** Test hook: drop all recorded send activity. */
export function clearSendRateLimitState(accountId?: string): void {
  if (accountId === undefined) {
    buckets.clear();
    return;
  }
  for (const key of buckets.keys()) {
    if (key === accountId || key.startsWith(`${accountId}:`)) {
      buckets.delete(key);
    }
  }
}

export function assertSendRateLimit(params: {
  accountId: string;
  /** Number of airtime packets this message will occupy. */
  packets: number;
  config: SendRateLimitConfig;
  /** DM and group-channel sends draw from separate budgets. */
  kind?: "dm" | "group";
  nowMs?: number;
  /** Config path surface for error text, e.g. "channels.meshtastic.sendRateLimit". */
  configPath?: string;
}): void {
  const { config } = params;
  if (!config.enabled || params.packets <= 0) {
    return;
  }
  const kind = params.kind ?? "dm";
  const bucketKey = `${params.accountId}:${kind}`;
  const maxSends = kind === "group" ? config.groupMaxSends : config.maxSends;
  const now = params.nowMs ?? Date.now();
  const windowStart = now - config.windowMs;
  const recent = (buckets.get(bucketKey) ?? []).filter((t) => t > windowStart);
  buckets.set(bucketKey, recent);

  if (recent.length + params.packets > maxSends) {
    const oldest = recent[0] ?? now;
    const retryAfterMs = Math.max(1_000, oldest + config.windowMs - now);
    const windowMinutes = Math.round(config.windowMs / 60_000);
    throw new SendRateLimitExceededError(
      `Meshtastic send rate limit reached: ${recent.length} ${kind} packet(s) sent in the last ` +
        `${windowMinutes}m (limit ${maxSends}); this ${kind === "group" ? "group message" : "DM"} needs ` +
        `${params.packets} more. Retry in ~${Math.ceil(retryAfterMs / 1_000)}s, or tune ` +
        `${params.configPath ?? "channels.meshtastic.sendRateLimit"} (LoRa airtime rule).`,
      retryAfterMs,
    );
  }

  for (let i = 0; i < params.packets; i += 1) {
    recent.push(now);
  }
}
