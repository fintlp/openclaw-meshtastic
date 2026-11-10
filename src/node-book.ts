import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Protobuf } from "@meshtastic/core";
import { formatMeshtasticNodeId } from "./normalize.js";
import { pluginStateDir } from "./state-dir.js";
import type { MeshtasticSenderIdentity } from "./types.js";

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
  /** Base64 X25519 public key pinned for this node (issue #7 keybook), when known. */
  publicKey?: string;
  /** Epoch seconds when the pinned key was first observed. */
  keyFirstSeenAt?: number;
  /** True when the operator confirmed this key out-of-band (pkiManuallyVerified). */
  keyManuallyVerified?: boolean;
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
/**
 * Last few evicted entries per account. At cap-saturation during the connect
 * replay, the gateway's own record can be evicted BEFORE onMyNodeInfo marks
 * it as self; the tombstone lets a late setNodeBookSelf resurrect it WITH its
 * names/role/position instead of as a blank entry (re-review finding 1).
 */
const recentEvictions = new Map<string, Array<{ num: number; state: NodeState }>>();
const EVICTION_TOMBSTONE_MAX = 8;

// ---------------------------------------------------------------------------
// Key book (issue #7, phase 1): per-node X25519 public-key pins
// ---------------------------------------------------------------------------
//
// First-seen pinning with continuity that survives restarts AND radio-side
// nodeDB eviction: the firmware forgets and re-learns (a fresh TOFU window on
// the radio); this store does not. Pins are learned from NodeInfo adverts
// (User.public_key) and from the provenance the firmware stamps on decoded
// PKI packets (MeshPacket.public_key). First-seen wins: a later different key
// for the same node number is NEVER adopted silently — it produces a
// structured mismatch record and a distinct log line, and the node degrades
// to "mismatch" until the operator re-pins (pkiRepin) after a legitimate
// rotation. Trust root caveat: every pin ultimately rests on what the
// attached radio's firmware told us — see README "Sender identity".

/** Sources a key observation can arrive from. */
export type NodeKeySource = "nodeinfo" | "user-packet" | "pki-packet";

export type MeshtasticKeyMismatch = {
  accountId: string;
  nodeNum: number;
  /** Node id in Meshtastic notation, e.g. "!a1b2c3d4". */
  nodeId: string;
  /** Fingerprint of the stored first-seen pin (kept). */
  pinnedKeyFp: string;
  /** Fingerprint of the conflicting observed key (rejected). */
  observedKeyFp: string;
  source: NodeKeySource;
  /** Epoch milliseconds. */
  at: number;
};

export type NodeKeyObservation = {
  /** pinned = new first-seen pin; match = continuity confirmed; mismatch = conflict, pin kept. */
  status: "pinned" | "match" | "mismatch";
  /** Fingerprint of the observed key. */
  keyFp: string;
  /** Fingerprint of the stored pin, set on mismatch. */
  pinnedKeyFp?: string;
  /**
   * True when crc32(public key) != the node number. On firmware 2.8+ the node
   * number IS the key's crc32, so an inconsistency is an anomaly there — but
   * pre-2.8 nodes derive numbers from the MAC and legitimately mismatch.
   * Weak signal only, never proof: crc32 is a linear checksum.
   */
  crc32Anomaly: boolean;
};

type KeyPin = {
  num: number;
  /** Base64-encoded 32-byte X25519 public key. */
  publicKey: string;
  /** Epoch seconds. */
  firstSeenAt: number;
  /** Epoch seconds of the last continuity-confirmed observation. */
  lastSeenAt: number;
  manuallyVerified: boolean;
};

type MeshtasticKeyBookFile = {
  version: 1;
  generatedAt: string;
  accountId: string;
  pins: Array<{
    num: number;
    publicKey: string;
    firstSeenAt: number;
    lastSeenAt: number;
    manuallyVerified: boolean;
  }>;
};

/**
 * Generous bound — ten times a healthy mesh. Eviction prefers the
 * least-recently-seen non-verified pin and is sink-logged: a lost pin is a
 * re-opened TOFU window, so it must never happen silently.
 */
export const KEY_BOOK_MAX_PINS = 2000;
const KEY_MISMATCH_MAX_RECORDS = 50;

const keyPins = new Map<string, Map<number, KeyPin>>();
const keyPinsLoaded = new Set<string>();
const keyMismatches = new Map<string, MeshtasticKeyMismatch[]>();
/** Dedupe: only log/save a mismatch when the (node, observed, pinned) triple changes. */
const lastMismatchTriple = new Map<string, string>();
let keyEventSink: ((line: string) => void) | null = null;
let keyTestPath: string | undefined;

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

// ---------------------------------------------------------------------------
// Key book helpers (issue #7)
// ---------------------------------------------------------------------------

/** 32 bytes exactly: X25519 public keys. Anything else is not key material. */
export function meshtasticKeyBytesToBase64(bytes: unknown): string | null {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32) {
    return null;
  }
  return Buffer.from(bytes).toString("base64");
}

function base64ToKeyBytes(b64: string): Uint8Array | null {
  if (typeof b64 !== "string" || b64.length === 0 || b64.length > 64) {
    return null;
  }
  const buf = Buffer.from(b64, "base64");
  return buf.length === 32 ? new Uint8Array(buf) : null;
}

/** Short key fingerprint for logs/annotations — full keys are never logged. */
export function meshtasticKeyFingerprint(keyBytes: Uint8Array): string {
  return createHash("sha256").update(keyBytes).digest("hex").slice(0, 12);
}

// CRC-32 (IEEE 802.3, reflected — the zlib layout). Firmware 2.8+ derives the
// node number as crc32(public_key); used here ONLY as a weak anomaly signal,
// never as proof of anything (linear checksum, trivial preimage).
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32ForNodeKey(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function bookFor(accountId: string): Map<number, NodeState> {
  let book = books.get(accountId);
  if (!book) {
    book = new Map();
    books.set(accountId, book);
  }
  return book;
}

/** Evict the least-recently-heard node that is not this account's self node. */
function evictOldestNonSelf(book: Map<number, NodeState>, accountId: string): boolean {
  let oldestNum: number | null = null;
  let oldestHeard = Number.POSITIVE_INFINITY;
  const self = selfNums.get(accountId);
  for (const [n, s] of book) {
    if (n !== self && s.lastHeard < oldestHeard) {
      oldestHeard = s.lastHeard;
      oldestNum = n;
    }
  }
  if (oldestNum === null) {
    return false;
  }
  const tombstones = recentEvictions.get(accountId) ?? [];
  tombstones.push({ num: oldestNum, state: book.get(oldestNum)! });
  if (tombstones.length > EVICTION_TOMBSTONE_MAX) {
    tombstones.shift();
  }
  recentEvictions.set(accountId, tombstones);
  book.delete(oldestNum);
  return true;
}

function upsert(accountId: string, num: number): NodeState | null {
  const book = bookFor(accountId);
  const existing = book.get(num);
  if (existing) {
    return existing;
  }
  if (book.size >= NODE_BOOK_MAX_NODES) {
    // Evict the least recently heard node to make room.
    if (!evictOldestNonSelf(book, accountId)) {
      return null;
    }
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
    // Truncate by code point, never UTF-16 code unit: a lone surrogate in
    // stored JSON serializes as an ill-formed \uD8xx escape — and a stored
    // node name can boomerang back onto the mesh inside an agent reply.
    state.longName = [...u.longName].slice(0, 64).join("");
  }
  if (typeof u.shortName === "string" && u.shortName) {
    state.shortName = [...u.shortName].slice(0, 8).join("");
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
  observeAdvertKey(accountId, n.num, n.user, "nodeinfo");
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
  observeAdvertKey(accountId, p.from, p.data, "user-packet");
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
  if (!validNodeNum(num)) {
    return;
  }
  selfNums.set(accountId, num);
  const book = bookFor(accountId);
  if (!book.has(num)) {
    // The gateway's own NodeInfo record arrives via the ordinary replay path
    // and never "hears" itself, so its lastHeard stays 0 — the prime LRU
    // victim if a cap-triggered eviction fires before onMyNodeInfo registers
    // it as self. Resurrect a minimal protected entry so "never evicts self"
    // holds regardless of event order; the next NodeInfo replay refills
    // names/role/position. (PR #16 review, finding 1.)
    if (book.size >= NODE_BOOK_MAX_NODES) {
      evictOldestNonSelf(book, accountId);
    }
    // Restore rich data if this num was evicted moments ago (the replay race);
    // otherwise a minimal entry — the next reconnect replay refills the rest.
    const tombstones = recentEvictions.get(accountId) ?? [];
    const tombstoneIdx = tombstones.findIndex((t) => t.num === num);
    const tombstone = tombstoneIdx >= 0 ? tombstones.splice(tombstoneIdx, 1)[0] : undefined;
    book.set(num, tombstone ? { ...tombstone.state } : {
      num,
      longName: "",
      shortName: "",
      role: null,
      hwModel: null,
      lastHeard: 0,
      viaMqtt: false,
    });
  }
  markChanged(accountId);
}

// ---------------------------------------------------------------------------
// Key book core (issue #7)
// ---------------------------------------------------------------------------

function pinsFor(accountId: string): Map<number, KeyPin> {
  let pins = keyPins.get(accountId);
  if (!pins) {
    pins = new Map();
    keyPins.set(accountId, pins);
  }
  if (!keyPinsLoaded.has(accountId)) {
    keyPinsLoaded.add(accountId);
    for (const pin of readKeyBookPins(accountId)) {
      if (!pins.has(pin.num)) {
        pins.set(pin.num, pin);
      }
    }
  }
  return pins;
}

function emitKeyEvent(line: string): void {
  try {
    keyEventSink?.(line);
  } catch {
    // a broken sink must never break inbound handling
  }
}

export function formatKeyMismatchLine(m: MeshtasticKeyMismatch): string {
  return (
    `[${m.accountId}] pki key mismatch for ${m.nodeId}: observed fp=${m.observedKeyFp} ` +
    `conflicts with pinned fp=${m.pinnedKeyFp} (source: ${m.source}) — keeping first-seen pin; ` +
    `re-pin via channels.meshtastic.pkiRepin after a legitimate rotation`
  );
}

function recordMismatch(m: MeshtasticKeyMismatch): void {
  const triple = `${m.nodeNum}:${m.observedKeyFp}:${m.pinnedKeyFp}`;
  if (lastMismatchTriple.get(m.accountId) === triple) {
    // Same conflict seen again — the grade still degrades per message, but the
    // operator log is not re-spammed with the identical record.
    return;
  }
  lastMismatchTriple.set(m.accountId, triple);
  const list = keyMismatches.get(m.accountId) ?? [];
  list.push(m);
  if (list.length > KEY_MISMATCH_MAX_RECORDS) {
    list.shift();
  }
  keyMismatches.set(m.accountId, list);
  emitKeyEvent(formatKeyMismatchLine(m));
}

/** Recent structured key-mismatch records (bounded ring; newest last). */
export function recentKeyMismatches(accountId: string): MeshtasticKeyMismatch[] {
  return [...(keyMismatches.get(accountId) ?? [])];
}

/**
 * Distinct-line sink for key events (mismatches, pin evictions). The monitor
 * installs a console.log-backed sink so the lines reach the Gateway log; full
 * keys are never included, fingerprints only.
 */
export function setKeyEventSink(sink: ((line: string) => void) | null): void {
  keyEventSink = sink;
}

function evictPinIfNeeded(accountId: string, pins: Map<number, KeyPin>): void {
  if (pins.size < KEY_BOOK_MAX_PINS) {
    return;
  }
  let candidate: KeyPin | null = null;
  for (const pin of pins.values()) {
    if (pin.manuallyVerified) {
      continue;
    }
    if (!candidate || pin.lastSeenAt < candidate.lastSeenAt) {
      candidate = pin;
    }
  }
  if (!candidate) {
    for (const pin of pins.values()) {
      if (!candidate || pin.lastSeenAt < candidate.lastSeenAt) {
        candidate = pin;
      }
    }
  }
  if (candidate) {
    pins.delete(candidate.num);
    emitKeyEvent(
      `[${accountId}] pki pin store full — evicted pin for ${formatMeshtasticNodeId(candidate.num)} ` +
        `(least recently seen); its next contact re-pins (TOFU window)`,
    );
  }
}

/**
 * First-seen pinning for observed node keys. Returns the continuity verdict
 * for THIS observation; the stored pin is never overwritten by a conflict.
 * Invalid node numbers and non-32-byte keys are ignored (null).
 */
export function observeNodeKey(
  accountId: string,
  num: number,
  publicKey: string,
  source: NodeKeySource,
): NodeKeyObservation | null {
  if (!validNodeNum(num)) {
    return null;
  }
  const keyBytes = base64ToKeyBytes(publicKey);
  if (!keyBytes) {
    return null;
  }
  const pins = pinsFor(accountId);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const keyFp = meshtasticKeyFingerprint(keyBytes);
  const crc32Anomaly = crc32ForNodeKey(keyBytes) !== num >>> 0;

  const existing = pins.get(num);
  if (!existing) {
    evictPinIfNeeded(accountId, pins);
    pins.set(num, {
      num,
      publicKey,
      firstSeenAt: nowSeconds,
      lastSeenAt: nowSeconds,
      manuallyVerified: false,
    });
    markChanged(accountId);
    return { status: "pinned", keyFp, crc32Anomaly };
  }
  if (existing.publicKey === publicKey) {
    // Refresh lastSeenAt coarsely — a precision finer than 5 min is not worth
    // a file write on every packet.
    if (nowSeconds - existing.lastSeenAt > 300) {
      existing.lastSeenAt = nowSeconds;
      markChanged(accountId);
    }
    return { status: "match", keyFp, crc32Anomaly };
  }
  const pinnedBytes = base64ToKeyBytes(existing.publicKey);
  const pinnedKeyFp = pinnedBytes ? meshtasticKeyFingerprint(pinnedBytes) : "unknown";
  recordMismatch({
    accountId,
    nodeNum: num,
    nodeId: formatMeshtasticNodeId(num),
    pinnedKeyFp,
    observedKeyFp: keyFp,
    source,
    at: Date.now(),
  });
  return { status: "mismatch", keyFp, pinnedKeyFp, crc32Anomaly };
}

/** Extract and pin User.public_key from a NodeInfo/User advert. */
function observeAdvertKey(
  accountId: string,
  num: number,
  user: unknown,
  source: NodeKeySource,
): void {
  if (!user || typeof user !== "object") {
    return;
  }
  const b64 = meshtasticKeyBytesToBase64((user as Record<string, unknown>).publicKey);
  if (b64) {
    observeNodeKey(accountId, num, b64, source);
  }
  // Note: User.is_key_manually_verified (field 12) does not exist in the
  // pinned @meshtastic/core 2.6.7 schema, so operator verification is set via
  // the pkiManuallyVerified config list instead of read from adverts.
}

/**
 * Operator re-pin (rotation remediation): clear the stored pin so the node's
 * next observed key re-pins. Returns the cleared pin's fingerprint, or null
 * when no pin existed. Deliberate, explicit, and logged by the caller.
 */
export function clearNodeKeyPin(accountId: string, num: number): string | null {
  if (!validNodeNum(num)) {
    return null;
  }
  const pins = pinsFor(accountId);
  const existing = pins.get(num);
  if (!existing) {
    return null;
  }
  pins.delete(num);
  lastMismatchTriple.delete(accountId);
  const bytes = base64ToKeyBytes(existing.publicKey);
  markChanged(accountId);
  return bytes ? meshtasticKeyFingerprint(bytes) : "unknown";
}

/** Operator manual verification: mark the pinned key as out-of-band confirmed. */
export function markNodeKeyManuallyVerified(accountId: string, num: number): boolean {
  if (!validNodeNum(num)) {
    return false;
  }
  const pins = pinsFor(accountId);
  const existing = pins.get(num);
  if (!existing || existing.manuallyVerified) {
    return false;
  }
  existing.manuallyVerified = true;
  markChanged(accountId);
  return true;
}

/** Current pin for a node, when one exists (surfaced for tests/tools). */
export function getNodeKeyPin(
  accountId: string,
  num: number,
): { publicKey: string; firstSeenAt: number; manuallyVerified: boolean } | null {
  const pin = pinsFor(accountId).get(num);
  if (!pin) {
    return null;
  }
  return {
    publicKey: pin.publicKey,
    firstSeenAt: pin.firstSeenAt,
    manuallyVerified: pin.manuallyVerified,
  };
}

/**
 * Map a key observation to the envelope sender-identity annotation. The
 * mismatch grade NEVER verifies; first-seen pins verify with an explicit
 * TOFU detail so consumers can tell continuity apart from first contact.
 */
export function senderIdentityFromObservation(obs: NodeKeyObservation): MeshtasticSenderIdentity {
  const crcNote = obs.crc32Anomaly
    ? "node number is not the key's crc32 (pre-2.8 node or anomaly)"
    : undefined;
  if (obs.status === "mismatch") {
    return {
      grade: "mismatch",
      keyFp: obs.keyFp,
      detail: `key changed (pinned fp=${obs.pinnedKeyFp ?? "unknown"}) — admitted unverified`,
    };
  }
  if (obs.status === "pinned") {
    return {
      grade: "pki-verified",
      keyFp: obs.keyFp,
      detail: crcNote ? `first-seen pin (TOFU); ${crcNote}` : "first-seen pin (TOFU)",
    };
  }
  return { grade: "pki-verified", keyFp: obs.keyFp, ...(crcNote ? { detail: crcNote } : {}) };
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
    // Key pins live in their own store (they must survive name-book
    // eviction); surface them onto the record for the operator-facing file.
    const pin = pinsFor(accountId).get(state.num);
    if (pin) {
      record.publicKey = pin.publicKey;
      record.keyFirstSeenAt = pin.firstSeenAt;
      if (pin.manuallyVerified) {
        record.keyManuallyVerified = true;
      }
    }
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

export function keyBookPath(accountId: string): string {
  if (keyTestPath) {
    return keyTestPath;
  }
  const base = `${pluginStateDir()}/meshtastic-keys`;
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

export function writeKeyBook(accountId: string): void {
  const path = keyBookPath(accountId);
  const tmp = `${path}.tmp`;
  const pins = [...pinsFor(accountId).values()]
    .sort((a, b) => a.num - b.num)
    .map((pin) => ({
      num: pin.num,
      publicKey: pin.publicKey,
      firstSeenAt: pin.firstSeenAt,
      lastSeenAt: pin.lastSeenAt,
      manuallyVerified: pin.manuallyVerified,
    }));
  const file: MeshtasticKeyBookFile = {
    version: 1,
    generatedAt: new Date().toISOString(),
    accountId,
    pins,
  };
  mkdirSync(dirname(path), { recursive: true });
  // 0600: public keys are not secrets, but this file is the trust anchor for
  // sender identity — it must not be casually rewritable.
  writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/** Load and validate pins from disk; corrupt files/entries yield nothing. */
function readKeyBookPins(accountId: string): KeyPin[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(keyBookPath(accountId), "utf8"));
  } catch {
    return [];
  }
  const raw = (parsed as { pins?: unknown } | null)?.pins;
  if (!Array.isArray(raw)) {
    return [];
  }
  const pins: KeyPin[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (!validNodeNum(e.num)) continue;
    const keyBytes = typeof e.publicKey === "string" ? base64ToKeyBytes(e.publicKey) : null;
    if (!keyBytes) continue;
    pins.push({
      num: e.num,
      publicKey: e.publicKey as string,
      firstSeenAt: finite(e.firstSeenAt) && e.firstSeenAt > 0 ? e.firstSeenAt : 0,
      lastSeenAt: finite(e.lastSeenAt) && e.lastSeenAt > 0 ? e.lastSeenAt : 0,
      manuallyVerified: e.manuallyVerified === true,
    });
  }
  return pins;
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
    try {
      writeKeyBook(accountId);
    } catch {
      // best-effort: same rule — persistence must never take the channel down
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
export function setKeyBookPathForTests(path: string | undefined): void {
  keyTestPath = path;
}

/** @internal */
export function setNodeBookThrottleMsForTests(ms: number): void {
  throttleMs = ms;
}

/** @internal Clears in-memory state; does not delete any file. */
export function resetNodeBookForTests(): void {
  books.clear();
  selfNums.clear();
  recentEvictions.clear();
  keyPins.clear();
  keyPinsLoaded.clear();
  keyMismatches.clear();
  lastMismatchTriple.clear();
  keyEventSink = null;
  keyTestPath = undefined;
  pending.clear();
  if (throttleTimer) {
    clearTimeout(throttleTimer);
    throttleTimer = null;
  }
  testPath = undefined;
  throttleMs = DEFAULT_THROTTLE_MS;
}
