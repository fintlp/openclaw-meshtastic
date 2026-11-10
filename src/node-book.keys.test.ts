import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  KEY_BOOK_MAX_PINS,
  NODE_BOOK_MAX_NODES,
  buildNodeBook,
  clearNodeKeyPin,
  crc32ForNodeKey,
  flushNodeBookWrites,
  getKeyTombstone,
  getNodeKeyPin,
  getRepinMarker,
  markNodeKeyManuallyVerified,
  meshtasticKeyBytesToBase64,
  meshtasticKeyFingerprint,
  observeNodeKey,
  pruneRepinMarkers,
  readNodeBook,
  recentKeyMismatches,
  recordNodeInfo,
  recordUser,
  resetNodeBookForTests,
  senderIdentityFromObservation,
  setKeyBookPathForTests,
  setRepinMarker,
  setKeyEventSink,
  setNodeBookPathForTests,
  writeKeyBook,
} from "./node-book.js";

// Keybook (issue #7 phase 1): first-seen pinning, mismatch records, crc32
// anomaly signal, persistence across restart, and the operator re-pin path.
// Fixtures use generic node numbers (!00000002 style) and synthetic 32-byte
// keys — no real keys, coordinates, or hostnames.

const ACCT = "default";

/** 32-byte synthetic key filled with a marker byte. */
function key(marker: number): Uint8Array {
  return new Uint8Array(32).fill(marker);
}
function b64(marker: number): string {
  return Buffer.from(key(marker)).toString("base64");
}

/** A node number that IS crc32-consistent with the given key (2.8+ binding). */
function consistentNum(marker: number): number {
  const num = crc32ForNodeKey(key(marker));
  if (num === 0 || num === 0xffffffff) {
    throw new Error("fixture collision: pick another marker");
  }
  return num;
}

let dir: string;

beforeEach(() => {
  resetNodeBookForTests();
  dir = mkdtempSync(join(tmpdir(), "meshtastic-keybook-"));
  setNodeBookPathForTests(join(dir, "meshtastic-nodes.json"));
  setKeyBookPathForTests(join(dir, "meshtastic-keys.json"));
});

afterEach(() => {
  resetNodeBookForTests();
  rmSync(dir, { recursive: true, force: true });
});

describe("key fixtures", () => {
  it("accepts exactly-32-byte keys and rejects everything else", () => {
    expect(meshtasticKeyBytesToBase64(key(0x11))).toBe(b64(0x11));
    expect(meshtasticKeyBytesToBase64(new Uint8Array(31))).toBeNull();
    expect(meshtasticKeyBytesToBase64(new Uint8Array(33))).toBeNull();
    expect(meshtasticKeyBytesToBase64(new Uint8Array(0))).toBeNull();
    expect(meshtasticKeyBytesToBase64("not-bytes")).toBeNull();
    expect(meshtasticKeyBytesToBase64(undefined)).toBeNull();
  });

  it("fingerprints are stable, short, and key-dependent", () => {
    const fpA = meshtasticKeyFingerprint(key(0x11));
    const fpB = meshtasticKeyFingerprint(key(0x22));
    expect(fpA).toMatch(/^[0-9a-f]{12}$/);
    expect(fpA).not.toBe(fpB);
    expect(meshtasticKeyFingerprint(key(0x11))).toBe(fpA);
  });

  it('crc32ForNodeKey matches the known IEEE vector (123456789 -> 0xCBF43926)', () => {
    // Standard CRC-32 check value pins the polynomial/reflect layout — the
    // same layout firmware uses for the 2.8+ number==crc32(key) binding.
    expect(crc32ForNodeKey(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });
});

describe("first-seen pinning from adverts", () => {
  it("pins User.public_key from a NodeInfo record and surfaces it in the book", () => {
    recordNodeInfo(ACCT, {
      num: 0x0a0b0c0d,
      user: { longName: "Fixture Node", publicKey: key(0x11) },
    });
    const pin = getNodeKeyPin(ACCT, 0x0a0b0c0d);
    expect(pin?.publicKey).toBe(b64(0x11));
    expect(pin?.firstSeenAt).toBeGreaterThan(0);
    expect(pin?.manuallyVerified).toBe(false);
    const record = buildNodeBook(ACCT).nodes.find((n) => n.num === 0x0a0b0c0d);
    expect(record?.publicKey).toBe(b64(0x11));
    expect(record?.keyFirstSeenAt).toBe(pin?.firstSeenAt);
  });

  it("pins User.public_key from a live user packet", () => {
    recordUser(ACCT, { from: 0x0a0b0c0d, data: { longName: "Live", publicKey: key(0x33) } });
    expect(getNodeKeyPin(ACCT, 0x0a0b0c0d)?.publicKey).toBe(b64(0x33));
  });

  it("ignores adverts without key material without error (keyless nodes)", () => {
    recordNodeInfo(ACCT, { num: 0x0a0b0c0d, user: { longName: "No Key" } });
    recordNodeInfo(ACCT, { num: 0x0a0b0c0e, user: { publicKey: new Uint8Array(4) } });
    expect(getNodeKeyPin(ACCT, 0x0a0b0c0d)).toBeNull();
    expect(getNodeKeyPin(ACCT, 0x0a0b0c0e)).toBeNull();
    expect(buildNodeBook(ACCT).totalNodes).toBe(2);
  });
});

describe("observeNodeKey continuity", () => {
  it("pinned -> match -> mismatch, and the pin never moves", () => {
    const num = 0x0a0b0c0d;
    const first = observeNodeKey(ACCT, num, b64(0x11), "pki-packet");
    expect(first?.status).toBe("pinned");
    const second = observeNodeKey(ACCT, num, b64(0x11), "pki-packet");
    expect(second?.status).toBe("match");
    expect(second?.keyFp).toBe(first?.keyFp);
    const flip = observeNodeKey(ACCT, num, b64(0x22), "pki-packet");
    expect(flip?.status).toBe("mismatch");
    expect(flip?.pinnedKeyFp).toBe(first?.keyFp);
    // The stored pin is still the first-seen key.
    expect(getNodeKeyPin(ACCT, num)?.publicKey).toBe(b64(0x11));
    // And it never auto-heals: repeated sightings stay mismatch.
    expect(observeNodeKey(ACCT, num, b64(0x22), "pki-packet")?.status).toBe("mismatch");
  });

  it("rejects invalid node numbers and non-key material", () => {
    expect(observeNodeKey(ACCT, 0, b64(0x11), "pki-packet")).toBeNull();
    expect(observeNodeKey(ACCT, 0xffffffff, b64(0x11), "pki-packet")).toBeNull();
    expect(observeNodeKey(ACCT, 7, "not-base64!!!", "pki-packet")).toBeNull();
    expect(observeNodeKey(ACCT, 7, Buffer.from(new Uint8Array(8)).toString("base64"), "pki-packet")).toBeNull();
    expect(getNodeKeyPin(ACCT, 7)).toBeNull();
  });
});

describe("mismatch records", () => {
  it("a key flip between adverts produces one structured record and a distinct sink line", () => {
    const sink = vi.fn();
    setKeyEventSink(sink);
    recordNodeInfo(ACCT, { num: 0x0a0b0c0d, user: { publicKey: key(0x11) } });
    recordNodeInfo(ACCT, { num: 0x0a0b0c0d, user: { publicKey: key(0x22), longName: "Flip" } });
    const mismatches = recentKeyMismatches(ACCT);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toMatchObject({
      accountId: ACCT,
      nodeNum: 0x0a0b0c0d,
      nodeId: "!0a0b0c0d",
      source: "nodeinfo",
      pinnedKeyFp: meshtasticKeyFingerprint(key(0x11)),
      observedKeyFp: meshtasticKeyFingerprint(key(0x22)),
    });
    expect(sink).toHaveBeenCalledTimes(1);
    const line = sink.mock.calls[0]![0] as string;
    expect(line).toContain("pki key mismatch for !0a0b0c0d");
    expect(line).toContain(meshtasticKeyFingerprint(key(0x11)));
    expect(line).toContain(meshtasticKeyFingerprint(key(0x22)));
    // Fingerprints only: full keys never appear in the line.
    expect(line).not.toContain(b64(0x11));
    expect(line).not.toContain(b64(0x22));
    // The pin did not move; the mismatched advert's key was not adopted.
    expect(getNodeKeyPin(ACCT, 0x0a0b0c0d)?.publicKey).toBe(b64(0x11));
  });

  it("dedupes the log line while the same conflict persists, but re-logs a new conflict", () => {
    const sink = vi.fn();
    setKeyEventSink(sink);
    observeNodeKey(ACCT, 7, b64(0x11), "pki-packet");
    observeNodeKey(ACCT, 7, b64(0x22), "pki-packet");
    observeNodeKey(ACCT, 7, b64(0x22), "pki-packet");
    observeNodeKey(ACCT, 7, b64(0x22), "pki-packet");
    expect(sink).toHaveBeenCalledTimes(1);
    observeNodeKey(ACCT, 7, b64(0x33), "pki-packet");
    expect(sink).toHaveBeenCalledTimes(2);
    expect(recentKeyMismatches(ACCT)).toHaveLength(2);
  });

  it("a key flip across node-book eviction/re-learn still mismatches (pin survives eviction)", () => {
    // Pin the victim, then flood the NAME book past its cap so the victim is
    // evicted from it. The pin store is independent and must hold.
    const victim = 0x0a0b0c0d;
    recordNodeInfo(ACCT, { num: victim, user: { publicKey: key(0x11), longName: "Victim" } });
    for (let i = 0; i < NODE_BOOK_MAX_NODES + 5; i++) {
      const num = 0x10000000 + i;
      recordNodeInfo(ACCT, { num, user: { longName: `Flood ${i}` }, lastHeard: 1790000000 + i });
    }
    // The victim fell out of the name book...
    expect(buildNodeBook(ACCT).nodes.some((n) => n.num === victim)).toBe(false);
    // ...but its pin survived, so the re-learned node with a NEW key is a mismatch.
    expect(getNodeKeyPin(ACCT, victim)?.publicKey).toBe(b64(0x11));
    recordNodeInfo(ACCT, { num: victim, user: { publicKey: key(0x22), longName: "Victim" } });
    expect(recentKeyMismatches(ACCT)).toHaveLength(1);
    expect(recentKeyMismatches(ACCT)[0]?.observedKeyFp).toBe(meshtasticKeyFingerprint(key(0x22)));
  });
});

describe("crc32 anomaly signal", () => {
  it("flags keys whose crc32 does not match the node number (weak signal, still pins)", () => {
    const num = 0x0a0b0c0d; // not the crc32 of key(0x44)
    const obs = observeNodeKey(ACCT, num, b64(0x44), "nodeinfo");
    expect(obs?.status).toBe("pinned");
    expect(obs?.crc32Anomaly).toBe(true);
    expect(getNodeKeyPin(ACCT, num)?.publicKey).toBe(b64(0x44));
    const identity = senderIdentityFromObservation(obs!);
    expect(identity.grade).toBe("pki-verified");
    expect(identity.detail).toContain("crc32");
  });

  it("does not flag crc32-consistent (2.8+-style) bindings", () => {
    const num = consistentNum(0x55);
    const obs = observeNodeKey(ACCT, num, b64(0x55), "nodeinfo");
    expect(obs?.status).toBe("pinned");
    expect(obs?.crc32Anomaly).toBe(false);
    const identity = senderIdentityFromObservation(obs!);
    expect(identity.grade).toBe("pki-verified");
    expect(identity.detail).toBe("first-seen pin (TOFU)");
  });
});

describe("senderIdentityFromObservation", () => {
  it("maps pinned/match to pki-verified and mismatch to mismatch, never verified", () => {
    const num = consistentNum(0x11); // crc32-consistent, so details stay focused on grading
    const pinned = observeNodeKey(ACCT, num, b64(0x11), "pki-packet")!;
    expect(senderIdentityFromObservation(pinned)).toMatchObject({
      grade: "pki-verified",
      keyFp: pinned.keyFp,
      detail: "first-seen pin (TOFU)",
    });
    const match = observeNodeKey(ACCT, num, b64(0x11), "pki-packet")!;
    expect(senderIdentityFromObservation(match).grade).toBe("pki-verified");
    const flipped = observeNodeKey(ACCT, num, b64(0x22), "pki-packet")!;
    const identity = senderIdentityFromObservation(flipped);
    expect(identity.grade).toBe("mismatch");
    expect(identity.keyFp).toBe(flipped.keyFp);
    expect(identity.detail).toContain("key changed");
    expect(identity.detail).toContain(pinned.keyFp);
  });
});

describe("operator actions", () => {
  it("clearNodeKeyPin clears the pin so the next observation re-pins (rotation remediation)", () => {
    const num = 0x0a0b0c0d;
    observeNodeKey(ACCT, num, b64(0x11), "pki-packet");
    observeNodeKey(ACCT, num, b64(0x22), "pki-packet"); // mismatch
    expect(recentKeyMismatches(ACCT)).toHaveLength(1);
    const clearedFp = clearNodeKeyPin(ACCT, num);
    expect(clearedFp).toBe(meshtasticKeyFingerprint(key(0x11)));
    expect(getNodeKeyPin(ACCT, num)).toBeNull();
    // The rotated key now pins cleanly and verifies again.
    const obs = observeNodeKey(ACCT, num, b64(0x22), "pki-packet");
    expect(obs?.status).toBe("pinned");
    expect(senderIdentityFromObservation(obs!).grade).toBe("pki-verified");
    // Clearing when no pin exists is a no-op.
    expect(clearNodeKeyPin(ACCT, num + 1)).toBeNull();
  });

  it("markNodeKeyManuallyVerified marks an existing pin and surfaces it", () => {
    const num = 0x0a0b0c0d;
    expect(markNodeKeyManuallyVerified(ACCT, num)).toBe(false);
    // A node heard over the air (name-book entry + pin in one advert).
    recordNodeInfo(ACCT, { num, user: { longName: "Keyed", publicKey: key(0x11) } });
    expect(markNodeKeyManuallyVerified(ACCT, num)).toBe(true);
    expect(markNodeKeyManuallyVerified(ACCT, num)).toBe(false); // idempotent report
    expect(getNodeKeyPin(ACCT, num)?.manuallyVerified).toBe(true);
    const record = buildNodeBook(ACCT).nodes.find((n) => n.num === num);
    expect(record?.keyManuallyVerified).toBe(true);
  });
});

describe("persistence", () => {
  it("the keybook survives a restart: pins reload from disk and keep continuity", () => {
    const num = 0x0a0b0c0d;
    observeNodeKey(ACCT, num, b64(0x11), "nodeinfo");
    markNodeKeyManuallyVerified(ACCT, num);
    flushNodeBookWrites();

    // Simulate a gateway restart: all in-memory state gone, files remain.
    resetNodeBookForTests();
    setKeyBookPathForTests(join(dir, "meshtastic-keys.json"));
    setNodeBookPathForTests(join(dir, "meshtastic-nodes.json"));

    // The same key still matches; a flip still mismatches.
    expect(observeNodeKey(ACCT, num, b64(0x11), "pki-packet")?.status).toBe("match");
    expect(getNodeKeyPin(ACCT, num)?.manuallyVerified).toBe(true);
    expect(observeNodeKey(ACCT, num, b64(0x22), "pki-packet")?.status).toBe("mismatch");
  });

  it("a corrupt keys file loads as empty without throwing", () => {
    const num = 0x0a0b0c0d;
    observeNodeKey(ACCT, num, b64(0x11), "nodeinfo");
    flushNodeBookWrites();
    rmSync(join(dir, "meshtastic-keys.json"));
    // Write garbage where the keys file was.
    writeFileSync(join(dir, "meshtastic-keys.json"), "{not json", "utf8");
    resetNodeBookForTests();
    setKeyBookPathForTests(join(dir, "meshtastic-keys.json"));
    expect(getNodeKeyPin(ACCT, num)).toBeNull();
    // Fresh first-seen works after the corruption.
    expect(observeNodeKey(ACCT, num, b64(0x11), "nodeinfo")?.status).toBe("pinned");
  });

  it("the name-book file carries the pin fields for operator inspection", () => {
    const num = 0x0a0b0c0d;
    recordNodeInfo(ACCT, { num, user: { longName: "Keyed", publicKey: key(0x11) } });
    flushNodeBookWrites();
    const file = readNodeBook(ACCT);
    const record = file?.nodes.find((n) => n.num === num);
    expect(record?.publicKey).toBe(b64(0x11));
    expect(record?.keyFirstSeenAt).toBeGreaterThan(0);
  });
});

describe("pin store bound", () => {
  it("evicts the least-recently-seen pin at the cap and logs it (never silently)", () => {
    const sink = vi.fn();
    setKeyEventSink(sink);
    for (let i = 0; i < KEY_BOOK_MAX_PINS; i++) {
      const marker = (i % 250) + 1;
      // Distinct keys per entry: vary one byte by index.
      const bytes = key(marker);
      bytes[0] = i & 0xff;
      bytes[1] = (i >> 8) & 0xff;
      observeNodeKey(ACCT, 0x01000000 + i, Buffer.from(bytes).toString("base64"), "nodeinfo");
    }
    const evictVictimBytes = key(0xf0);
    const obs = observeNodeKey(ACCT, 0x02000000, Buffer.from(evictVictimBytes).toString("base64"), "nodeinfo");
    expect(obs?.status).toBe("pinned");
    expect(getNodeKeyPin(ACCT, 0x02000000)?.publicKey).toBe(Buffer.from(evictVictimBytes).toString("base64"));
    expect(sink).toHaveBeenCalledWith(expect.stringContaining("evicted pin for"));
  }, 20000);
});

describe("eviction tombstones (#7 security)", () => {
  it("does not re-verify a spoofed key after a pin-flood evicts the victim's pin (#7 BLOCKER regression)", () => {
    const victim = consistentNum(0x21);
    observeNodeKey(ACCT, victim, b64(0x21), "pki-packet");
    expect(getNodeKeyPin(ACCT, victim)).not.toBeNull();

    // Attacker floods the store with distinct fake nodes to force eviction of
    // the least-recently-seen pin (the victim's).
    for (let i = 0; i <= KEY_BOOK_MAX_PINS; i += 1) {
      observeNodeKey(ACCT, 0x01000000 + i, b64(0x40 + (i % 100)), "nodeinfo");
    }
    expect(getNodeKeyPin(ACCT, victim)).toBeNull();

    // Attacker re-advertises the victim's number with THEIR key.
    const spoofed = observeNodeKey(ACCT, victim, b64(0x77), "nodeinfo");
    expect(spoofed?.status).toBe("mismatch");
    const identity = senderIdentityFromObservation(spoofed!);
    expect(identity.grade).toBe("mismatch");
    expect(identity.firstContact).toBeUndefined();
    // No pin is created for the spoofed key.
    expect(getNodeKeyPin(ACCT, victim)).toBeNull();

    // Operator re-pin (legitimate rotation) clears the tombstone and re-arms.
    clearNodeKeyPin(ACCT, victim);
    const afterRepin = observeNodeKey(ACCT, victim, b64(0x77), "nodeinfo");
    expect(afterRepin?.status).toBe("pinned");
    expect(senderIdentityFromObservation(afterRepin!).firstContact).toBe(true);
  }, 20000);

  it("restores continuity when the evicted key returns unchanged", () => {
    const victim = consistentNum(0x22);
    observeNodeKey(ACCT, victim, b64(0x22), "pki-packet");
    for (let i = 0; i <= KEY_BOOK_MAX_PINS; i += 1) {
      observeNodeKey(ACCT, 0x02000000 + i, b64(0x40 + (i % 100)), "nodeinfo");
    }
    expect(getNodeKeyPin(ACCT, victim)).toBeNull();

    const restored = observeNodeKey(ACCT, victim, b64(0x22), "nodeinfo");
    expect(restored?.status).toBe("match");
    const identity = senderIdentityFromObservation(restored!);
    expect(identity.grade).toBe("pki-verified");
    // A restored continuity is NOT a first contact.
    expect(identity.firstContact).toBeUndefined();
    expect(getNodeKeyPin(ACCT, victim)).not.toBeNull();
  }, 20000);

  it("persists tombstones across a restart and stays mismatch after reload", () => {
    const victim = consistentNum(0x23);
    observeNodeKey(ACCT, victim, b64(0x23), "pki-packet");
    for (let i = 0; i <= KEY_BOOK_MAX_PINS; i += 1) {
      observeNodeKey(ACCT, 0x03000000 + i, b64(0x40 + (i % 100)), "nodeinfo");
    }
    writeKeyBook(ACCT);
    resetNodeBookForTests(); // fresh process
    setKeyBookPathForTests(join(dir, "meshtastic-keys.json"));
    setNodeBookPathForTests(join(dir, "meshtastic-nodes.json"));

    const spoofed = observeNodeKey(ACCT, victim, b64(0x78), "nodeinfo");
    expect(spoofed?.status).toBe("mismatch");
    expect(senderIdentityFromObservation(spoofed!).grade).toBe("mismatch");
  }, 20000);

  it("loads a version-1 key book (pins only) without tombstones", () => {
    const victim = consistentNum(0x24);
    const path = join(dir, "meshtastic-keys.json");
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        generatedAt: new Date().toISOString(),
        accountId: ACCT,
        pins: [
          {
            num: victim,
            publicKey: b64(0x24),
            firstSeenAt: 1000,
            lastSeenAt: 1000,
            manuallyVerified: false,
          },
        ],
      }),
    );
    resetNodeBookForTests();
    setKeyBookPathForTests(path);
    const obs = observeNodeKey(ACCT, victim, b64(0x24), "nodeinfo");
    expect(obs?.status).toBe("match");
  });
});

describe("first contact vs continuity (#7)", () => {
  it("marks a brand-new pin firstContact and an established pin not", () => {
    const num = consistentNum(0x31);
    const first = observeNodeKey(ACCT, num, b64(0x31), "pki-packet");
    expect(senderIdentityFromObservation(first!).firstContact).toBe(true);

    const second = observeNodeKey(ACCT, num, b64(0x31), "pki-packet");
    expect(second?.status).toBe("match");
    const identity = senderIdentityFromObservation(second!);
    expect(identity.grade).toBe("pki-verified");
    expect(identity.firstContact).toBeUndefined();
  });

  it("keeps the mismatch detail policy-neutral (no admission claim)", () => {
    const num = consistentNum(0x32);
    observeNodeKey(ACCT, num, b64(0x32), "pki-packet");
    const flip = observeNodeKey(ACCT, num, b64(0x33), "pki-packet");
    const identity = senderIdentityFromObservation(flip!);
    expect(identity.grade).toBe("mismatch");
    expect(identity.detail).toContain("key changed");
    expect(identity.detail).not.toContain("admitted");
  });
});

describe("operator re-pin markers (#7)", () => {
  it("records, persists and prunes re-pin markers", () => {
    const a = consistentNum(0x41);
    const b = consistentNum(0x42);
    observeNodeKey(ACCT, a, b64(0x41), "pki-packet");
    clearNodeKeyPin(ACCT, a);
    setRepinMarker(ACCT, a, 5000);
    setRepinMarker(ACCT, b, 5000);
    expect(getRepinMarker(ACCT, a)).toBe(5000);

    writeKeyBook(ACCT);
    resetNodeBookForTests();
    setKeyBookPathForTests(join(dir, "meshtastic-keys.json"));
    setNodeBookPathForTests(join(dir, "meshtastic-nodes.json"));
    expect(getRepinMarker(ACCT, a)).toBe(5000);

    // Removing an entry from pkiRepin prunes its marker so a later re-add
    // re-arms a second legitimate rotation.
    expect(pruneRepinMarkers(ACCT, new Set([b]))).toBe(1);
    expect(getRepinMarker(ACCT, a)).toBeUndefined();
    expect(getRepinMarker(ACCT, b)).toBe(5000);
  });
});

describe("saturated store with manually verified pins (#7 review)", () => {
  it("never evicts a manually verified pin; new keys are not pinned and grade first-contact", () => {
    // Fill the store to cap with manually verified pins.
    for (let i = 0; i < KEY_BOOK_MAX_PINS; i += 1) {
      const num = 0x05000000 + i;
      observeNodeKey(ACCT, num, b64(0x40 + (i % 100)), "nodeinfo");
      markNodeKeyManuallyVerified(ACCT, num);
    }
    const before = getNodeKeyPin(ACCT, 0x05000000);
    expect(before?.manuallyVerified).toBe(true);

    // One more new key at the cap: no eviction, no pin, first-contact grade.
    const newcomer = 0x06000000;
    const obs = observeNodeKey(ACCT, newcomer, b64(0x77), "nodeinfo");
    expect(obs?.status).toBe("saturated");
    expect(getNodeKeyPin(ACCT, newcomer)).toBeNull();
    // The first (verified) pin is still there — nothing was evicted.
    expect(getNodeKeyPin(ACCT, 0x05000000)?.publicKey).toBe(before?.publicKey);
    const identity = senderIdentityFromObservation(obs!);
    expect(identity.grade).toBe("pki-verified");
    expect(identity.firstContact).toBe(true);
    expect(identity.detail).toContain("saturated");
  }, 60000);

  it("tombstones store the full key, not just a fingerprint", () => {
    const victim = consistentNum(0x61);
    observeNodeKey(ACCT, victim, b64(0x61), "pki-packet");
    for (let i = 0; i <= KEY_BOOK_MAX_PINS; i += 1) {
      observeNodeKey(ACCT, 0x07000000 + i, b64(0x40 + (i % 100)), "nodeinfo");
    }
    expect(getNodeKeyPin(ACCT, victim)).toBeNull();
    const tombstone = getKeyTombstone(ACCT, victim);
    expect(tombstone?.key).toBe(b64(0x61));
  }, 30000);

  it("loads a v2 file with malformed evicted/repins entries, keeping valid ones", () => {
    const victim = consistentNum(0x62);
    const path = join(dir, "meshtastic-keys.json");
    writeFileSync(
      path,
      JSON.stringify({
        version: 2,
        generatedAt: new Date().toISOString(),
        accountId: ACCT,
        pins: [],
        evicted: [
          { num: victim, key: b64(0x62), keyFp: "abcdef123456", evictedAt: 1000 },
          { num: "not-a-number", keyFp: "zzz" },
          { num: 0, keyFp: "drop-me" },
          { num: 1234 },
          "garbage",
        ],
        repins: [{ num: victim, lastRepinAt: 5000 }, { num: -1, lastRepinAt: 1 }, null],
      }),
    );
    resetNodeBookForTests();
    setKeyBookPathForTests(path);
    setNodeBookPathForTests(join(dir, "meshtastic-nodes.json"));

    expect(getKeyTombstone(ACCT, victim)?.key).toBe(b64(0x62));
    expect(getRepinMarker(ACCT, victim)).toBe(5000);
    // A different key under the tombstoned number stays mismatch.
    const spoofed = observeNodeKey(ACCT, victim, b64(0x63), "nodeinfo");
    expect(spoofed?.status).toBe("mismatch");
    // The same key restores continuity.
    const restored = observeNodeKey(ACCT, victim, b64(0x62), "nodeinfo");
    expect(restored?.status).toBe("match");
  });
});

describe("tombstone compare precedence and fallbacks (#7 review nits)", () => {
  it("prefers full-key bytes over the fingerprint when a tombstone carries both (byte-compare mutation target)", () => {
    // Crafted inconsistent tombstone: key=A but keyFp=fp(B). With byte
    // comparison, observing B is a mismatch; with fp-only comparison it would
    // wrongly restore continuity.
    const victim = consistentNum(0x71);
    const path = join(dir, "meshtastic-keys.json");
    const keyA = b64(0x71);
    const keyB = b64(0x72);
    const fpB = meshtasticKeyFingerprint(key(0x72));
    writeFileSync(
      path,
      JSON.stringify({
        version: 2,
        generatedAt: new Date().toISOString(),
        accountId: ACCT,
        pins: [],
        evicted: [{ num: victim, key: keyA, keyFp: fpB, evictedAt: 1000 }],
        repins: [],
      }),
    );
    resetNodeBookForTests();
    setKeyBookPathForTests(path);
    setNodeBookPathForTests(join(dir, "meshtastic-nodes.json"));

    const obs = observeNodeKey(ACCT, victim, keyB, "nodeinfo");
    expect(obs?.status).toBe("mismatch");
    expect(getNodeKeyPin(ACCT, victim)).toBeNull();
    // And key A, matching the stored full key, restores continuity.
    const obsA = observeNodeKey(ACCT, victim, keyA, "nodeinfo");
    expect(obsA?.status).toBe("match");
  });

  it("legacy fp-only tombstone restores the same key and rejects a different one", () => {
    const victim = consistentNum(0x73);
    const path = join(dir, "meshtastic-keys.json");
    const keyA = b64(0x73);
    const fpA = meshtasticKeyFingerprint(key(0x73));
    writeFileSync(
      path,
      JSON.stringify({
        version: 2,
        generatedAt: new Date().toISOString(),
        accountId: ACCT,
        pins: [],
        evicted: [{ num: victim, keyFp: fpA, evictedAt: 1000 }],
        repins: [],
      }),
    );
    resetNodeBookForTests();
    setKeyBookPathForTests(path);
    setNodeBookPathForTests(join(dir, "meshtastic-nodes.json"));

    const same = observeNodeKey(ACCT, victim, keyA, "nodeinfo");
    expect(same?.status).toBe("match");
    // Clear everything, then observe a different key: fp differs -> mismatch.
    resetNodeBookForTests();
    setKeyBookPathForTests(path);
    const other = observeNodeKey(ACCT, victim, b64(0x74), "nodeinfo");
    expect(other?.status).toBe("mismatch");
  });

  it("a pin re-won after the tombstone is gone carries firstContact (the documented mitigation)", () => {
    const victim = consistentNum(0x75);
    observeNodeKey(ACCT, victim, b64(0x75), "pki-packet");
    for (let i = 0; i <= KEY_BOOK_MAX_PINS; i += 1) {
      observeNodeKey(ACCT, 0x08000000 + i, b64(0x40 + (i % 100)), "nodeinfo");
    }
    expect(getNodeKeyPin(ACCT, victim)).toBeNull();
    expect(getKeyTombstone(ACCT, victim)).not.toBeNull();
    // Operator re-pin clears pin AND tombstone (the age-out equivalent: no
    // tombstone left to compare against).
    clearNodeKeyPin(ACCT, victim);
    expect(getKeyTombstone(ACCT, victim)).toBeNull();
    // A fresh key under that number is a brand-new pin and MUST carry
    // firstContact, so continuity-gating consumers can refuse it.
    const fresh = observeNodeKey(ACCT, victim, b64(0x76), "nodeinfo");
    expect(fresh?.status).toBe("pinned");
    expect(senderIdentityFromObservation(fresh!).firstContact).toBe(true);
  }, 30000);

  it("surfaces the crc32 anomaly note on the saturated grade too", () => {
    for (let i = 0; i < KEY_BOOK_MAX_PINS; i += 1) {
      const num = 0x09000000 + i;
      observeNodeKey(ACCT, num, b64(0x40 + (i % 100)), "nodeinfo");
      markNodeKeyManuallyVerified(ACCT, num);
    }
    // 0x0a000001 deliberately mismatches the key's crc32 (anomaly case).
    const obs = observeNodeKey(ACCT, 0x0a000001, b64(0x79), "nodeinfo");
    expect(obs?.status).toBe("saturated");
    expect(obs?.crc32Anomaly).toBe(true);
    const identity = senderIdentityFromObservation(obs!);
    expect(identity.detail).toContain("saturated");
    expect(identity.detail).toContain("crc32");
  }, 60000);
});

