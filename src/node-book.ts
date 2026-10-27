import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Protobuf } from "@meshtastic/core";
import { formatMeshtasticNodeId } from "./normalize.js";
import { pluginStateDir } from "./state-dir.js";

/**
 * Agent-readable node book (#15): every node the radio knows, with names,
 * role, hardware and last known position. Zero airtime: filled passively
 * from the node database the radio replays on connect and from live packets.
 *
 * Persisted per account: the default account uses `meshtastic-nodes.json`,
 * named accounts `meshtastic-nodes.<accountId>.json`. Writes are throttled
 * (default 60 s) and flushed on channel stop.
 *
 * Timestamp rule: `lastHeard` only ever comes from the radio's own NodeInfo
 * value or from a live MeshPacket's rxTime. The library stamps the replayed
 * position and user events with the current time, so those are never used as
 * "heard" evidence.
 */
export type MeshtasticNodeRecord = {
  /** Node id in Meshtastic notation, e.g. "!a1b2c3d4". */
  id: string;
  /** Node number (the 32-bit address). */
  num: number;
  /** Long name, falling back to short name, then the id. */
  name: string;
  shortName: string;
  /** Device role (client, router, repeater, ...), lower-case; null if unknown. */
  role: string | null;
  /** Hardware model name, e.g. "heltec_v3"; null if unknown. */
  hwModel: string | null;
  /** True for the node this gateway is connected to. */
  self: boolean;
  /** Decimal degrees; absent when the node has shared no position. */
  lat?: number;
  lon?: number;
  /** Metres above mean sea level, when reported. */
  altitude?: number;
  /** Epoch seconds from the node's own clock when the position was taken, if set. */
  positionTime?: number;
  /** 32 = full precision; lower values mean the channel deliberately coarsened it. */
  precisionBits?: number;
  /** Epoch seconds the radio last heard this node; 0 when unknown. */
  lastHeard: number;
  /** SNR of the last packet heard from this node, in dB. */
  snr?: number;
  /** Hops between this gateway and the node, when known. */
  hopsAway?: number;
  /** True when the node was only heard via MQTT, not over the air. */
  viaMqtt: boolean;
};

export type MeshtasticNodeBookFile = {
  version: 1;
  /** ISO 8601 timestamp when the file was written. */
  generatedAt: string;
  accountId: string;
  /** Id of this gateway's own node, when known. */
  selfId: string | null;
  totalNodes: number;
  withPosition: number;
  /** Most recently heard first. */
  nodes: MeshtasticNodeRecord[];
};

/** Bounded so a large mesh (or a hostile flood of node numbers) cannot grow the file without limit. */
export const NODE_BOOK_MAX_NODES = 500;
const DEFAULT_THROTTLE_MS = 60_000;

type NodeState = Omit<MeshtasticNodeRecord, "id" | "name" | "self"> & { longName: string };

const books = new Map<string, Map<number, NodeState>>();
const selfNums = new Map<string, number>();

let testPath: string | undefined;
let throttleMs = DEFAULT_THROTTLE_MS;
let throttleTimer: ReturnType<typeof setTimeout> | null = null;
const pending = new Set<string>();

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Enum number -> lower-case name. A number the pinned library does not know
 * yet (newer hardware, e.g. the Heltec V4 in @meshtastic/core 2.6.7) becomes
 * `<prefix>_<n>` instead of being dropped.
 */
function enumName(table: unknown, value: unknown, prefix: string, unsetIsZero: boolean): string | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return null;
  }
  if (unsetIsZero && value === 0) {
    return null;
  }
  const name = table && typeof table === "object" ? (table as Record<number, unknown>)[value] : undefined;
  return typeof name === "string" ? name.toLowerCase() : `${prefix}_${value}`;
}

function roleName(role: unknown): string | null {
  // Role 0 is CLIENT (a real role), not "unset".
  const config = (Protobuf as unknown as { Config?: { Config_DeviceConfig_Role?: unknown } }).Config;
  return enumName(config?.Config_DeviceConfig_Role, role, "role", false);
}

function hwModelName(model: unknown): string | null {
  // HardwareModel 0 is UNSET.
  const mesh = (Protobuf as unknown as { Mesh?: { HardwareModel?: unknown } }).Mesh;
  return enumName(mesh?.HardwareModel, model, "model", true);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Position protobuf -> decimal degrees. `latitudeI`/`longitudeI` are degrees
 * x 1e7. (0, 0) and out-of-range values mean "no position".
 */
export type DecodedPosition = {
  lat: number;
  lon: number;
  altitude?: number;
  positionTime?: number;
  precisionBits?: number;
};

export function decodePosition(position: unknown): DecodedPosition | null {
  if (!position || typeof position !== "object") {
    return null;
  }
  const p = position as Record<string, unknown>;
  if (!finite(p.latitudeI) || !finite(p.longitudeI)) {
    return null;
  }
  if (p.latitudeI === 0 && p.longitudeI === 0) {
    return null;
  }
  const lat = Math.round(p.latitudeI) / 1e7;
  const lon = Math.round(p.longitudeI) / 1e7;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return null;
  }
  const out: DecodedPosition = { lat, lon };
  if (finite(p.altitude) && p.altitude !== 0) out.altitude = p.altitude;
  if (finite(p.time) && p.time > 0) out.positionTime = p.time;
  if (finite(p.precisionBits) && p.precisionBits > 0) out.precisionBits = p.precisionBits;
  return out;
}

function validNodeNum(num: unknown): num is number {
  // 0 is unset; 0xFFFFFFFF is the broadcast address, never a real node.
  return finite(num) && Number.isInteger(num) && num > 0 && num < 0xffffffff;
}

function bookFor(accountId: string): Map<number, NodeState> {
  let book = books.get(accountId);
  if (!book) {
    book = new Map();
    books.set(accountId, book);
  }
  return book;
}

function upsert(accountId: string, num: number): NodeState | null {
  const book = bookFor(accountId);
  const existing = book.get(num);
  if (existing) {
    return existing;
  }
  if (book.size >= NODE_BOOK_MAX_NODES) {
    // Evict the least recently heard node to make room.
    let oldestNum: number | null = null;
    let oldestHeard = Number.POSITIVE_INFINITY;
    for (const [n, s] of book) {
      if (n !== selfNums.get(accountId) && s.lastHeard < oldestHeard) {
        oldestHeard = s.lastHeard;
        oldestNum = n;
      }
    }
    if (oldestNum === null) {
      return null;
    }
    book.delete(oldestNum);
  }
  const fresh: NodeState = {
    num,
    longName: "",
    shortName: "",
    role: null,
    hwModel: null,
    lastHeard: 0,
    viaMqtt: false,
  };
  book.set(num, fresh);
  return fresh;
}

function applyUser(state: NodeState, user: unknown): void {
  if (!user || typeof user !== "object") {
    return;
  }
  const u = user as Record<string, unknown>;
  if (typeof u.longName === "string" && u.longName) {
    state.longName = u.longName.slice(0, 64);
  }
  if (typeof u.shortName === "string" && u.shortName) {
    state.shortName = u.shortName.slice(0, 8);
  }
  const role = roleName(u.role);
  if (role) state.role = role;
  const hw = hwModelName(u.hwModel);
  if (hw) state.hwModel = hw;
}

function applyPosition(state: NodeState, position: unknown): boolean {
  const decoded = decodePosition(position);
  if (!decoded) {
    return false;
  }
  // Never let an older position (by the node's own clock) overwrite a newer one.
  if (
    decoded.positionTime !== undefined &&
    state.positionTime !== undefined &&
    decoded.positionTime < state.positionTime
  ) {
    return false;
  }
  state.lat = decoded.lat;
  state.lon = decoded.lon;
  state.altitude = decoded.altitude;
  state.positionTime = decoded.positionTime;
  state.precisionBits = decoded.precisionBits;
  return true;
}

function markChanged(accountId: string): void {
  pending.add(accountId);
  if (throttleTimer) {
    return;
  }
  throttleTimer = setTimeout(flushNodeBookWrites, throttleMs);
  throttleTimer.unref?.();
}

// ---------------------------------------------------------------------------
// Event handlers (exported for tests; wired by subscribeNodeBook)
// ---------------------------------------------------------------------------

/** FromRadio NodeInfo: the radio's node database, replayed on every connect. */
export function recordNodeInfo(accountId: string, info: unknown): void {
  if (!info || typeof info !== "object") return;
  const n = info as Record<string, unknown>;
  if (!validNodeNum(n.num)) return;
  const state = upsert(accountId, n.num);
  if (!state) return;
  applyUser(state, n.user);
  applyPosition(state, n.position);
  if (finite(n.lastHeard) && n.lastHeard > state.lastHeard) state.lastHeard = n.lastHeard;
  if (finite(n.snr) && n.snr !== 0) state.snr = n.snr;
  if (finite(n.hopsAway)) state.hopsAway = n.hopsAway;
  if (typeof n.viaMqtt === "boolean") state.viaMqtt = n.viaMqtt;
  markChanged(accountId);
}

/** PacketMetadata<User>. rxTime is ignored: on replay it is "now". */
export function recordUser(accountId: string, packet: unknown): void {
  if (!packet || typeof packet !== "object") return;
  const p = packet as Record<string, unknown>;
  if (!validNodeNum(p.from)) return;
  const state = upsert(accountId, p.from);
  if (!state) return;
  applyUser(state, p.data);
  markChanged(accountId);
}

/** PacketMetadata<Position>. rxTime is ignored: on replay it is "now". */
export function recordPosition(accountId: string, packet: unknown): void {
  if (!packet || typeof packet !== "object") return;
  const p = packet as Record<string, unknown>;
  if (!validNodeNum(p.from)) return;
  if (!decodePosition(p.data)) return; // no node entry just for an empty position
  const state = upsert(accountId, p.from);
  if (!state) return;
  if (applyPosition(state, p.data)) markChanged(accountId);
}

/**
 * Raw MeshPacket (live traffic only; the connect replay never emits these).
 * The only source of fresh "heard" evidence between connects.
 */
export function recordMeshPacket(accountId: string, packet: unknown, nowSeconds?: number): void {
  if (!packet || typeof packet !== "object") return;
  const p = packet as Record<string, unknown>;
  if (!validNodeNum(p.from)) return;
  const state = upsert(accountId, p.from);
  if (!state) return;
  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  const rx = finite(p.rxTime) && p.rxTime > 0 ? p.rxTime : now;
  // A node clock far in the future must not pin the entry as "heard forever".
  const heard = Math.min(rx, now + 300);
  if (heard > state.lastHeard) state.lastHeard = heard;
  if (finite(p.rxSnr) && p.rxSnr !== 0) state.snr = p.rxSnr;
  if (finite(p.hopStart) && finite(p.hopLimit) && p.hopStart > 0 && p.hopStart >= p.hopLimit) {
    state.hopsAway = p.hopStart - p.hopLimit;
  }
  if (typeof p.viaMqtt === "boolean") state.viaMqtt = p.viaMqtt;
  markChanged(accountId);
}

/** Remember which node number is this gateway's own radio. */
export function setNodeBookSelf(accountId: string, num: number | null | undefined): void {
  if (validNodeNum(num)) {
    selfNums.set(accountId, num);
    markChanged(accountId);
  }
}

// ---------------------------------------------------------------------------
// Snapshot + persistence
// ---------------------------------------------------------------------------

export function buildNodeBook(accountId: string): MeshtasticNodeBookFile {
  const self = selfNums.get(accountId);
  const nodes: MeshtasticNodeRecord[] = [];
  for (const state of bookFor(accountId).values()) {
    const id = formatMeshtasticNodeId(state.num);
    const record: MeshtasticNodeRecord = {
      id,
      num: state.num,
      name: state.longName || state.shortName || id,
      shortName: state.shortName,
      role: state.role,
      hwModel: state.hwModel,
      self: state.num === self,
      lastHeard: state.lastHeard,
      viaMqtt: state.viaMqtt,
    };
    if (state.lat !== undefined && state.lon !== undefined) {
      record.lat = state.lat;
      record.lon = state.lon;
      if (state.altitude !== undefined) record.altitude = state.altitude;
      if (state.positionTime !== undefined) record.positionTime = state.positionTime;
      if (state.precisionBits !== undefined) record.precisionBits = state.precisionBits;
    }
    if (state.snr !== undefined) record.snr = state.snr;
    if (state.hopsAway !== undefined) record.hopsAway = state.hopsAway;
    nodes.push(record);
  }
  nodes.sort((a, b) => Number(b.self) - Number(a.self) || b.lastHeard - a.lastHeard || a.num - b.num);
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    accountId,
    selfId: self !== undefined ? formatMeshtasticNodeId(self) : null,
    totalNodes: nodes.length,
    withPosition: nodes.filter((n) => n.lat !== undefined).length,
    nodes,
  };
}

export function nodeBookPath(accountId: string): string {
  if (testPath) {
    return testPath;
  }
  const base = `${pluginStateDir()}/meshtastic-nodes`;
  return accountId && accountId !== "default" ? `${base}.${accountId}.json` : `${base}.json`;
}

export function writeNodeBook(accountId: string): void {
  const path = nodeBookPath(accountId);
  const tmp = `${path}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  // 0600: the file holds other people's positions.
  writeFileSync(tmp, `${JSON.stringify(buildNodeBook(accountId), null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

export function readNodeBook(accountId: string): MeshtasticNodeBookFile | undefined {
  try {
    return JSON.parse(readFileSync(nodeBookPath(accountId), "utf8")) as MeshtasticNodeBookFile;
  } catch {
    return undefined;
  }
}

/** Write every account with pending changes now. Safe to call anytime. */
export function flushNodeBookWrites(): void {
  if (throttleTimer) {
    clearTimeout(throttleTimer);
    throttleTimer = null;
  }
  for (const accountId of pending) {
    try {
      writeNodeBook(accountId);
    } catch {
      // best-effort: a failed write must not break other accounts or the channel
    }
  }
  pending.clear();
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

type Subscribable = { subscribe?: (fn: (payload: never) => void) => (() => void) | void };

/**
 * Subscribe the node book to a device's events. Subscribes only to events the
 * device actually exposes, so a library rename or a test double without them
 * degrades to "no node book" instead of a crash. Returns unsubscribe callbacks.
 */
export function subscribeNodeBook(
  accountId: string,
  events: Record<string, unknown>,
): Array<() => void> {
  const unsubscribers: Array<() => void> = [];
  const hook = (name: string, handler: (payload: unknown) => void) => {
    const event = events[name] as Subscribable | undefined;
    if (typeof event?.subscribe !== "function") {
      return;
    }
    const unsubscribe = event.subscribe((payload: never) => {
      try {
        handler(payload);
      } catch {
        // the node book must never break inbound message handling
      }
    });
    if (typeof unsubscribe === "function") {
      unsubscribers.push(unsubscribe);
    }
  };
  hook("onNodeInfoPacket", (p) => recordNodeInfo(accountId, p));
  hook("onUserPacket", (p) => recordUser(accountId, p));
  hook("onPositionPacket", (p) => recordPosition(accountId, p));
  hook("onMeshPacket", (p) => recordMeshPacket(accountId, p));
  hook("onMyNodeInfo", (p) =>
    setNodeBookSelf(accountId, (p as { myNodeNum?: number } | undefined)?.myNodeNum),
  );
  return unsubscribers;
}

// ---------------------------------------------------------------------------
// Test hooks
// ---------------------------------------------------------------------------

/** @internal */
export function setNodeBookPathForTests(path: string | undefined): void {
  testPath = path;
}

/** @internal */
export function setNodeBookThrottleMsForTests(ms: number): void {
  throttleMs = ms;
}

/** @internal Clears in-memory state; does not delete any file. */
export function resetNodeBookForTests(): void {
  books.clear();
  selfNums.clear();
  pending.clear();
  if (throttleTimer) {
    clearTimeout(throttleTimer);
    throttleTimer = null;
  }
  testPath = undefined;
  throttleMs = DEFAULT_THROTTLE_MS;
}
