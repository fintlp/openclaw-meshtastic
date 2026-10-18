import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Types } from "@meshtastic/core";
import { monitorMeshtasticProvider } from "./monitor.js";
import type { CoreConfig } from "./types.js";

// Lifecycle tests for the meshcore#4 port: a mid-session device disconnect
// must REJECT the monitor promise so the gateway health-monitor restarts the
// channel. A promise that stays pending leaves the channel dark indefinitely.

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
vi.mock("./crypto.js", () => ({
  expandPsk: vi.fn(),
  decryptChannelPacket: vi.fn(),
}));

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

type Subscriber = (...args: never[]) => void;

function createHandle() {
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

/** Resolves to "resolved", "rejected:<message>", or "pending" after `ms`. */
function outcomeOf(promise: Promise<unknown>, ms = 500): Promise<string> {
  return Promise.race([
    promise.then(
      () => "resolved",
      (err) => `rejected:${(err as Error).message}`,
    ),
    new Promise<string>((resolve) => setTimeout(() => resolve("pending"), ms)),
  ]);
}

describe("monitorMeshtasticProvider lifecycle (meshcore#4 port)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getMeshtasticRuntimeMock.mockReturnValue(createRuntime());
    resolveMeshtasticAccountMock.mockReturnValue(createResolvedAccount());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function startMonitor() {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { handle, subs } = createHandle();
    connectMeshtasticDeviceMock.mockResolvedValue(handle);
    const abortController = new AbortController();
    const statusPatches: Array<Record<string, unknown>> = [];
    const monitorPromise = monitorMeshtasticProvider({
      config: { channels: { meshtastic: { host: "192.0.2.10" } } } as CoreConfig,
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      abortSignal: abortController.signal,
      statusSink: (patch) => statusPatches.push(patch),
    });
    await vi.waitFor(() => {
      expect(handle.configure).toHaveBeenCalled();
    });
    return { subs, abortController, monitorPromise, statusPatches };
  }

  it("rejects the monitor promise on a mid-session device disconnect", async () => {
    const { subs, monitorPromise, statusPatches } = await startMonitor();
    const outcome = outcomeOf(monitorPromise);

    expect(subs.onDeviceStatus).toHaveLength(1);
    subs.onDeviceStatus[0]!(Types.DeviceStatusEnum.DeviceDisconnected as never);

    expect(await outcome).toMatch(/^rejected:Meshtastic device disconnected/);
    expect(disconnectMeshtasticDeviceMock).toHaveBeenCalledWith("default");
    expect(statusPatches).toContainEqual(expect.objectContaining({ connected: false }));
  });

  it("does not reject on a connect/status-changed event", async () => {
    const { subs, abortController, monitorPromise } = await startMonitor();
    const outcome = outcomeOf(monitorPromise, 200);

    subs.onDeviceStatus[0]!(Types.DeviceStatusEnum.DeviceConnected as never);
    expect(await outcome).toBe("pending");

    abortController.abort();
    await expect(monitorPromise).resolves.toEqual({ stop: expect.any(Function) });
  });

  it("abort after a mid-session rejection is a no-op (no resolve-after-reject)", async () => {
    const { subs, abortController, monitorPromise } = await startMonitor();
    const outcome = outcomeOf(monitorPromise);

    subs.onDeviceStatus[0]!(Types.DeviceStatusEnum.DeviceDisconnected as never);
    expect(await outcome).toMatch(/^rejected:/);

    // Late abort must not throw or change the settled state.
    abortController.abort();
    await expect(outcomeOf(monitorPromise, 100)).resolves.toMatch(/^rejected:/);
  });

  it("disconnect during startup (before settlement) rejects immediately", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { handle, subs } = createHandle();
    // Fire the disconnect synchronously out of configure() — the device drops
    // between configure and the settlement promise's construction.
    handle.configure.mockImplementation(async () => {
      subs.onDeviceStatus[0]!(Types.DeviceStatusEnum.DeviceDisconnected as never);
    });
    connectMeshtasticDeviceMock.mockResolvedValue(handle);

    const monitorPromise = monitorMeshtasticProvider({
      config: { channels: { meshtastic: { host: "192.0.2.10" } } } as CoreConfig,
      runtime: { log: vi.fn(), error: vi.fn() } as never,
    });
    await expect(monitorPromise).rejects.toThrow(/disconnected during startup/);
  });
});
