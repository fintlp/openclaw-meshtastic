import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleMeshtasticInbound } from "./inbound.js";
import { monitorMeshtasticProvider } from "./monitor.js";
import {
  crc32ForNodeKey,
  flushNodeBookWrites,
  getNodeKeyPin,
  getRepinMarker,
  observeNodeKey,
  resetNodeBookForTests,
  setKeyBookPathForTests,
  setNodeBookPathForTests,
} from "./node-book.js";
import type { CoreConfig, MeshtasticInboundMessage } from "./types.js";

// Monitor-level PKI identity wiring (issue #7 phase 1): raw-packet provenance
// recorded before typed events, keybook pinning from PKI provenance, grading,
// the (from,id) correlation key, the fail-closed encrypted+PKI drop, and the
// operator re-pin action. Generic fixtures only.

const {
  connectMeshtasticDeviceMock,
  disconnectMeshtasticDeviceMock,
  resolveMeshtasticAccountMock,
  getMeshtasticRuntimeMock,
  expandPskMock,
  decryptChannelPacketMock,
} = vi.hoisted(() => ({
  connectMeshtasticDeviceMock: vi.fn(),
  disconnectMeshtasticDeviceMock: vi.fn(),
  resolveMeshtasticAccountMock: vi.fn(),
  getMeshtasticRuntimeMock: vi.fn(),
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
vi.mock("./inbound.js", () => ({ handleMeshtasticInbound: vi.fn(async () => undefined) }));
vi.mock("./crypto.js", () => ({
  expandPsk: expandPskMock,
  decryptChannelPacket: decryptChannelPacketMock,
}));

const inboundMock = vi.mocked(handleMeshtasticInbound);

const MY_NUM = 123;
const SENDER = 456; // !000001c8

function key(marker: number): Uint8Array {
  return new Uint8Array(32).fill(marker);
}

/** A node number that IS crc32-consistent with the given key (2.8+ binding). */
function consistentNum(marker: number): number {
  const num = crc32ForNodeKey(key(marker));
  if (num === 0 || num === 0xffffffff) {
    throw new Error("fixture collision");
  }
  return num;
}

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
    myNodeNum: MY_NUM,
    configure: vi.fn(async () => {}),
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
  return { handle, subs };
}

function fireRawMeshPacket(
  subs: Record<string, Handler[]>,
  packet: Record<string, unknown>,
): void {
  // The real dispatcher delivers the raw event to every subscriber
  // synchronously (node book first, then the monitor handler).
  for (const fn of subs.onMeshPacket ?? []) {
    fn(packet as never);
  }
}

function decodedPkiPacket(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 1001,
    from: SENDER,
    to: MY_NUM,
    channel: 0,
    rxTime: 1790000000,
    pkiEncrypted: true,
    publicKey: key(0x11),
    payloadVariant: { case: "decoded", value: {} },
    ...overrides,
  };
}

function typedTextPacket(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 1001,
    rxTime: new Date(1790000000 * 1000),
    type: "direct",
    from: SENDER,
    to: MY_NUM,
    channel: 0,
    data: "fixture text",
    ...overrides,
  };
}

let dir: string;

async function startMonitor(accountConfigExtra?: Record<string, unknown>) {
  const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  const { handle, subs } = createHandle();
  connectMeshtasticDeviceMock.mockResolvedValue(handle);
  const abortController = new AbortController();
  const monitorPromise = monitorMeshtasticProvider({
    config: { channels: { meshtastic: { host: "192.0.2.10" } } } as CoreConfig,
    runtime: { log: vi.fn(), error: vi.fn() } as never,
    abortSignal: abortController.signal,
  });
  await vi.waitFor(() => expect(handle.configure).toHaveBeenCalled());
  return { consoleLogSpy, subs, abortController, monitorPromise };
}

async function lastInboundMessage(): Promise<MeshtasticInboundMessage> {
  await vi.waitFor(() => expect(inboundMock).toHaveBeenCalled());
  const calls = inboundMock.mock.calls;
  return (calls[calls.length - 1]![0] as { message: MeshtasticInboundMessage }).message;
}

describe("monitor PKI sender identity (issue #7)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetNodeBookForTests();
    dir = mkdtempSync(join(tmpdir(), "meshtastic-monitor-pki-"));
    setNodeBookPathForTests(join(dir, "meshtastic-nodes.json"));
    setKeyBookPathForTests(join(dir, "meshtastic-keys.json"));
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
    expandPskMock.mockReturnValue(new Uint8Array(16).fill(7));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetNodeBookForTests();
    rmSync(dir, { recursive: true, force: true });
  });

  it("grades a PKI-decrypted DM pki-verified, pins the key, and tags the log line", async () => {
    const { consoleLogSpy, subs, abortController, monitorPromise } = await startMonitor();
    const num = consistentNum(0x11);

    fireRawMeshPacket(subs, decodedPkiPacket({ from: num, publicKey: key(0x11) }));
    expect(getNodeKeyPin("default", num)?.publicKey).toBe(
      Buffer.from(key(0x11)).toString("base64"),
    );
    for (const fn of subs.onMessagePacket ?? []) {
      fn(typedTextPacket({ from: num }) as never);
    }

    const message = await lastInboundMessage();
    expect(message.senderIdentity).toMatchObject({
      grade: "pki-verified",
      detail: "first-seen pin (TOFU)",
    });
    expect(message.senderIdentity?.keyFp).toMatch(/^[0-9a-f]{12}$/);
    // The annotation is a structured field — the text is untouched.
    expect(message.text).toBe("fixture text");
    await vi.waitFor(() =>
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("identity=pki-verified")),
    );

    abortController.abort();
    await monitorPromise;
  });

  it("grades continuity (same key again) pki-verified without the TOFU detail", async () => {
    const { subs, abortController, monitorPromise } = await startMonitor();
    const num = consistentNum(0x11);
    fireRawMeshPacket(subs, decodedPkiPacket({ id: 1001, from: num, publicKey: key(0x11) }));
    fireRawMeshPacket(subs, decodedPkiPacket({ id: 1002, from: num, publicKey: key(0x11) }));
    for (const fn of subs.onMessagePacket ?? []) {
      fn(typedTextPacket({ id: 1002, from: num }) as never);
    }
    const message = await lastInboundMessage();
    expect(message.senderIdentity?.grade).toBe("pki-verified");
    expect(message.senderIdentity?.detail).toBeUndefined();
    abortController.abort();
    await monitorPromise;
  });

  it("a key flip between packets degrades to mismatch and logs the distinct line", async () => {
    const { consoleLogSpy, subs, abortController, monitorPromise } = await startMonitor();
    const num = consistentNum(0x11);
    fireRawMeshPacket(subs, decodedPkiPacket({ id: 1001, from: num, publicKey: key(0x11) }));
    fireRawMeshPacket(subs, decodedPkiPacket({ id: 1002, from: num, publicKey: key(0x22) }));
    for (const fn of subs.onMessagePacket ?? []) {
      fn(typedTextPacket({ id: 1002, from: num }) as never);
    }
    const message = await lastInboundMessage();
    expect(message.senderIdentity?.grade).toBe("mismatch");
    expect(message.senderIdentity?.detail).toContain("key changed");
    await vi.waitFor(() =>
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining("pki key mismatch for"),
      ),
    );
    // The pin did not move.
    expect(getNodeKeyPin("default", num)?.publicKey).toBe(
      Buffer.from(key(0x11)).toString("base64"),
    );
    abortController.abort();
    await monitorPromise;
  });

  it("grades channel-PSK/cleartext traffic psk-grade even when it carries a key", async () => {
    const { subs, abortController, monitorPromise } = await startMonitor();
    // Decoded packet WITHOUT pkiEncrypted (channel traffic) — a publicKey
    // riding along must NOT pin anything nor upgrade the grade.
    fireRawMeshPacket(subs, {
      id: 2001,
      from: SENDER,
      to: MY_NUM,
      channel: 0,
      rxTime: 1790000000,
      pkiEncrypted: false,
      publicKey: key(0x33),
      payloadVariant: { case: "decoded", value: {} },
    });
    for (const fn of subs.onMessagePacket ?? []) {
      fn(typedTextPacket({ id: 2001 }) as never);
    }
    const message = await lastInboundMessage();
    expect(message.senderIdentity).toEqual({ grade: "psk-grade" });
    expect(getNodeKeyPin("default", SENDER)).toBeNull();
    abortController.abort();
    await monitorPromise;
  });

  it("pre-2.5 / keyless nodes degrade to psk-grade without errors", async () => {
    const { subs, abortController, monitorPromise } = await startMonitor();
    // A decoded packet with no PKI fields at all (legacy firmware).
    fireRawMeshPacket(subs, {
      id: 2002,
      from: SENDER,
      to: MY_NUM,
      channel: 0,
      rxTime: 1790000000,
      payloadVariant: { case: "decoded", value: {} },
    });
    for (const fn of subs.onMessagePacket ?? []) {
      fn(typedTextPacket({ id: 2002 }) as never);
    }
    const message = await lastInboundMessage();
    expect(message.senderIdentity).toEqual({ grade: "psk-grade" });
    expect(getNodeKeyPin("default", SENDER)).toBeNull();
    abortController.abort();
    await monitorPromise;
  });

  it("a decoded pki_encrypted packet WITHOUT key provenance is surfaced as mismatch", async () => {
    const { subs, abortController, monitorPromise } = await startMonitor();
    fireRawMeshPacket(subs, {
      id: 2003,
      from: SENDER,
      to: MY_NUM,
      channel: 0,
      rxTime: 1790000000,
      pkiEncrypted: true,
      payloadVariant: { case: "decoded", value: {} },
    });
    for (const fn of subs.onMessagePacket ?? []) {
      fn(typedTextPacket({ id: 2003 }) as never);
    }
    const message = await lastInboundMessage();
    expect(message.senderIdentity?.grade).toBe("mismatch");
    expect(message.senderIdentity?.detail).toContain("without public-key provenance");
    expect(getNodeKeyPin("default", SENDER)).toBeNull();
    abortController.abort();
    await monitorPromise;
  });

  it("provenance is keyed by (from, id): two senders reusing a packet id grade independently", async () => {
    const { subs, abortController, monitorPromise } = await startMonitor();
    const numA = consistentNum(0x11);
    const numB = consistentNum(0x22);
    // Same packet id 3000 from two different senders: one PKI, one cleartext.
    fireRawMeshPacket(subs, decodedPkiPacket({ id: 3000, from: numA, publicKey: key(0x11) }));
    fireRawMeshPacket(subs, {
      id: 3000,
      from: numB,
      to: MY_NUM,
      channel: 0,
      rxTime: 1790000000,
      payloadVariant: { case: "decoded", value: {} },
    });
    for (const fn of subs.onMessagePacket ?? []) {
      fn(typedTextPacket({ id: 3000, from: numA, data: "from A" }) as never);
    }
    const msgA = await lastInboundMessage();
    expect(msgA.senderIdentity?.grade).toBe("pki-verified");
    for (const fn of subs.onMessagePacket ?? []) {
      fn(typedTextPacket({ id: 3000, from: numB, data: "from B" }) as never);
    }
    await vi.waitFor(() => expect(inboundMock).toHaveBeenCalledTimes(2));
    const msgB = await lastInboundMessage();
    expect(msgB.senderIdentity?.grade).toBe("psk-grade");
    abortController.abort();
    await monitorPromise;
  });

  it("fail-closed regression: encrypted+pki_encrypted still drops with the distinct line, and teaches the keybook nothing", async () => {
    const { consoleLogSpy, subs, abortController, monitorPromise } = await startMonitor();
    subs.onChannelPacket?.[0]?.({ index: 0, settings: { psk: new Uint8Array([1]) } } as never);
    fireRawMeshPacket(subs, {
      id: 4001,
      from: SENDER,
      to: MY_NUM,
      channel: 0,
      rxTime: 1790000000,
      pkiEncrypted: true,
      publicKey: key(0x44),
      payloadVariant: { case: "encrypted", value: new Uint8Array([9, 9, 9]) },
    });
    expect(decryptChannelPacketMock).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(inboundMock).not.toHaveBeenCalled();
    expect(consoleLogSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("inbound (decrypted)"),
    );
    // The dropped packet's claimed key is never pinned.
    expect(getNodeKeyPin("default", SENDER)).toBeNull();
    abortController.abort();
    await monitorPromise;
  });

  it("operator re-pin: pkiRepin clears the stored pin at start so the rotated key re-pins", async () => {
    // Pre-seed a pin (old key), persist it, then restart with pkiRepin set.
    const num = consistentNum(0x11);
    observeNodeKey("default", num, Buffer.from(key(0x11)).toString("base64"), "pki-packet");
    flushNodeBookWrites();
    resetNodeBookForTests();
    setNodeBookPathForTests(join(dir, "meshtastic-nodes.json"));
    setKeyBookPathForTests(join(dir, "meshtastic-keys.json"));

    resolveMeshtasticAccountMock.mockReturnValue({
      accountId: "default",
      configured: true,
      transport: "tcp" as const,
      host: "192.0.2.10",
      port: 4403,
      config: {
        dmPolicy: "pairing",
        allowFrom: [],
        groupPolicy: "disabled",
        channels: [0],
        pkiRepin: ["!" + num.toString(16).padStart(8, "0")],
      },
    });
    const { consoleLogSpy, subs, abortController, monitorPromise } = await startMonitor();
    await vi.waitFor(() =>
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining("pkiRepin: cleared key pin for"),
      ),
    );
    expect(getNodeKeyPin("default", num)).toBeNull();

    // The rotated key now arrives and re-pins — verified again, never stranded.
    fireRawMeshPacket(subs, decodedPkiPacket({ id: 5001, from: num, publicKey: key(0x22) }));
    for (const fn of subs.onMessagePacket ?? []) {
      fn(typedTextPacket({ id: 5001, from: num }) as never);
    }
    const message = await lastInboundMessage();
    expect(message.senderIdentity?.grade).toBe("pki-verified");
    expect(getNodeKeyPin("default", num)?.publicKey).toBe(
      Buffer.from(key(0x22)).toString("base64"),
    );
    abortController.abort();
    await monitorPromise;
  });

  it("without a re-pin a rotated node stays mismatch — never auto-heals", async () => {
    const { subs, abortController, monitorPromise } = await startMonitor();
    const num = consistentNum(0x11);
    fireRawMeshPacket(subs, decodedPkiPacket({ id: 6001, from: num, publicKey: key(0x11) }));
    // Rotation happens; every subsequent packet carries the new key.
    for (const id of [6002, 6003, 6004]) {
      fireRawMeshPacket(subs, decodedPkiPacket({ id, from: num, publicKey: key(0x22) }));
      for (const fn of subs.onMessagePacket ?? []) {
        fn(typedTextPacket({ id, from: num }) as never);
      }
    }
    const message = await lastInboundMessage();
    expect(message.senderIdentity?.grade).toBe("mismatch");
    expect(getNodeKeyPin("default", num)?.publicKey).toBe(
      Buffer.from(key(0x11)).toString("base64"),
    );
    abortController.abort();
    await monitorPromise;
  });
});
describe("security rework (#7 review)", () => {
  async function startWith(opts: {
    onMessage?: (message: MeshtasticInboundMessage, handle: unknown) => Promise<void>;
  } = {}) {
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    // Self-contained runtime mock so a test can start the monitor more than
    // once (reconnect simulation) regardless of test ordering.
    getMeshtasticRuntimeMock.mockReturnValue({
      config: { current: () => ({ channels: { meshtastic: { host: "192.0.2.10" } } }) },
      logging: {
        getChildLogger: () => ({ info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
        shouldLogVerbose: () => false,
      },
      channel: { activity: { record: vi.fn() } },
    });
    const { handle, subs } = createHandle();
    connectMeshtasticDeviceMock.mockResolvedValue(handle);
    const abortController = new AbortController();
    const monitorPromise = monitorMeshtasticProvider({
      config: { channels: { meshtastic: { host: "192.0.2.10" } } } as CoreConfig,
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      abortSignal: abortController.signal,
      ...(opts.onMessage ? { onMessage: opts.onMessage as never } : {}),
    });
    await vi.waitFor(() => expect(handle.configure).toHaveBeenCalled());
    return { consoleLogSpy, subs, handle, abortController, monitorPromise };
  }

  function fireTyped(subs: Record<string, Handler[]>, packet: Record<string, unknown>): void {
    for (const fn of subs.onMessagePacket ?? []) {
      fn(packet as never);
    }
  }

  it("consumes provenance once — a recycled (from,id) can never re-read a grade", async () => {
    const { subs, abortController, monitorPromise } = await startWith();
    const num = consistentNum(0x51);

    fireRawMeshPacket(subs, decodedPkiPacket({ id: 7001, from: num, publicKey: key(0x51) }));
    fireTyped(subs, typedTextPacket({ id: 7001, from: num }));
    const first = await lastInboundMessage();
    expect(first.senderIdentity?.grade).toBe("pki-verified");

    // Same (from,id) again with NO fresh raw packet: the entry was consumed.
    inboundMock.mockClear();
    fireTyped(subs, typedTextPacket({ id: 7001, from: num }));
    const second = await lastInboundMessage();
    expect(second.senderIdentity?.grade).toBe("psk-grade");

    abortController.abort();
    await monitorPromise;
  });

  it("applies pkiMismatch=drop to the onMessage dispatch path too", async () => {
    resolveMeshtasticAccountMock.mockReturnValue({
      accountId: "default",
      configured: true,
      transport: "tcp" as const,
      host: "192.0.2.10",
      port: 4403,
      config: {
        dmPolicy: "pairing",
        allowFrom: [],
        groupPolicy: "disabled",
        channels: [0],
        pkiMismatch: "drop",
      },
    });
    const seen: MeshtasticInboundMessage[] = [];
    const { consoleLogSpy, subs, abortController, monitorPromise } = await startWith({
      onMessage: async (message) => {
        seen.push(message);
      },
    });
    const num = consistentNum(0x52);
    // Pin the honest key first, then present a conflicting one.
    fireRawMeshPacket(subs, decodedPkiPacket({ id: 7002, from: num, publicKey: key(0x52) }));
    fireRawMeshPacket(subs, decodedPkiPacket({ id: 7003, from: num, publicKey: key(0x53) }));
    fireTyped(subs, typedTextPacket({ id: 7003, from: num }));

    await vi.waitFor(() =>
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("pkiMismatch=drop")),
    );
    expect(seen).toHaveLength(0);

    abortController.abort();
    await monitorPromise;
  });

  it("pkiRepin clears a pin once and stays idempotent across reconnects", async () => {
    const num = consistentNum(0x54);
    const nodeId = `!${num.toString(16).padStart(8, "0")}`;
    resolveMeshtasticAccountMock.mockReturnValue({
      accountId: "default",
      configured: true,
      transport: "tcp" as const,
      host: "192.0.2.10",
      port: 4403,
      config: {
        dmPolicy: "pairing",
        allowFrom: [],
        groupPolicy: "disabled",
        channels: [0],
        pkiRepin: [nodeId],
      },
    });
    // A pin exists from an earlier run.
    observeNodeKey("default", num, Buffer.from(key(0x54)).toString("base64"), "pki-packet");

    const first = await startWith();
    expect(getNodeKeyPin("default", num)).toBeNull();
    expect(first.consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining("pkiRepin: cleared key pin"),
    );

    // The node re-advertises its rotated key (new pin after the clear).
    observeNodeKey("default", num, Buffer.from(key(0x55)).toString("base64"), "nodeinfo");
    expect(getNodeKeyPin("default", num)).not.toBeNull();

    first.abortController.abort();
    await first.monitorPromise;

    // A reconnect must NOT clear the freshly re-learned pin. (vi.spyOn returns
    // the SAME spy on a second call, so compare calls made after this point.)
    const callsBeforeReconnect = first.consoleLogSpy.mock.calls.length;
    const second = await startWith();
    const clearCalls = second.consoleLogSpy.mock.calls
      .slice(callsBeforeReconnect)
      .filter((call) => String(call[0]).includes("pkiRepin: cleared key pin"));
    expect(clearCalls).toHaveLength(0);
    expect(getNodeKeyPin("default", num)).not.toBeNull();

    second.abortController.abort();
    await second.monitorPromise;
  });

  it("prunes the pkiRepin marker end-to-end when the entry is removed (wiring test)", async () => {
    const num = consistentNum(0x56);
    const nodeId = `!${num.toString(16).padStart(8, "0")}`;
    const baseAccount = {
      accountId: "default",
      configured: true,
      transport: "tcp" as const,
      host: "192.0.2.10",
      port: 4403,
      config: {
        dmPolicy: "pairing",
        allowFrom: [],
        groupPolicy: "disabled",
        channels: [0],
      },
    };

    // First connect: the node is listed in pkiRepin, so a marker is recorded.
    resolveMeshtasticAccountMock.mockReturnValue({
      ...baseAccount,
      config: { ...baseAccount.config, pkiRepin: [nodeId] },
    });
    observeNodeKey("default", num, Buffer.from(key(0x56)).toString("base64"), "pki-packet");
    const first = await startWith();
    expect(getRepinMarker("default", num)).toBeTypeOf("number");
    first.abortController.abort();
    await first.monitorPromise;

    // Second connect with the entry removed: the marker must be pruned by the
    // monitor itself (a deleted pruneRepinMarkers call would leave it set).
    resolveMeshtasticAccountMock.mockReturnValue(baseAccount);
    const second = await startWith();
    expect(getRepinMarker("default", num)).toBeUndefined();
    second.abortController.abort();
    await second.monitorPromise;
  });
});
