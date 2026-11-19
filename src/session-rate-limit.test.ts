import { readFileSync } from "node:fs";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-entry-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import entry from "../index.js";
import { MeshtasticConfigSchema } from "./config-schema.js";
import { clearOutboundEchoCache } from "./echo-dedupe.js";
import { clearSendRateLimitState, SendRateLimitExceededError } from "./rate-limit.js";
import { chunkMeshtasticOutboundText, sendMessageMeshtastic } from "./send.js";
import {
  clearSessionSendRateLimitState,
  enforceMeshtasticSessionSendRateLimit,
  resolveSessionSendRateLimitConfig,
  SESSION_SEND_RATE_LIMIT_DEFAULTS,
  SessionSendRateLimitExceededError,
  sessionSendRateLimitBucketCountForTests,
} from "./session-rate-limit.js";
import type { CoreConfig } from "./types.js";

const { connectMock, getMock } = vi.hoisted(() => ({ connectMock: vi.fn(), getMock: vi.fn() }));
vi.mock("./device-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./device-client.js")>();
  return { ...actual, connectMeshtasticDevice: connectMock, getMeshtasticDevice: getMock };
});

function config(overrides: Record<string, unknown> = {}): CoreConfig {
  return {
    channels: {
      meshtastic: {
        host: "192.0.2.10",
        sessionSendRateLimit: { maxSends: 3, maxBytes: 10_000, groupMaxSends: 3 },
        ...overrides,
      },
    },
  } as CoreConfig;
}

function device(sendText: ReturnType<typeof vi.fn>, accountId = "default") {
  return { accountId, myNodeNum: 123, device: { sendText } };
}

async function attempt(params: {
  cfg: CoreConfig;
  handle: ReturnType<typeof device>;
  sessionKey?: string;
  accountId?: string;
  text?: string;
  target?: string;
}): Promise<unknown | null> {
  try {
    await sendMessageMeshtastic(params.target ?? "!00000002", params.text ?? "ok", {
      cfg: params.cfg,
      accountId: params.accountId,
      sessionKey: params.sessionKey,
      deviceHandle: params.handle as never,
      ackWaitMs: 10,
    });
    return null;
  } catch (error) {
    return error;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
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

describe("Meshtastic low-level per-session flood guard (#5)", () => {
  it("registers zero global message hooks and leaves Telegram preview/auto-reply behavior untouched", () => {
    const telegram = { allowProviderPreview: true };
    const on = vi.fn();
    const registerHook = vi.fn();
    const registerChannel = vi.fn();
    entry.register({
      config: { channels: { meshtastic: { host: "192.0.2.10" }, telegram } },
      registrationMode: "full",
      runtime: { channel: { activity: { record: vi.fn() } } }, on, registerHook, registerChannel,
    } as unknown as OpenClawPluginApi);
    expect(registerChannel).toHaveBeenCalledTimes(1);
    expect(on).not.toHaveBeenCalled();
    expect(registerHook).not.toHaveBeenCalled();
    expect(telegram).toEqual({ allowProviderPreview: true });
  });

  it("refuses a real same-session Promise.all burst before device I/O with typed errors and safe logs", async () => {
    const cfg = config();
    const sendText = vi.fn(async () => 42);
    const handle = device(sendText);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const results = await Promise.all(
      Array.from({ length: 5 }, () => attempt({ cfg, handle, sessionKey: "agent:main:producer" })),
    );
    expect(results.filter((result) => result === null)).toHaveLength(3);
    const errors = results.filter((result) => result instanceof SessionSendRateLimitExceededError);
    expect(errors).toHaveLength(2);
    for (const error of errors) expect(error).toBeInstanceOf(SendRateLimitExceededError);
    expect(sendText).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledTimes(2);
    for (const [line] of warn.mock.calls) {
      expect(line).not.toContain("agent:main:producer");
      expect(line).not.toContain("!00000002");
      expect(line).not.toContain("ok");
    }
  });

  it("refuses before connect when one payload exceeds the exact packet boundary", async () => {
    const cfg = config({ textChunkLimit: 40, sessionSendRateLimit: { maxSends: 1, maxBytes: 100, groupMaxSends: 3 } });
    getMock.mockReturnValue(undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const promise = sendMessageMeshtastic("!00000002", "x".repeat(41), { cfg, sessionKey: "s" });
    await expect(promise).rejects.toBeInstanceOf(SessionSendRateLimitExceededError);
    await expect(promise).rejects.toMatchObject({ retryAfterMs: 600_000 });
    await expect(promise).rejects.toThrow("waiting alone will not admit it");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("retryAfterMs=600000"));
    expect(connectMock).not.toHaveBeenCalled();
    expect(getMock).not.toHaveBeenCalled();
  });

  it("shares one producing budget across fanout A,B,C,A instead of deriving identity from targets", async () => {
    const cfg = config();
    const sendText = vi.fn(async () => 42);
    const handle = device(sendText);
    const results = [];
    for (const target of ["!0000000a", "!0000000b", "!0000000c", "!0000000a"]) {
      results.push(await attempt({ cfg, handle, target, sessionKey: "one-producing-session" }));
    }
    expect(results.slice(0, 3)).toEqual([null, null, null]);
    expect(results[3]).toBeInstanceOf(SessionSendRateLimitExceededError);
    expect(sendText).toHaveBeenCalledTimes(3);
  });

  it("isolates independent sessions and resolved accounts", async () => {
    const cfg = config({
      defaultAccount: "a",
      accounts: { a: { host: "192.0.2.11" }, b: { host: "192.0.2.12" } },
      sessionSendRateLimit: { maxSends: 1, maxBytes: 100, groupMaxSends: 3 },
    });
    const sendText = vi.fn(async () => 42);
    const a = device(sendText, "a");
    const b = device(sendText, "b");
    expect(await attempt({ cfg, handle: a, accountId: "a", sessionKey: "s:a" })).toBeNull();
    expect(await attempt({ cfg, handle: a, accountId: "a", sessionKey: "s:a" })).toBeInstanceOf(SessionSendRateLimitExceededError);
    expect(await attempt({ cfg, handle: a, accountId: "a", sessionKey: "s:b" })).toBeNull();
    expect(await attempt({ cfg, handle: b, accountId: "b", sessionKey: "s:a" })).toBeNull();
  });

  it("keeps the old aggregate account backstop across independent sessions", async () => {
    const cfg = config({ sendRateLimit: { maxSends: 3 }, sessionSendRateLimit: { maxSends: 2, maxBytes: 100, groupMaxSends: 3 } });
    const sendText = vi.fn(async () => 42);
    const handle = device(sendText);
    const results = await Promise.all(
      ["a", "b", "c"].flatMap((sessionKey) => [0, 1].map(() => attempt({ cfg, handle, sessionKey }))),
    );
    expect(results.filter((result) => result === null)).toHaveLength(3);
    const errors = results.filter((result) => result instanceof SendRateLimitExceededError);
    expect(errors).toHaveLength(3);
    expect(errors.every((error) => !(error instanceof SessionSendRateLimitExceededError))).toBe(true);
    expect(sendText).toHaveBeenCalledTimes(3);
  });

  it("keeps missing/empty keys account-only", async () => {
    const cfg = config({ sessionSendRateLimit: { maxSends: 1, maxBytes: 100, groupMaxSends: 3 } });
    const sendText = vi.fn(async () => 42);
    const handle = device(sendText);
    expect(await attempt({ cfg, handle })).toBeNull();
    expect(await attempt({ cfg, handle, sessionKey: "" })).toBeNull();
    expect(await attempt({ cfg, handle, sessionKey: "   " })).toBeNull();
    expect(await attempt({ cfg, handle })).toBeNull();
    expect(sendText).toHaveBeenCalledTimes(4);
  });

  it("disabled semantics affect only the session layer", async () => {
    const cfg = config({
      sendRateLimit: { maxSends: 1 },
      sessionSendRateLimit: { enabled: false, maxSends: 1, maxBytes: 100, groupMaxSends: 3 },
    });
    const sendText = vi.fn(async () => 42);
    const handle = device(sendText);
    expect(await attempt({ cfg, handle, sessionKey: "s" })).toBeNull();
    const error = await attempt({ cfg, handle, sessionKey: "s" });
    expect(error).toBeInstanceOf(SendRateLimitExceededError);
    expect(error).not.toBeInstanceOf(SessionSendRateLimitExceededError);
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it("classifies normalized prefixed group aliases and keeps DM/group buckets separate", async () => {
    const cfg = config({
      groupTransmit: true,
      sessionSendRateLimit: { maxSends: 1, maxBytes: 100, groupMaxSends: 1 },
    });
    const sendText = vi.fn(async () => 42);
    const handle = device(sendText);
    expect(await attempt({ cfg, handle, target: "meshtastic: channel:0", sessionKey: "shared" })).toBeNull();
    expect(await attempt({ cfg, handle, target: "meshtastic: channel:0", sessionKey: "shared" })).toBeInstanceOf(SessionSendRateLimitExceededError);
    expect(await attempt({ cfg, handle, target: "!00000002", sessionKey: "shared" })).toBeNull();
    expect(sendText).toHaveBeenCalledTimes(2);
  });

  it("allows an ordinary two-packet group reply under the validated defaults", async () => {
    const cfg = config({ groupTransmit: true, textChunkLimit: 40 });
    const text = "😀".repeat(11);
    expect(chunkMeshtasticOutboundText(text, { textChunkLimit: 40 })).toHaveLength(2);
    const sendText = vi.fn(async () => 42);
    expect(await attempt({ cfg, handle: device(sendText), target: "channel:0", text, sessionKey: "group" })).toBeNull();
    expect(sendText).toHaveBeenCalledTimes(2);
  });

  it("uses distinct DM and group caps and enforces session-before-account ordering", async () => {
    const cfg = config({
      groupTransmit: true,
      sendRateLimit: { maxSends: 1, groupMaxSends: 3 },
      sessionSendRateLimit: { maxSends: 1, maxBytes: 100, groupMaxSends: 2 },
    });
    const sendText = vi.fn(async () => 42);
    const handle = device(sendText);
    expect(await attempt({ cfg, handle, target: "channel:0", sessionKey: "caps" })).toBeNull();
    expect(await attempt({ cfg, handle, target: "channel:0", sessionKey: "caps" })).toBeNull();
    expect(await attempt({ cfg, handle, target: "!00000002", sessionKey: "caps" })).toBeNull();
    const groupError = await attempt({ cfg, handle, target: "channel:0", sessionKey: "caps" });
    expect(groupError).toBeInstanceOf(SessionSendRateLimitExceededError);
    const dmError = await attempt({ cfg, handle, target: "!00000002", sessionKey: "caps" });
    // Session 1+1 exceeds the per-session DM cap before the account DM cap.
    expect(dmError).toBeInstanceOf(SessionSendRateLimitExceededError);
    expect((dmError as Error).name).toBe("SessionSendRateLimitExceededError");
    expect(dmError).toBeInstanceOf(SendRateLimitExceededError);
    expect(sendText).toHaveBeenCalledTimes(3);
  });

  it("computes retryAfter from expiring events and does not charge refusals", () => {
    const cfg = resolveSessionSendRateLimitConfig({ maxSends: 2, maxBytes: 100, windowMs: 5_000 });
    const base = { accountId: "default", sessionKey: "s", packets: 1, bytes: 1, config: cfg };
    enforceMeshtasticSessionSendRateLimit({ ...base, nowMs: 0 });
    enforceMeshtasticSessionSendRateLimit({ ...base, nowMs: 1_000 });
    let error: unknown;
    try { enforceMeshtasticSessionSendRateLimit({ ...base, nowMs: 2_000 }); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(SessionSendRateLimitExceededError);
    expect((error as SessionSendRateLimitExceededError).retryAfterMs).toBe(3_000);
    expect(() => enforceMeshtasticSessionSendRateLimit({ ...base, nowMs: 5_000 })).not.toThrow();
    expect(() => enforceMeshtasticSessionSendRateLimit({ ...base, nowMs: 6_000 })).not.toThrow();
  });

  it("cleans stale buckets during the periodic sweep", () => {
    const cfg = resolveSessionSendRateLimitConfig({ windowMs: 1_000 });
    enforceMeshtasticSessionSendRateLimit({ accountId: "a", sessionKey: "old", packets: 1, bytes: 1, config: cfg, nowMs: 0 });
    expect(sessionSendRateLimitBucketCountForTests()).toBe(1);
    enforceMeshtasticSessionSendRateLimit({ accountId: "a", sessionKey: "new", packets: 1, bytes: 1, config: cfg, nowMs: 60_000 });
    expect(sessionSendRateLimitBucketCountForTests()).toBe(1);
  });

  it("uses trimmed UTF-8 bytes for the independent byte budget", async () => {
    const cfg = config({ sessionSendRateLimit: { maxSends: 20, maxBytes: 4, groupMaxSends: 3 } });
    const sendText = vi.fn(async () => 42);
    const handle = device(sendText);
    expect(await attempt({ cfg, handle, text: "  éé  ", sessionKey: "bytes" })).toBeNull();
    const error = await attempt({ cfg, handle, text: "a", sessionKey: "bytes" });
    expect(error).toBeInstanceOf(SessionSendRateLimitExceededError);
    expect(String(error)).toContain("dm UTF-8 bytes 4+1/4");
    expect(sendText).toHaveBeenCalledWith("éé", 2, true, undefined, undefined);
  });

  it("pins secure runtime, zod, and generated-manifest defaults", () => {
    expect(SESSION_SEND_RATE_LIMIT_DEFAULTS).toEqual({ enabled: true, maxSends: 10, maxBytes: 2_210, windowMs: 600_000, groupMaxSends: 3 });
    expect(resolveSessionSendRateLimitConfig(undefined)).toEqual(SESSION_SEND_RATE_LIMIT_DEFAULTS);
    expect(MeshtasticConfigSchema.parse({}).sessionSendRateLimit).toEqual(SESSION_SEND_RATE_LIMIT_DEFAULTS);
    expect(MeshtasticConfigSchema.safeParse({ sessionSendRateLimit: { groupMaxSends: 0 } }).success).toBe(false);
    const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
    const surface = manifest.channelConfigs.meshtastic;
    expect(surface.schema.properties.sessionSendRateLimit.default).toEqual(SESSION_SEND_RATE_LIMIT_DEFAULTS);
    expect(surface.schema.properties.accounts.additionalProperties.properties.sessionSendRateLimit.default).toBeUndefined();
    expect(surface.uiHints.sessionSendRateLimit.help).toContain("10");
  });
});
