import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { monitorMeshtasticProvider } from "./monitor.js";
import type { CoreConfig } from "./types.js";

const {
  connectMeshtasticDeviceMock,
  disconnectMeshtasticDeviceMock,
  resolveMeshtasticAccountMock,
  getMeshtasticRuntimeMock,
  childLoggerInfoMock,
  expandPskMock,
  decryptChannelPacketMock,
} = vi.hoisted(() => ({
  connectMeshtasticDeviceMock: vi.fn(),
  disconnectMeshtasticDeviceMock: vi.fn(),
  resolveMeshtasticAccountMock: vi.fn(),
  getMeshtasticRuntimeMock: vi.fn(),
  childLoggerInfoMock: vi.fn(),
  expandPskMock: vi.fn(),
  decryptChannelPacketMock: vi.fn(),
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
vi.mock("./crypto.js", () => ({
  expandPsk: expandPskMock,
  decryptChannelPacket: decryptChannelPacketMock,
}));

function createRuntime() {
  return {
    config: {
      current: () => ({ channels: { meshtastic: { host: "192.0.2.10" } } }),
    },
    logging: {
      getChildLogger: () => ({ info: childLoggerInfoMock, error: vi.fn(), debug: vi.fn() }),
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

type Subscriber = (...args: never[]) => void;

function createHandle() {
  // Capture every registered subscriber so tests can fire synthetic packets
  // through the real handler paths (the M1 coverage gap from review).
  const subs: Record<string, Subscriber[]> = {
    onChannelPacket: [],
    onMeshPacket: [],
    onMessagePacket: [],
    onDeviceStatus: [],
  };
  const subscribeFor = (name: keyof typeof subs) =>
    vi.fn((fn: Subscriber) => {
      subs[name].push(fn);
      return () => {};
    });
  const handle = {
    accountId: "default",
    myNodeNum: 123,
    configure: vi.fn().mockResolvedValue(undefined),
    device: {
      events: {
        onChannelPacket: { subscribe: subscribeFor("onChannelPacket") },
        onMeshPacket: { subscribe: subscribeFor("onMeshPacket") },
        onMessagePacket: { subscribe: subscribeFor("onMessagePacket") },
        onDeviceStatus: { subscribe: subscribeFor("onDeviceStatus") },
      },
    },
  };
  return { handle, subs };
}

describe("monitorMeshtasticProvider logging routes (fork#1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getMeshtasticRuntimeMock.mockReturnValue(createRuntime());
    resolveMeshtasticAccountMock.mockReturnValue(createResolvedAccount());
    expandPskMock.mockReturnValue(new Uint8Array(16).fill(7));
    decryptChannelPacketMock.mockReturnValue(new TextEncoder().encode("secret dm payload"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function startMonitor() {
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { handle, subs } = createHandle();
    connectMeshtasticDeviceMock.mockResolvedValue(handle);
    const abortController = new AbortController();
    const monitorPromise = monitorMeshtasticProvider({
      config: { channels: { meshtastic: { host: "192.0.2.10" } } } as CoreConfig,
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      abortSignal: abortController.signal,
    });
    // Let the async connect flow reach the settlement promise.
    await vi.waitFor(() => {
      expect(handle.configure).toHaveBeenCalled();
    });
    return { consoleLogSpy, subs, abortController, monitorPromise };
  }

  it("routes the connected line through console.log, not the child logger", async () => {
    const { consoleLogSpy, abortController, monitorPromise } = await startMonitor();

    await vi.waitFor(() => {
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining("connected to Meshtastic (tcp)"),
      );
    });
    // S4: no dual-logging through the child logger anywhere.
    expect(childLoggerInfoMock).not.toHaveBeenCalled();

    abortController.abort();
    await expect(monitorPromise).resolves.toEqual({ stop: expect.any(Function) });
  });

  it("routes plain inbound message lines through console.log (site :337)", async () => {
    const { consoleLogSpy, subs, abortController, monitorPromise } = await startMonitor();

    expect(subs.onMessagePacket).toHaveLength(1);
    subs.onMessagePacket[0]!({
      id: 7,
      rxTime: new Date(),
      type: "direct",
      from: 456,
      to: 123,
      channel: 0,
      data: "hello plain mesh",
    } as never);

    await vi.waitFor(() => {
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining("inbound dm from"),
      );
    });
    // Redaction default preserved: length marker, never the body.
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("(16 chars)"));
    expect(consoleLogSpy).not.toHaveBeenCalledWith(expect.stringContaining("hello plain mesh"));
    expect(childLoggerInfoMock).not.toHaveBeenCalled();

    abortController.abort();
    await expect(monitorPromise).resolves.toEqual({ stop: expect.any(Function) });
  });

  it("routes decrypted inbound message lines through console.log (site :259)", async () => {
    const { consoleLogSpy, subs, abortController, monitorPromise } = await startMonitor();

    // Populate the channel PSK first (onChannelPacket path).
    expect(subs.onChannelPacket).toHaveLength(1);
    subs.onChannelPacket[0]!({ index: 0, settings: { psk: new Uint8Array([1]) } } as never);

    expect(subs.onMeshPacket).toHaveLength(1);
    subs.onMeshPacket[0]!({
      id: 9,
      from: 456,
      to: 123,
      channel: 0,
      rxTime: 0,
      payloadVariant: { case: "encrypted", value: new Uint8Array([9, 9, 9]) },
    } as never);

    await vi.waitFor(() => {
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining("inbound (decrypted) dm from"),
      );
    });
    expect(consoleLogSpy).not.toHaveBeenCalledWith(expect.stringContaining("secret dm payload"));
    expect(childLoggerInfoMock).not.toHaveBeenCalled();

    abortController.abort();
    await expect(monitorPromise).resolves.toEqual({ stop: expect.any(Function) });
  });
});
