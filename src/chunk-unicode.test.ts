/**
 * Unicode chunking tests for the Meshtastic outbound path (issue #17).
 *
 * The radio limit is in BYTES (Data payload 233, encrypted DMs lose 12 to
 * MESHTASTIC_PKC_OVERHEAD, so 221), while the old chunkText split every 200
 * code points — French/Polish/Czech/Hungarian/Greek/Russian/Hebrew/Arabic/
 * Chinese replies produced packets the firmware refuses with
 * Routing_Error.TOO_LARGE, silently dropping parts of the reply.
 *
 * The corpus is shared byte-for-byte with openclaw-meshcore
 * (src/test-fixtures/unicode-corpus.ts). The sweep runs EVERY limit from 40
 * to 221, not a few fixed ones: whether a cut lands inside a combined
 * character depends on position, so fixed limits can miss it.
 */
import { describe, expect, it, vi } from "vitest";
import { UNICODE_CORPUS } from "./test-fixtures/unicode-corpus.js";
import {
  chunkUtf8,
  MESHTASTIC_TEXT_PAYLOAD_LIMIT,
  resolveChunkLimitBytes,
} from "./send.js";

const encoder = new TextEncoder();
const utf8Bytes = (s: string): number => encoder.encode(s).length;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const graphemeCount = (s: string) => [...segmenter.segment(s)].length;

describe("chunkUtf8: shared Unicode corpus sweep (issue #17)", () => {
  for (const [name, entry] of Object.entries(UNICODE_CORPUS)) {
    it(name + ": byte limit, no loss, no broken graphemes at every limit", () => {
      const long = (entry.text + (entry.spaces ? " " : "")).repeat(12);
      for (let limit = 40; limit <= MESHTASTIC_TEXT_PAYLOAD_LIMIT; limit++) {
        const chunks = chunkUtf8(long, limit);
        expect(chunks.length).toBeGreaterThan(1);
        for (const c of chunks) {
          expect(utf8Bytes(c)).toBeLessThanOrEqual(limit);
        }
        // No content lost (whitespace may move between chunks).
        expect(chunks.join("").replace(/\s+/g, "")).toBe(long.replace(/\s+/g, ""));
        // No join splits a grapheme cluster.
        for (let i = 0; i + 1 < chunks.length; i++) {
          const [a, b] = [chunks[i], chunks[i + 1]];
          expect(graphemeCount(a + b)).toBe(graphemeCount(a) + graphemeCount(b));
        }
      }
    });

    it(name + ": text that fits stays one unchanged chunk", () => {
      expect(chunkUtf8(entry.text, MESHTASTIC_TEXT_PAYLOAD_LIMIT)).toEqual([entry.text]);
    });
  }
});

describe("resolveChunkLimitBytes (issue #17)", () => {
  it("clamps a configured limit above 221 to the radio cap and logs once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(resolveChunkLimitBytes(500)).toBe(MESHTASTIC_TEXT_PAYLOAD_LIMIT);
      expect(resolveChunkLimitBytes(300)).toBe(MESHTASTIC_TEXT_PAYLOAD_LIMIT);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain("textChunkLimit");
      expect(String(warn.mock.calls[0][0])).toContain("221");
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps values within range as configured; default stays 200", () => {
    expect(resolveChunkLimitBytes(undefined)).toBe(200);
    expect(resolveChunkLimitBytes(40)).toBe(40);
    expect(resolveChunkLimitBytes(221)).toBe(221);
  });
});

describe("chunkUtf8 without Intl.Segmenter (issue #17)", () => {
  it("falls back to code points and logs once instead of crashing", () => {
    const intl = Intl as unknown as { Segmenter?: unknown };
    const original = intl.Segmenter;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    intl.Segmenter = undefined;
    try {
      const long = UNICODE_CORPUS.emojiSequences.text.repeat(12);
      const chunks = chunkUtf8(long, 40);
      expect(chunks.length).toBeGreaterThan(1);
      for (const c of chunks) {
        expect(utf8Bytes(c)).toBeLessThanOrEqual(40);
      }
      // No whitespace in the entry: the join is exact even in fallback mode.
      expect(chunks.join("")).toBe(long);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain("Intl.Segmenter");

      chunkUtf8("x".repeat(200), 40);
      expect(warn).toHaveBeenCalledTimes(1); // still logged only once
    } finally {
      intl.Segmenter = original;
      warn.mockRestore();
    }
  });
});
