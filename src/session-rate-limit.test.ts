import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-entry-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import entry from "../index.js";
import { MeshtasticConfigSchema } from "./config-schema.js";
import { clearOutboundEchoCache } from "./echo-dedupe.js";
import { clearSendRateLimitState } from "./rate-limit.js";
import { chunkMeshtasticOutboundText, sendMessageMeshtastic } from "./send.js";
import {
  clearSessionSendRateLimitState,
  consumeMeshtasticSessionSendRateLimit,
  registerMeshtasticSessionSendRateLimit,
  resolveSessionSendRateLimitConfig,
} from "./session-rate-limit.js";
import type { CoreConfig } from "./types.js";

type HookResult = { cancel?: boolean; cancelReason?: string } | void;
type Hook = (
  event: { to: string; content: string },
  ctx: { channelId: string; accountId?: string; sessionKey?: string },
) => HookResult;

function config(overrides: Record<string, unknown> = {}): CoreConfig {
  return {
    channels: {
      meshtastic: {
        host: "192.0.2.10",
        sessionSendRateLimit: { maxSends: 3, maxBytes: 10_000, groupMaxSends: 1 },
        ...overrides,
      },
    },
  } as CoreConfig;
}

function captureHook(cfg: CoreConfig, useEntry = false): { hook: Hook; legacy: ReturnType<typeof vi.fn> } {
  let hook: Hook | undefined;
  const legacy = vi.fn();
  const api = {
    config: cfg,
    registrationMode: "tool-discovery",
    on: vi.fn((name: string, handler: Hook) => {
      if (name === "message_sending") hook = handler;
    }),
    registerHook: legacy,
  } as unknown as OpenClawPluginApi;
  if (useEntry) entry.register(api);
  else registerMeshtasticSessionSendRateLimit(api);
  if (!hook) throw new Error("message_sending hook was not registered");
  return { hook, legacy };
}

function device(sendText: ReturnType<typeof vi.fn>, accountId = "default") {
  return { accountId, myNodeNum: 123, device: { sendText } };
}

async function attempt(params: {
  hook: Hook;
  cfg: CoreConfig;
  handle: ReturnType<typeof device>;
  sessionKey?: string;
  accountId?: string;
  text?: string;
  target?: string;
}) {
  const target = params.target ?? "!00000002";
  const decision = params.hook(
    { to: target, content: params.text ?? "ok" },
    { channelId: "meshtastic", accountId: params.accountId, sessionKey: params.sessionKey },
  );
  if (decision?.cancel) return { status: "cancelled" as const, reason: decision.cancelReason };
  try {
    await sendMessageMeshtastic(target, params.text ?? "ok", {
      cfg: params.cfg,
      accountId: params.accountId,
      deviceHandle: params.handle as never,
      ackWaitMs: 10,
    });
    return { status: "sent" as const };
  } catch (error) {
    return { status: "account-refused" as const, error };
  }
}

beforeEach(() => {
  clearSessionSendRateLimitState();
  clearSendRateLimitState();
  clearOutboundEchoCache();
});
afterEach(() => {
  clearSessionSendRateLimitState();
  clearSendRateLimitState();
  clearOutboundEchoCache();
  vi.restoreAllMocks();
});

describe("Meshtastic per-session outbound flood guard (#5)", () => {
  it("validates secure defaults and rejects invalid session knobs", () => {
    const parsed = MeshtasticConfigSchema.parse({ sessionSendRateLimit: { maxSends: 2 } });
    expect(parsed.sessionSendRateLimit).toEqual({ enabled: true, maxSends: 2, maxBytes: 768, windowMs: 600_000, groupMaxSends: 1 });
    expect(MeshtasticConfigSchema.safeParse({ sessionSendRateLimit: { groupMaxSends: 0 } }).success).toBe(false);
    expect(MeshtasticConfigSchema.safeParse({ sessionSendRateLimit: { unexpected: true } }).success).toBe(false);
  });

  it("registers through the real bundled entry via api.on, never legacy registerHook", () => {
    const { legacy } = captureHook(config(), true);
    expect(legacy).not.toHaveBeenCalled();
  });

  it("atomically refuses a same-session concurrent burst before device sends", async () => {
    const cfg = config();
    const { hook } = captureHook(cfg);
    const sendText = vi.fn(async () => 42);
    const handle = device(sendText);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => attempt({ hook, cfg, handle, sessionKey: "agent:main:test" })),
    );
    expect(results.filter((r) => r.status === "sent")).toHaveLength(3);
    const refused = results.filter((r) => r.status === "cancelled");
    expect(refused).toHaveLength(2);
    expect(refused[0]?.reason).toContain("retryAfterMs=");
    expect(refused[0]?.reason).toContain("Nothing was queued");
    expect(sendText).toHaveBeenCalledTimes(3);
  });

  it("isolates independent sessions and accounts using trusted context only", () => {
    const cfg = config({
      defaultAccount: "a",
      accounts: { a: { host: "192.0.2.11" }, b: { host: "192.0.2.12" } },
      sessionSendRateLimit: { maxSends: 1, maxBytes: 100, groupMaxSends: 1 },
    });
    const { hook } = captureHook(cfg);
    const send = (sessionKey: string, accountId = "a", channelId = "meshtastic") =>
      hook({ to: "!00000002", content: "x" }, { channelId, accountId, sessionKey });
    expect(send("session:a")?.cancel).toBeUndefined();
    expect(send("session:a")?.cancel).toBe(true);
    expect(send("session:b")?.cancel).toBeUndefined();
    expect(send("session:a", "b")?.cancel).toBeUndefined();
    expect(send("session:a", "a", "other-channel")?.cancel).toBeUndefined();
  });

  it("keeps the account aggregate backstop bounding a multi-session flood", async () => {
    const cfg = config({
      sendRateLimit: { maxSends: 3 },
      sessionSendRateLimit: { maxSends: 2, maxBytes: 100, groupMaxSends: 1 },
    });
    const { hook } = captureHook(cfg);
    const sendText = vi.fn(async () => 42);
    const handle = device(sendText);
    const results = await Promise.all(
      ["a", "b", "c"].flatMap((sessionKey) =>
        [0, 1].map(() => attempt({ hook, cfg, handle, sessionKey })),
      ),
    );
    expect(results.filter((r) => r.status === "sent")).toHaveLength(3);
    expect(results.filter((r) => r.status === "account-refused")).toHaveLength(3);
    expect(results.filter((r) => r.status === "cancelled")).toHaveLength(0);
    expect(sendText).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["missing sessionKey", undefined, { maxSends: 1, maxBytes: 100, groupMaxSends: 1 }],
    ["explicitly disabled session guard", "session:a", { enabled: false, maxSends: 1, maxBytes: 100, groupMaxSends: 1 }],
  ])("%s leaves the old account guard active", async (_name, sessionKey, sessionConfig) => {
    const cfg = config({ sendRateLimit: { maxSends: 1 }, sessionSendRateLimit: sessionConfig });
    const { hook } = captureHook(cfg);
    const sendText = vi.fn(async () => 42);
    const handle = device(sendText);
    const first = await attempt({ hook, cfg, handle, sessionKey });
    const second = await attempt({ hook, cfg, handle, sessionKey });
    expect(first.status).toBe("sent");
    expect(second.status).toBe("account-refused");
    expect(String((second as { error?: unknown }).error)).toContain("rate limit");
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it("slides the window and returns retryAfterMs/cancelReason without charging refusals", () => {
    const cfg = resolveSessionSendRateLimitConfig({ maxSends: 2, maxBytes: 100, windowMs: 1_000 });
    const base = { accountId: "default", sessionKey: "s", packets: 1, bytes: 1, config: cfg };
    expect(consumeMeshtasticSessionSendRateLimit({ ...base, nowMs: 0 }).allowed).toBe(true);
    expect(consumeMeshtasticSessionSendRateLimit({ ...base, nowMs: 100 }).allowed).toBe(true);
    const refused = consumeMeshtasticSessionSendRateLimit({ ...base, nowMs: 200 });
    expect(refused).toMatchObject({ allowed: false, retryAfterMs: 1_000 });
    if (!refused.allowed) expect(refused.cancelReason).toContain("Retry in ~1s");
    expect(consumeMeshtasticSessionSendRateLimit({ ...base, nowMs: 1_000 }).allowed).toBe(true);
    expect(consumeMeshtasticSessionSendRateLimit({ ...base, nowMs: 1_001 }).allowed).toBe(false);
    expect(consumeMeshtasticSessionSendRateLimit({ ...base, nowMs: 1_100 }).allowed).toBe(true);
  });

  it("uses real UTF-8 chunking for non-ASCII packets and a distinct UTF-8 byte budget", () => {
    const cfg = config({
      textChunkLimit: 40,
      sessionSendRateLimit: { maxSends: 2, maxBytes: 1_000, groupMaxSends: 1 },
    });
    const { hook } = captureHook(cfg);
    const text = "😀".repeat(11);
    expect(chunkMeshtasticOutboundText(text, { textChunkLimit: 40 })).toHaveLength(2);
    expect(hook({ to: "!00000002", content: text }, { channelId: "meshtastic", sessionKey: "unicode" })?.cancel).toBeUndefined();
    expect(hook({ to: "!00000002", content: "x" }, { channelId: "meshtastic", sessionKey: "unicode" })?.cancel).toBe(true);

    const byteCfg = resolveSessionSendRateLimitConfig({ maxSends: 20, maxBytes: 4 });
    const base = { accountId: "default", sessionKey: "bytes", packets: 1, config: byteCfg };
    expect(consumeMeshtasticSessionSendRateLimit({ ...base, bytes: new TextEncoder().encode("éé").length }).allowed).toBe(true);
    const byteRefusal = consumeMeshtasticSessionSendRateLimit({ ...base, bytes: 1 });
    expect(byteRefusal).toMatchObject({ allowed: false });
    if (!byteRefusal.allowed) expect(byteRefusal.cancelReason).toContain("dm UTF-8 text bytes 4+1/4");
  });

  it("preserves opted-in group sends while reserving account group capacity across sessions", async () => {
    const cfg = config({
      groupTransmit: true,
      sendRateLimit: { maxSends: 20, groupMaxSends: 3 },
      sessionSendRateLimit: { maxSends: 8, maxBytes: 100, groupMaxSends: 1 },
    });
    const { hook } = captureHook(cfg);
    const sendText = vi.fn(async () => 42);
    const handle = device(sendText);
    const first = await attempt({ hook, cfg, handle, sessionKey: "group:a", target: "channel:0" });
    const sameSession = await attempt({ hook, cfg, handle, sessionKey: "group:a", target: "channel:0" });
    const otherSession = await attempt({ hook, cfg, handle, sessionKey: "group:b", target: "channel:0" });
    expect(first.status).toBe("sent");
    expect(sameSession.status).toBe("cancelled");
    expect(otherSession.status).toBe("sent");
    expect(sendText).toHaveBeenCalledTimes(2);
  });
});
