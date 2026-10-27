import { mkdtempSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NODE_BOOK_MAX_NODES,
  buildNodeBook,
  decodePosition,
  flushNodeBookWrites,
  nodeBookPath,
  readNodeBook,
  recordMeshPacket,
  recordNodeInfo,
  recordPosition,
  recordUser,
  resetNodeBookForTests,
  setNodeBookPathForTests,
  setNodeBookSelf,
  setNodeBookThrottleMsForTests,
  subscribeNodeBook,
} from "./node-book.js";

const ACCT = "default";
// Real enum values from @meshtastic/core 2.6.7: HardwareModel 43 = HELTEC_V3, Role 2 = ROUTER.
const HELTEC_V3 = 43;
const ROLE_ROUTER = 2;

let dir: string;

beforeEach(() => {
  resetNodeBookForTests();
  dir = mkdtempSync(join(tmpdir(), "meshtastic-node-book-"));
});

afterEach(() => {
  resetNodeBookForTests();
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

function node(id: number) {
  return buildNodeBook(ACCT).nodes.find((n) => n.num === id);
}

describe("decodePosition", () => {
  it("converts 1e7 fixed point to decimal degrees and keeps optional fields", () => {
    expect(
      decodePosition({ latitudeI: 471369510, longitudeI: 154816690, altitude: 395, time: 1790000000, precisionBits: 32 }),
    ).toEqual({ lat: 47.136951, lon: 15.481669, altitude: 395, positionTime: 1790000000, precisionBits: 32 });
  });

  it("treats 0/0, out-of-range and malformed values as no position", () => {
    expect(decodePosition({ latitudeI: 0, longitudeI: 0 })).toBeNull();
    expect(decodePosition({ latitudeI: 950000000, longitudeI: 0 })).toBeNull();
    expect(decodePosition({ latitudeI: 10, longitudeI: 1900000000 })).toBeNull();
    expect(decodePosition({ latitudeI: "47", longitudeI: 15 })).toBeNull();
    expect(decodePosition(undefined)).toBeNull();
  });

  it("handles southern and western hemispheres", () => {
    expect(decodePosition({ latitudeI: -338688000, longitudeI: -1512093000 })).toEqual({ lat: -33.8688, lon: -151.2093 });
  });
});

describe("connect replay (NodeInfo)", () => {
  it("records names, role, hardware, position and the radio's own lastHeard", () => {
    recordNodeInfo(ACCT, {
      num: 0xa1b2c3d4,
      user: { longName: "Schoeckl Router", shortName: "SCHK", hwModel: HELTEC_V3, role: ROLE_ROUTER },
      position: { latitudeI: 471983000, longitudeI: 154650000, time: 1790000000 },
      lastHeard: 1790000100,
      snr: 6.25,
      hopsAway: 1,
      viaMqtt: false,
    });
    expect(node(0xa1b2c3d4)).toMatchObject({
      id: "!a1b2c3d4",
      name: "Schoeckl Router",
      shortName: "SCHK",
      role: "router",
      hwModel: "heltec_v3",
      lat: 47.1983,
      lon: 15.465,
      lastHeard: 1790000100,
      snr: 6.25,
      hopsAway: 1,
      viaMqtt: false,
      self: false,
    });
  });

  it("keeps hardware and roles the bundled library does not know as model_<n> / role_<n>", () => {
    recordNodeInfo(ACCT, { num: 3, user: { hwModel: 999, role: 99 } });
    recordNodeInfo(ACCT, { num: 4, user: { hwModel: 0, role: 0 } });
    expect(node(3)).toMatchObject({ hwModel: "model_999", role: "role_99" });
    // HardwareModel 0 is UNSET; Role 0 is CLIENT, a real role.
    expect(node(4)).toMatchObject({ hwModel: null, role: "client" });
  });

  it("falls back to short name, then the node id, for the display name", () => {
    recordNodeInfo(ACCT, { num: 1, user: { shortName: "AB" } });
    recordNodeInfo(ACCT, { num: 2 });
    expect(node(1)?.name).toBe("AB");
    expect(node(2)?.name).toBe("!00000002");
  });

  it("ignores unset and broadcast node numbers", () => {
    recordNodeInfo(ACCT, { num: 0, user: { longName: "zero" } });
    recordNodeInfo(ACCT, { num: 0xffffffff, user: { longName: "broadcast" } });
    recordNodeInfo(ACCT, { num: -5 });
    expect(buildNodeBook(ACCT).totalNodes).toBe(0);
  });
});

describe("timestamp rule", () => {
  it("never treats replayed position or user events as 'heard' evidence", () => {
    recordNodeInfo(ACCT, { num: 7, lastHeard: 1700000000 });
    // The library stamps these with rxTime = now during replay.
    recordPosition(ACCT, { from: 7, rxTime: new Date(), data: { latitudeI: 470000000, longitudeI: 150000000 } });
    recordUser(ACCT, { from: 7, rxTime: new Date(), data: { longName: "Renamed" } });
    expect(node(7)).toMatchObject({ lastHeard: 1700000000, name: "Renamed", lat: 47, lon: 15 });
  });

  it("updates lastHeard, SNR and hops from live mesh packets", () => {
    recordNodeInfo(ACCT, { num: 7, lastHeard: 1700000000 });
    recordMeshPacket(ACCT, { from: 7, rxTime: 1790000500, rxSnr: -4.5, hopStart: 3, hopLimit: 1 }, 1790000600);
    expect(node(7)).toMatchObject({ lastHeard: 1790000500, snr: -4.5, hopsAway: 2 });
  });

  it("uses 'now' when rxTime is missing and clamps a node clock in the future", () => {
    recordMeshPacket(ACCT, { from: 8, rxTime: 0 }, 1790000000);
    expect(node(8)?.lastHeard).toBe(1790000000);
    recordMeshPacket(ACCT, { from: 9, rxTime: 1990000000 }, 1790000000);
    expect(node(9)?.lastHeard).toBe(1790000300);
  });

  it("does not move lastHeard backwards", () => {
    recordMeshPacket(ACCT, { from: 7, rxTime: 1790000500 }, 1790000600);
    recordNodeInfo(ACCT, { num: 7, lastHeard: 1700000000 });
    expect(node(7)?.lastHeard).toBe(1790000500);
  });
});

describe("positions", () => {
  it("keeps the newer position when an older fix arrives later", () => {
    recordPosition(ACCT, { from: 3, data: { latitudeI: 471000000, longitudeI: 154000000, time: 1790000200 } });
    recordPosition(ACCT, { from: 3, data: { latitudeI: 460000000, longitudeI: 140000000, time: 1790000100 } });
    expect(node(3)).toMatchObject({ lat: 47.1, lon: 15.4, positionTime: 1790000200 });
  });

  it("records the coarsening level so consumers can show it", () => {
    recordPosition(ACCT, { from: 4, data: { latitudeI: 471000000, longitudeI: 154000000, precisionBits: 13 } });
    expect(node(4)?.precisionBits).toBe(13);
  });

  it("does not create an entry for an empty position", () => {
    recordPosition(ACCT, { from: 5, data: { latitudeI: 0, longitudeI: 0 } });
    expect(node(5)).toBeUndefined();
  });
});

describe("snapshot", () => {
  it("marks the gateway's own node, lists it first, then most recently heard", () => {
    recordNodeInfo(ACCT, { num: 10, lastHeard: 100 });
    recordNodeInfo(ACCT, { num: 11, lastHeard: 300 });
    recordNodeInfo(ACCT, { num: 12, lastHeard: 200 });
    setNodeBookSelf(ACCT, 12);
    const book = buildNodeBook(ACCT);
    expect(book.selfId).toBe("!0000000c");
    expect(book.nodes.map((n) => n.num)).toEqual([12, 11, 10]);
    expect(book.nodes[0].self).toBe(true);
  });

  it("counts nodes with a position and omits position fields otherwise", () => {
    recordNodeInfo(ACCT, { num: 1, position: { latitudeI: 470000000, longitudeI: 150000000 } });
    recordNodeInfo(ACCT, { num: 2 });
    const book = buildNodeBook(ACCT);
    expect(book.totalNodes).toBe(2);
    expect(book.withPosition).toBe(1);
    expect(node(2)).not.toHaveProperty("lat");
  });

  it("keeps accounts separate", () => {
    recordNodeInfo("default", { num: 1 });
    recordNodeInfo("attic", { num: 2 });
    expect(buildNodeBook("default").nodes.map((n) => n.num)).toEqual([1]);
    expect(buildNodeBook("attic").nodes.map((n) => n.num)).toEqual([2]);
  });

  it("caps the book and evicts the least recently heard node, never self", () => {
    setNodeBookSelf(ACCT, 1);
    recordNodeInfo(ACCT, { num: 1, lastHeard: 0 });
    for (let i = 2; i <= NODE_BOOK_MAX_NODES; i += 1) {
      recordNodeInfo(ACCT, { num: i, lastHeard: 1000 + i });
    }
    recordNodeInfo(ACCT, { num: 999999, lastHeard: 5000 });
    const book = buildNodeBook(ACCT);
    expect(book.totalNodes).toBe(NODE_BOOK_MAX_NODES);
    expect(node(1)).toBeDefined();
    expect(node(2)).toBeUndefined();
    expect(node(999999)).toBeDefined();
  });
});

describe("persistence", () => {
  it("never resolves to the operator's real state dir under vitest", () => {
    expect(nodeBookPath(ACCT).startsWith(join(homedir(), ".openclaw"))).toBe(false);
    expect(nodeBookPath(ACCT)).toMatch(/meshtastic-nodes\.json$/);
    expect(nodeBookPath("attic")).toMatch(/meshtastic-nodes\.attic\.json$/);
  });

  it("throttles writes and flushes them to disk with owner-only permissions", () => {
    vi.useFakeTimers();
    const path = join(dir, "meshtastic-nodes.json");
    setNodeBookPathForTests(path);
    setNodeBookThrottleMsForTests(1000);
    recordNodeInfo(ACCT, { num: 42, user: { longName: "Answer" } });
    expect(readNodeBook(ACCT)).toBeUndefined();
    vi.advanceTimersByTime(1000);
    const file = readNodeBook(ACCT);
    expect(file?.version).toBe(1);
    expect(file?.nodes[0]).toMatchObject({ id: "!0000002a", name: "Answer" });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("flushes pending changes immediately on demand (channel stop)", () => {
    setNodeBookPathForTests(join(dir, "nodes.json"));
    recordNodeInfo(ACCT, { num: 5 });
    flushNodeBookWrites();
    expect(readNodeBook(ACCT)?.totalNodes).toBe(1);
  });
});

describe("subscribeNodeBook", () => {
  function fakeEvents(names: string[]) {
    const handlers: Record<string, (payload: unknown) => void> = {};
    const events: Record<string, unknown> = {};
    for (const name of names) {
      events[name] = {
        subscribe: (fn: (payload: unknown) => void) => {
          handlers[name] = fn;
          return () => delete handlers[name];
        },
      };
    }
    return { events, handlers };
  }

  it("wires every node event the device exposes and returns unsubscribers", () => {
    const { events, handlers } = fakeEvents([
      "onNodeInfoPacket",
      "onUserPacket",
      "onPositionPacket",
      "onMeshPacket",
      "onMyNodeInfo",
    ]);
    const unsubs = subscribeNodeBook(ACCT, events);
    expect(unsubs).toHaveLength(5);
    handlers.onMyNodeInfo({ myNodeNum: 77 });
    handlers.onNodeInfoPacket({ num: 77, user: { longName: "Gateway" } });
    handlers.onPositionPacket({ from: 77, data: { latitudeI: 471369510, longitudeI: 154816690 } });
    expect(node(77)).toMatchObject({ self: true, name: "Gateway", lat: 47.136951 });
    for (const unsub of unsubs) unsub();
    expect(Object.keys(handlers)).toHaveLength(0);
  });

  it("tolerates devices without the node events (older library, test doubles)", () => {
    const { events } = fakeEvents(["onMeshPacket"]);
    expect(subscribeNodeBook(ACCT, events)).toHaveLength(1);
    expect(subscribeNodeBook(ACCT, {})).toHaveLength(0);
  });

  it("never lets a malformed payload throw into the device event loop", () => {
    const { events, handlers } = fakeEvents(["onNodeInfoPacket", "onMeshPacket"]);
    subscribeNodeBook(ACCT, events);
    expect(() => handlers.onNodeInfoPacket(null)).not.toThrow();
    expect(() => handlers.onMeshPacket({ from: "x" })).not.toThrow();
    expect(buildNodeBook(ACCT).totalNodes).toBe(0);
  });
});
