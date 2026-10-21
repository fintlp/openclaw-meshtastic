import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";

describe("test isolation guard", () => {
  it("redirects OPENCLAW_STATE_DIR into the per-run test root", () => {
    expect(process.env.OPENCLAW_STATE_DIR ?? "").toContain("meshtastic-test-run-");
  });

  it("redirects TMPDIR into the per-run test root", () => {
    expect(process.env.TMPDIR ?? "").toContain("meshtastic-test-run-");
    expect(tmpdir()).toBe(process.env.TMPDIR);
  });
});
