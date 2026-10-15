import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { monitorMeshtasticProvider } from "./monitor.js";
import type { CoreConfig } from "./types.js";

const {
  connectMeshtasticDeviceMock,
  disconnectMeshtasticDeviceMock,
  resolveMeshtasticAccountMock,
  getMeshtasticRuntimeMock,
} = vi.hoisted(() => ({
  connectMeshtasticDeviceMock: vi.fn(),
  disconnectMeshtasticDeviceMock: vi.fn(),
  resolveMeshtasticAccountMock: vi.fn(),
  getMeshtasticRuntimeMock: vi.fn(),
}));

vi.mock("./accounts.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./accounts.js")>();
  return { ...actual, resolveMeshtasticAccount: resolveMeshtasticAccountMock };
});

vi.mock("./device-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./device-client.js")>();
  return {
    ...actual,
    connectMeshtasticDevice: connectMeshtasticDeviceMock,
    disconnectMeshtasticDevice: disconnectMeshtasticDeviceMock,
  };
});

vi.mock("./runtime.js", () => ({ getMeshtasticRuntime: getMeshtasticRuntimeMock }));
vi.mock("./inbound.js", () => ({ handleMeshtasticInbound: vi.fn() }));

function createRuntime() {
  return {
    config: {
      current: () => ({ channels: { meshtastic: { host: "192.0.2.10" } } }),
    },
    logging: {
      getChildLogger: () => ({ info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
      shouldLogVerbose: () => false,
    },
    channel: { activity: { record: vi.fn() } },
  };
}

function createResolvedAccount() {
  return {
    accountId: "default",
    enabled: true,
    configured: true,
    transport: "tcp" as const,
    host: "192.0.2.10",
    port: 4403,
    config: {
      dmPolicy: "pairing",
      allowFrom: [],
      groupPolicy: "disabled",
      channels: [0],
      logInboundMessageContent: false,
    },
  };
}

function createHandle() {
  return {
    accountId: "default",
    myNodeNum: 123,
    configure: vi.fn().mockResolvedValue(undefined),
    device: {
      events: {
        onChannelPacket: { subscribe: vi.fn(() => () => {}) },
        onMeshPacket: { subscribe: vi.fn(() => () => {}) },
        onMessagePacket: { subscribe: vi.fn(() => () => {}) },
        onDeviceStatus: { subscribe: vi.fn(() => () => {}) },
      },
    },
  };
}

describe("monitorMeshtasticProvider logging routes (fork#1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getMeshtasticRuntimeMock.mockReturnValue(createRuntime());
    resolveMeshtasticAccountMock.mockReturnValue(createResolvedAccount());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("routes the connected line through console.log, not the child logger", async () => {
    // The whole premise of fork#1: a revert to logger.info leaves the console
    // spy silent and this test fails red (child-logger info lines never reach
    // gateway.log, verified live on this channel).
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    connectMeshtasticDeviceMock.mockResolvedValue(createHandle());

    const abortController = new AbortController();
    const monitorPromise = monitorMeshtasticProvider({
      config: { channels: { meshtastic: { host: "192.0.2.10" } } } as CoreConfig,
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      abortSignal: abortController.signal,
    });

    await vi.waitFor(() => {
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining("connected to Meshtastic (tcp)"),
      );
    });

    abortController.abort();
    await expect(monitorPromise).resolves.toEqual({ stop: expect.any(Function) });
  });
});
