import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearOutboundEchoCache } from "./echo-dedupe.js";
import { monitorMeshtasticProvider } from "./monitor.js";
import { clearSendRateLimitState } from "./rate-limit.js";
import {
  clearSessionSendRateLimitState,
  SessionSendRateLimitExceededError,
} from "./session-rate-limit.js";
import type { CoreConfig, MeshtasticInboundMessage } from "./types.js";

const { connectMock, disconnectMock, resolveAccountMock, getRuntimeMock, hostOnErrorMock } = vi.hoisted(() => ({
  connectMock: vi.fn(), disconnectMock: vi.fn(), resolveAccountMock: vi.fn(),
  getRuntimeMock: vi.fn(), hostOnErrorMock: vi.fn(),
}));
vi.mock("./device-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./device-client.js")>();
  return { ...actual, connectMeshtasticDevice: connectMock, disconnectMeshtasticDevice: disconnectMock };
});
vi.mock("./accounts.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./accounts.js")>();
  return { ...actual, resolveMeshtasticAccount: resolveAccountMock };
});
vi.mock("./runtime.js", () => ({ getMeshtasticRuntime: getRuntimeMock }));
vi.mock("./inbound.js", () => ({
  handleMeshtasticInbound: vi.fn(async (params: {
    message: MeshtasticInboundMessage;
    sendReply: (target: string, text: string, replyToId?: string, sessionKey?: string) => Promise<void>;
  }) => {
    const target = params.message.senderId;
    await params.sendReply(target, "first", undefined, "agent:main:producer");
    try {
      await params.sendReply(target, "second", undefined, "agent:main:producer");
    } catch (error) {
      hostOnErrorMock(error);
    }
  }),
}));

type Subscriber = (...args: any[]) => void;
function handle() {
  const subs: Record<string, Subscriber[]> = {
    onChannelPacket: [], onMeshPacket: [], onMessagePacket: [], onDeviceStatus: [],
  };
  const subscribeFor = (name: keyof typeof subs) => vi.fn((fn: Subscriber) => {
    subs[name].push(fn);
    return () => {};
  });
  const sendText = vi.fn(async () => 42);
  return {
    accountId: "default", myNodeNum: 123,
    configure: vi.fn().mockResolvedValue(undefined),
    device: {
      sendText,
      events: {
        onChannelPacket: { subscribe: subscribeFor("onChannelPacket") },
        onMeshPacket: { subscribe: subscribeFor("onMeshPacket") },
        onMessagePacket: { subscribe: subscribeFor("onMessagePacket") },
        onDeviceStatus: { subscribe: subscribeFor("onDeviceStatus") },
      },
    },
  };
}

function runtime() {
  return {
    config: { current: () => ({ channels: { meshtastic: { host: "192.0.2.10" } } }) },
    logging: {
      getChildLogger: () => ({ info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
      shouldLogVerbose: () => false,
    },
    channel: { activity: { record: vi.fn() } },
  };
}

function account() {
  return {
    accountId: "default", enabled: true, configured: true, transport: "tcp" as const,
    host: "192.0.2.10", port: 4403, tls: false, serialPath: "", baudRate: 115200,
    config: {
      dmPolicy: "pairing", dmIdentity: "off", allowFrom: [],
      groupPolicy: "disabled", channels: [0], logInboundMessageContent: false,
      sessionSendRateLimit: { maxSends: 1, maxBytes: 100, groupMaxSends: 3 },
    },
  };
}

describe("Meshtastic production monitor producing-session replies", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearSessionSendRateLimitState();
    clearSendRateLimitState();
    clearOutboundEchoCache();
    getRuntimeMock.mockReturnValue(runtime());
    resolveAccountMock.mockReturnValue(account());
    disconnectMock.mockResolvedValue(undefined);
  });
  afterEach(() => {
    clearSessionSendRateLimitState();
    clearSendRateLimitState();
    clearOutboundEchoCache();
    vi.restoreAllMocks();
  });

  it("forwards the producing key and surfaces the typed refusal without a refusal timestamp", async () => {
    const device = handle();
    connectMock.mockResolvedValue(device);
    const abort = new AbortController();
    const statusPatches: Array<Record<string, unknown>> = [];
    vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const monitor = monitorMeshtasticProvider({
      config: { channels: { meshtastic: { host: "192.0.2.10" } } } as CoreConfig,
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      abortSignal: abort.signal,
      statusSink: (patch) => statusPatches.push(patch),
    });
    await vi.waitFor(() => expect(device.configure).toHaveBeenCalled());
    expect(device.device.events.onMessagePacket.subscribe).toHaveBeenCalledTimes(1);
    const onMessage = (device.device.events.onMessagePacket.subscribe.mock.calls[0]![0] as Subscriber);
    onMessage({
      id: 1, rxTime: new Date(), type: "direct", from: 2, to: 123, channel: 0, data: "hello",
    });
    await vi.waitFor(() => expect(hostOnErrorMock).toHaveBeenCalledTimes(1));
    const refusal = hostOnErrorMock.mock.calls[0]![0];
    expect(refusal).toBeInstanceOf(SessionSendRateLimitExceededError);
    expect((refusal as SessionSendRateLimitExceededError).retryAfterMs).toBeGreaterThan(0);
    expect(device.device.sendText).toHaveBeenCalledTimes(1);
    expect(statusPatches.filter((patch) => patch.lastOutboundAt !== undefined)).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain("retryAfterMs=");
    expect(warn.mock.calls[0]![0]).not.toContain("!00000002");
    expect(warn.mock.calls[0]![0]).not.toContain("agent:main:producer");
    expect(warn.mock.calls[0]![0]).not.toContain("second");
    abort.abort();
    await expect(monitor).resolves.toEqual({ stop: expect.any(Function) });
  });
});
