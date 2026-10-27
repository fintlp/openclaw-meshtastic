import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { monitorMeshtasticProvider } from "./monitor.js";
import {
  buildNodeBook,
  readNodeBook,
  resetNodeBookForTests,
  setNodeBookPathForTests,
} from "./node-book.js";
import type { CoreConfig } from "./types.js";

// Node book wiring (#15): the radio replays its node database DURING
// configure(), so the node events must be subscribed before configure()
// runs, and channel stop must flush the throttled write.

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
vi.mock("./crypto.js", () => ({ expandPsk: vi.fn(), decryptChannelPacket: vi.fn() }));

type Handler = (payload: never) => void;

function createHandle() {
  const subs: Record<string, Handler[]> = {};
  const event = (name: string) => ({
    subscribe: vi.fn((fn: Handler) => {
      (subs[name] ??= []).push(fn);
      return () => {};
    }),
  });
  const handle = {
    accountId: "default",
    myNodeNum: null,
    // Simulates the radio's node-database replay, which happens inside configure().
    configure: vi.fn(async () => {
      for (const fn of subs.onMyNodeInfo ?? []) fn({ myNodeNum: 0x11 } as never);
      for (const fn of subs.onNodeInfoPacket ?? []) {
        fn({ num: 0x11, user: { longName: "Home Gateway" } } as never);
        fn({
          num: 0x22,
          user: { longName: "Schoeckl" },
          position: { latitudeI: 471983000, longitudeI: 154650000 },
          lastHeard: 1790000000,
        } as never);
      }
    }),
    device: {
      events: {
        onChannelPacket: event("onChannelPacket"),
        onMeshPacket: event("onMeshPacket"),
        onMessagePacket: event("onMessagePacket"),
        onDeviceStatus: event("onDeviceStatus"),
        onNodeInfoPacket: event("onNodeInfoPacket"),
        onUserPacket: event("onUserPacket"),
        onPositionPacket: event("onPositionPacket"),
        onMyNodeInfo: event("onMyNodeInfo"),
      },
    },
  };
  return { handle };
}

let dir: string;

describe("monitor node book wiring (#15)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetNodeBookForTests();
    dir = mkdtempSync(join(tmpdir(), "meshtastic-monitor-nodebook-"));
    setNodeBookPathForTests(join(dir, "meshtastic-nodes.json"));
    getMeshtasticRuntimeMock.mockReturnValue({
      config: { current: () => ({ channels: { meshtastic: { host: "192.0.2.10" } } }) },
      logging: {
        getChildLogger: () => ({ info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
        shouldLogVerbose: () => false,
      },
      channel: { activity: { record: vi.fn() } },
    });
    resolveMeshtasticAccountMock.mockReturnValue({
      accountId: "default",
      configured: true,
      transport: "tcp" as const,
      host: "192.0.2.10",
      port: 4403,
      config: { dmPolicy: "pairing", allowFrom: [], groupPolicy: "disabled", channels: [0] },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetNodeBookForTests();
    rmSync(dir, { recursive: true, force: true });
  });

  it("captures the connect replay and writes the file when the channel stops", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { handle } = createHandle();
    connectMeshtasticDeviceMock.mockResolvedValue(handle);
    const abortController = new AbortController();
    const monitorPromise = monitorMeshtasticProvider({
      config: { channels: { meshtastic: { host: "192.0.2.10" } } } as CoreConfig,
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      abortSignal: abortController.signal,
    });
    await vi.waitFor(() => expect(handle.configure).toHaveBeenCalled());

    // Replayed during configure(): only possible if subscribed before it.
    const book = buildNodeBook("default");
    expect(book.selfId).toBe("!00000011");
    expect(book.nodes.map((n) => n.name)).toEqual(["Home Gateway", "Schoeckl"]);

    // Nothing on disk yet (throttled), then stop flushes it.
    expect(readNodeBook("default")).toBeUndefined();
    abortController.abort();
    await monitorPromise;
    const file = readNodeBook("default");
    expect(file?.withPosition).toBe(1);
    expect(file?.nodes.find((n) => n.name === "Schoeckl")).toMatchObject({ lat: 47.1983, lon: 15.465 });
  });
});
