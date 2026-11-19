import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { meshtasticPlugin } from "./channel.js";
import { clearOutboundEchoCache } from "./echo-dedupe.js";
import { clearSendRateLimitState } from "./rate-limit.js";
import {
  clearSessionSendRateLimitState,
  SessionSendRateLimitExceededError,
} from "./session-rate-limit.js";
import type { CoreConfig } from "./types.js";

const { connectMock, getMock } = vi.hoisted(() => ({ connectMock: vi.fn(), getMock: vi.fn() }));
vi.mock("./device-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./device-client.js")>();
  return { ...actual, connectMeshtasticDevice: connectMock, getMeshtasticDevice: getMock };
});

describe("meshtasticPlugin attachedResults sendText", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearOutboundEchoCache();
    clearSendRateLimitState();
    clearSessionSendRateLimitState();
  });
  afterEach(() => {
    clearOutboundEchoCache();
    clearSendRateLimitState();
    clearSessionSendRateLimitState();
    vi.restoreAllMocks();
  });

  it("forwards the producing session key to the low-level guard", async () => {
    const sendText = vi.fn(async () => 42);
    getMock.mockReturnValue({ accountId: "default", myNodeNum: 123, device: { sendText } });
    const cfg = {
      channels: {
        meshtastic: {
          host: "192.0.2.10",
          sessionSendRateLimit: { maxSends: 1, maxBytes: 100, groupMaxSends: 3 },
        },
      },
    } as CoreConfig;
    await meshtasticPlugin.outbound.sendText({
      cfg, to: "!00000002", text: "first", sessionKey: "agent:main:attached",
    } as never);
    await expect(meshtasticPlugin.outbound.sendText({
      cfg, to: "!00000002", text: "second", sessionKey: "agent:main:attached",
    } as never)).rejects.toBeInstanceOf(SessionSendRateLimitExceededError);
    expect(sendText).toHaveBeenCalledTimes(1);
  });
});
