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
import { resetIdentityGateThrottleForTests } from "./identity-gate.js";
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
        onDeviceMetadataPacket: event("onDeviceMetadataPacket"),
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
    resetIdentityGateThrottleForTests();
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
    // 2026.11.1 (MCP07): the gate drops mismatches by default — this grading
    // test pins the legacy dispatch path explicitly.
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
        dmIdentity: "off",
        pkiMismatch: "unverified",
      },
    });
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
    // 2026.11.1 (MCP07): the gate drops mismatches by default — this grading
    // test pins the legacy dispatch path explicitly.
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
        dmIdentity: "off",
        pkiMismatch: "unverified",
      },
    });
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
    // 2026.11.1 (MCP07): the gate drops mismatches by default — this grading
    // test pins the legacy dispatch path explicitly.
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
        dmIdentity: "off",
        pkiMismatch: "unverified",
      },
    });
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
    if (opts.accountConfigExtra || opts.accountExtra) {
      resolveMeshtasticAccountMock.mockReturnValue({
        accountId: "default",
        configured: true,
        transport: "tcp" as const,
        host: "192.0.2.10",
        port: 4403,
        ...(opts.accountExtra ?? {}),
        config: {
          dmPolicy: "pairing",
          allowFrom: [],
          groupPolicy: "disabled",
          channels: [0],
          ...(opts.accountConfigExtra ?? {}),
        },
      });
    }
    const { handle, subs } = createHandle();
    connectMeshtasticDeviceMock.mockResolvedValue(handle);
    const abortController = new AbortController();
    const monitorPromise = monitorMeshtasticProvider({
      config: {
        channels: { meshtastic: { host: "192.0.2.10" } },
        ...(opts.coreConfigExtra ?? {}),
      } as CoreConfig,
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
    // 2026.11.1 (MCP07): the second read grades psk-grade — under the default
    // known-keys gate that message would be dropped before dispatch. This test
    // pins provenance-consumption semantics, so it runs the legacy gate.
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
        dmIdentity: "off",
      },
    });
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

  it("the identity gate drops a mismatched sender before a custom onMessage consumer (MCP07)", async () => {
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
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("identity gate drop DM")),
    );
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("reason=pki-mismatch"));
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

  it("T19 known-keys: a forged psk-grade DM for a pinned number never reaches a custom onMessage consumer (MCP07)", async () => {
    const num = consistentNum(0x61);
    // A real prior PKI contact pinned this number; the forged DM arrives
    // WITHOUT provenance (psk-grade) and must be refused before any consumer.
    observeNodeKey("default", num, Buffer.from(key(0x61)).toString("base64"), "pki-packet");
    const seen: MeshtasticInboundMessage[] = [];
    const { consoleLogSpy, subs, abortController, monitorPromise } = await startWith({
      onMessage: async (m) => {
        seen.push(m);
      },
    });
    inboundMock.mockClear();
    for (const fn of subs.onMessagePacket ?? []) {
      fn(typedTextPacket({ id: 7101, from: num }) as never);
    }
    await vi.waitFor(() =>
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("identity gate drop DM")),
    );
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining("reason=known-key-unverified"),
    );
    expect(seen).toHaveLength(0);
    expect(inboundMock).not.toHaveBeenCalled();
    abortController.abort();
    await monitorPromise;
  });

  it("T20 the plugin-side decrypt path never builds DMs; broadcasts still decrypt (CVE-2025-53627, MCP07)", async () => {
    expandPskMock.mockReturnValue(new Uint8Array(16).fill(7));
    const { consoleLogSpy, subs, abortController, monitorPromise } = await startWith();
    inboundMock.mockClear();
    decryptChannelPacketMock.mockClear();
    subs.onChannelPacket?.[0]?.({ index: 0, settings: { psk: new Uint8Array([1]) } } as never);

    // Channel-key packet addressed to ONE node: refused before the decryptor.
    fireRawMeshPacket(subs, {
      id: 7201,
      from: SENDER,
      to: MY_NUM,
      channel: 0,
      rxTime: 1790000000,
      payloadVariant: { case: "encrypted", value: new Uint8Array([9, 9, 9]) },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(decryptChannelPacketMock).not.toHaveBeenCalled();
    expect(inboundMock).not.toHaveBeenCalled();
    expect(consoleLogSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("inbound (decrypted)"),
    );

    // A broadcast on the same path still decrypts and dispatches.
    decryptChannelPacketMock.mockReturnValue(new TextEncoder().encode("hello mesh"));
    fireRawMeshPacket(subs, {
      id: 7202,
      from: SENDER,
      to: 0xffffffff,
      channel: 0,
      rxTime: 1790000000,
      payloadVariant: { case: "encrypted", value: new Uint8Array([9, 9, 9]) },
    });
    await vi.waitFor(() => expect(inboundMock).toHaveBeenCalled());
    const message = await lastInboundMessage();
    expect(message.isGroup).toBe(true);
    expect(message.senderIdentity?.grade).toBe("psk-grade");
    abortController.abort();
    await monitorPromise;
  });

  describe("identity gate startup checks (MCP07 T24)", () => {
    beforeEach(() => {
      resetIdentityGateThrottleForTests();
      resolveMeshtasticAccountMock.mockReturnValue({
        accountId: "default",
        configured: true,
        transport: "tcp" as const,
        host: "192.0.2.10",
        port: 4403,
        config: { dmPolicy: "pairing", allowFrom: [], groupPolicy: "disabled", channels: [0] },
      });
    });

    function fireMetadata(subs: Record<string, Handler[]>, firmwareVersion: string): void {
      for (const fn of subs.onDeviceMetadataPacket ?? []) {
        fn({ data: { firmwareVersion } } as never);
      }
    }

    it("clean defaults emit no identity-gate WARN/INFO startup lines", async () => {
      const { consoleLogSpy, abortController, monitorPromise } = await startWith();
      consoleLogSpy.mockClear();
      await new Promise((resolve) => setTimeout(resolve, 60));
      const gateLines = consoleLogSpy.mock.calls
        .map((c) => String(c[0]))
        .filter(
          (l) => l.includes("meshtastic: WARN") || l.includes("INFO commands.ownerAllowFrom"),
        );
      expect(gateLines).toEqual([]);
      abortController.abort();
      await monitorPromise;
    });

    it("dmIdentity=off warns exactly once per start", async () => {
      const { consoleLogSpy, abortController, monitorPromise } = await startWith({
        accountConfigExtra: { dmIdentity: "off" },
      });
      await vi.waitFor(() =>
        expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("WARN dmIdentity=off")),
      );
      expect(
        consoleLogSpy.mock.calls.filter((c) => String(c[0]).includes("WARN dmIdentity=off")),
      ).toHaveLength(1);
      abortController.abort();
      await monitorPromise;
    });

    it("commandIdentity=policy warns", async () => {
      const { consoleLogSpy, abortController, monitorPromise } = await startWith({
        accountConfigExtra: { commandIdentity: "policy" },
      });
      await vi.waitFor(() =>
        expect(consoleLogSpy).toHaveBeenCalledWith(
          expect.stringContaining("WARN commandIdentity=policy"),
        ),
      );
      abortController.abort();
      await monitorPromise;
    });

    it("transport=http with the default known-keys gate warns", async () => {
      const { consoleLogSpy, abortController, monitorPromise } = await startWith({
        accountExtra: { transport: "http" },
      });
      await vi.waitFor(() =>
        expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("WARN transport=http")),
      );
      abortController.abort();
      await monitorPromise;
    });

    it("owner mesh entries produce one INFO line with ids and pin fingerprints", async () => {
      const num = consistentNum(0x63);
      observeNodeKey("default", num, Buffer.from(key(0x63)).toString("base64"), "pki-packet");
      const nodeId = "!" + num.toString(16).padStart(8, "0");
      const { consoleLogSpy, abortController, monitorPromise } = await startWith({
        coreConfigExtra: { commands: { ownerAllowFrom: [`meshtastic:${nodeId}`, "!000000aa"] } },
      });
      await vi.waitFor(() =>
        expect(consoleLogSpy).toHaveBeenCalledWith(
          expect.stringContaining("INFO commands.ownerAllowFrom resolves to mesh node(s)"),
        ),
      );
      const line =
        consoleLogSpy.mock.calls
          .map((c) => String(c[0]))
          .find((l) => l.includes("INFO commands.ownerAllowFrom")) ?? "";
      expect(line).toContain(nodeId);
      expect(line).toContain("!000000aa");
      expect(line).toMatch(/fp=[0-9a-f]{12}/);
      expect(line).toContain("key continuity");
      abortController.abort();
      await monitorPromise;
    });

    it("a key-bound manual entry differing from the stored pin warns with both fingerprints", async () => {
      const num = consistentNum(0x64);
      const nodeId = "!" + num.toString(16).padStart(8, "0");
      observeNodeKey("default", num, Buffer.from(key(0x64)).toString("base64"), "pki-packet");
      const configured = Buffer.from(key(0x65)).toString("base64");
      const { consoleLogSpy, abortController, monitorPromise } = await startWith({
        accountConfigExtra: { pkiManuallyVerified: [`${nodeId}=${configured}`] },
      });
      await vi.waitFor(() =>
        expect(consoleLogSpy).toHaveBeenCalledWith(
          expect.stringContaining("WARN pkiManuallyVerified key for"),
        ),
      );
      const line =
        consoleLogSpy.mock.calls
          .map((c) => String(c[0]))
          .find((l) => l.includes("WARN pkiManuallyVerified key for")) ?? "";
      expect(line).toContain("differs from the stored pin");
      expect(line).toContain("pkiRepin");
      expect(line.match(/fp=[0-9a-f]{12}/g)?.length).toBeGreaterThanOrEqual(2);
      abortController.abort();
      await monitorPromise;
    });

    it("gateway firmware below 2.7.15 warns (CVE-2025-53627)", async () => {
      const { consoleLogSpy, subs, abortController, monitorPromise } = await startWith();
      fireMetadata(subs, "2.7.10.abc");
      await vi.waitFor(() =>
        expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("CVE-2025-53627")),
      );
      abortController.abort();
      await monitorPromise;
    });

    it("firmware 2.7.15 or newer does not warn", async () => {
      const { consoleLogSpy, subs, abortController, monitorPromise } = await startWith();
      consoleLogSpy.mockClear();
      fireMetadata(subs, "2.7.15");
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(consoleLogSpy).not.toHaveBeenCalledWith(expect.stringContaining("CVE-2025-53627"));
      abortController.abort();
      await monitorPromise;
    });
  });
});
