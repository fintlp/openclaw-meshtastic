import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  evaluateIdentityGate,
  firmwareStartupLine,
  formatIdentityGateDropLine,
  identityGateStartupLines,
  logIdentityGateDrop,
  resetIdentityGateThrottleForTests,
} from "./identity-gate.js";
import {
  markNodeKeyManuallyVerified,
  observeNodeKey,
  resetNodeBookForTests,
  setKeyBookPathForTests,
  setNodeBookPathForTests,
} from "./node-book.js";
import type { CoreConfig, MeshtasticSenderIdentity } from "./types.js";

// Identity gate unit edges (MCP07, 2026.11.1): rule details T1-T18 do not
// pin at the inbound level, the T23 drop-log throttle, and the startup-check
// conditions T24 verifies through the monitor harness. Generic fixtures only.

const KEY_A = Buffer.alloc(32, 0x11).toString("base64");
const KEY_B = Buffer.alloc(32, 0x22).toString("base64");
const BASE_CFG = { channels: { meshtastic: { host: "192.0.2.10" } } } as CoreConfig;

function gate(params: {
  identity?: MeshtasticSenderIdentity;
  isGroup?: boolean;
  accountConfig?: Record<string, unknown>;
  coreConfig?: CoreConfig;
  num?: number;
}) {
  return evaluateIdentityGate({
    accountId: "default",
    senderNodeNum: params.num ?? 2,
    isGroup: params.isGroup ?? false,
    ...(params.identity ? { senderIdentity: params.identity } : {}),
    accountConfig: (params.accountConfig ?? {}) as never,
    coreConfig: params.coreConfig ?? BASE_CFG,
  });
}

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "igate-"));
  setKeyBookPathForTests(join(dir, "keys.json"));
  setNodeBookPathForTests(join(dir, "nodes.json"));
  resetIdentityGateThrottleForTests();
});
afterEach(() => {
  resetNodeBookForTests();
});

describe("identity gate rule edges", () => {
  it("owner entries outside the uint32 range never match a mesh node (phone-number guard)", () => {
    observeNodeKey("default", 2, KEY_A, "pki-packet");
    const coreConfig = {
      channels: { meshtastic: { host: "192.0.2.10" } },
      commands: { ownerAllowFrom: ["+436766078167", "436766078167", "whatsapp:!00000002"] },
    } as unknown as CoreConfig;
    const d = gate({ identity: { grade: "psk-grade" }, coreConfig });
    // Not dropped as an owner message — the ordinary known-keys rule decides.
    expect(d.action).toBe("drop");
    expect(d.reason).toBe("known-key-unverified");
  });

  it("owner entries match as node numbers: bare decimal, !hex and meshtastic:-prefixed forms", () => {
    for (const entry of ["2", "!00000002", "meshtastic:!00000002"]) {
      const coreConfig = {
        channels: { meshtastic: { host: "192.0.2.10" } },
        commands: { ownerAllowFrom: [entry] },
      } as unknown as CoreConfig;
      const d = gate({ identity: { grade: "psk-grade" }, coreConfig });
      expect(d.action).toBe("drop");
      expect(d.reason).toBe("owner-unverified");
    }
  });

  it("group traffic from a manual-listed id follows the normal group rules (rule 3 is DM-only)", () => {
    const d = gate({
      identity: { grade: "psk-grade" },
      isGroup: true,
      accountConfig: { pkiManuallyVerified: ["!00000002"] },
    });
    expect(d.action).toBe("admit");
    expect(d.suppressCommands).toBe(true);
  });

  it("a malformed key in a manual entry drops defensively, never downgrades to the id-only rule", () => {
    const d = gate({
      identity: { grade: "pki-verified", keyFp: "001122334455" },
      accountConfig: { pkiManuallyVerified: ["!00000002=not-a-key"] },
    });
    expect(d.action).toBe("drop");
    expect(d.reason).toBe("manual-key-mismatch");
  });

  it("key-bound manual form: a byte-exact pin match admits even a first contact", () => {
    observeNodeKey("default", 2, KEY_A, "pki-packet");
    const d = gate({
      identity: { grade: "pki-verified", keyFp: "001122334455", firstContact: true },
      accountConfig: { pkiManuallyVerified: [`!00000002=${KEY_A}`] },
    });
    expect(d.action).toBe("admit");
    // Commands still wait for continuity — the global suppression formula
    // makes no key-bound exception (spec: suppressCommands on firstContact).
    expect(d.suppressCommands).toBe(true);
  });

  it("owner + key-bound manual entry: a pin that differs from the configured key is dropped, never admitted on continuity (review blocker)", () => {
    observeNodeKey("default", 2, KEY_B, "pki-packet");
    const coreConfig = {
      channels: { meshtastic: { host: "192.0.2.10" } },
      commands: { ownerAllowFrom: ["meshtastic:!00000002"] },
    } as unknown as CoreConfig;
    const bad = gate({
      identity: { grade: "pki-verified", keyFp: "001122334455" },
      coreConfig,
      accountConfig: { pkiManuallyVerified: [`!00000002=${KEY_A}`] },
    });
    expect(bad.action).toBe("drop");
    expect(bad.reason).toBe("manual-key-mismatch");
    const good = gate({
      identity: { grade: "pki-verified", keyFp: "001122334455" },
      coreConfig,
      accountConfig: { pkiManuallyVerified: [`!00000002=${KEY_B}`] },
    });
    expect(good.action).toBe("admit");
  });

  it("id-only manual form: continuity plus the operator mark admits; an unmarked pin drops", () => {
    observeNodeKey("default", 2, KEY_A, "pki-packet");
    const unmarked = gate({
      identity: { grade: "pki-verified", keyFp: "001122334455" },
      accountConfig: { pkiManuallyVerified: ["!00000002"] },
    });
    expect(unmarked.action).toBe("drop");
    expect(unmarked.reason).toBe("manual-unverified");
    markNodeKeyManuallyVerified("default", 2);
    const marked = gate({
      identity: { grade: "pki-verified", keyFp: "001122334455" },
      accountConfig: { pkiManuallyVerified: ["!00000002"] },
    });
    expect(marked.action).toBe("admit");
  });

  it("strict drops a mismatch even with the legacy pkiMismatch=unverified escape hatch", () => {
    const d = gate({
      identity: { grade: "mismatch", keyFp: "abcdef012345" },
      accountConfig: { dmIdentity: "strict", pkiMismatch: "unverified" },
    });
    expect(d.action).toBe("drop");
    expect(d.reason).toBe("strict-unverified");
  });

  it("commandIdentity=policy leaves command rights to the ordinary policy (legacy)", () => {
    const d = gate({
      identity: { grade: "psk-grade" },
      accountConfig: { dmIdentity: "off", commandIdentity: "policy" },
    });
    expect(d.action).toBe("admit");
    expect(d.suppressCommands).toBe(false);
  });
});

describe("identity gate drop logging (T23)", () => {
  const decision = {
    action: "drop" as const,
    reason: "known-key-unverified",
    suppressCommands: true,
    grade: "psk-grade" as const,
  };

  it("formats the drop line with fingerprint only, never a full key or body", () => {
    expect(
      formatIdentityGateDropLine({
        accountId: "default",
        isGroup: false,
        senderId: "!00000002",
        decision,
      }),
    ).toBe(
      "[default] meshtastic: identity gate drop DM !00000002 (reason=known-key-unverified grade=psk-grade fp=none)",
    );
  });

  it("T23 one line per sender per 60 s, the next line carries suppressed=<n>", () => {
    const lines: string[] = [];
    const log = (line: string) => lines.push(line);
    const base = {
      accountId: "default",
      senderNodeNum: 2,
      senderId: "!00000002",
      isGroup: false,
      decision,
      log,
    };
    logIdentityGateDrop({ ...base, now: 1_000_000 });
    logIdentityGateDrop({ ...base, now: 1_001_000 });
    logIdentityGateDrop({ ...base, now: 1_059_999 });
    expect(lines).toHaveLength(1);
    logIdentityGateDrop({ ...base, now: 1_060_001 });
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("suppressed=2");
    // A different sender has its own throttle window.
    logIdentityGateDrop({ ...base, senderNodeNum: 3, senderId: "!00000003", now: 1_061_000 });
    expect(lines).toHaveLength(3);
    expect(lines[2]).not.toContain("suppressed=");
  });
});

describe("identity gate startup lines (T24 unit level)", () => {
  it("clean defaults emit no lines", () => {
    expect(
      identityGateStartupLines({
        accountId: "default",
        accountConfig: {},
        transport: "tcp",
        coreConfig: BASE_CFG,
      }),
    ).toEqual([]);
  });

  it("dmIdentity=off and commandIdentity=policy each emit exactly their own WARN", () => {
    const lines = identityGateStartupLines({
      accountId: "default",
      accountConfig: { dmIdentity: "off", commandIdentity: "policy" },
      transport: "tcp",
      coreConfig: BASE_CFG,
    });
    expect(lines.map((l) => l.level)).toEqual(["warn", "warn"]);
    expect(lines[0]!.line).toContain("dmIdentity=off");
    expect(lines[1]!.line).toContain("commandIdentity=policy");
  });

  it("transport=http warns under known-keys but not under off", () => {
    const http = identityGateStartupLines({
      accountId: "default",
      accountConfig: {},
      transport: "http",
      coreConfig: BASE_CFG,
    });
    expect(http).toHaveLength(1);
    expect(http[0]!.line).toContain("transport=http");
    const off = identityGateStartupLines({
      accountId: "default",
      accountConfig: { dmIdentity: "off" },
      transport: "http",
      coreConfig: BASE_CFG,
    });
    expect(off.some((l) => l.line.includes("transport=http"))).toBe(false);
  });

  it("owner mesh entries produce an INFO line with ids and pin fingerprints", () => {
    observeNodeKey("default", 170, KEY_A, "pki-packet");
    const coreConfig = {
      channels: { meshtastic: { host: "192.0.2.10" } },
      commands: { ownerAllowFrom: ["meshtastic:!000000aa", "!00000002"] },
    } as unknown as CoreConfig;
    const lines = identityGateStartupLines({
      accountId: "default",
      accountConfig: {},
      transport: "tcp",
      coreConfig,
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.level).toBe("info");
    expect(lines[0]!.line).toContain("!000000aa");
    expect(lines[0]!.line).toContain("!00000002");
    expect(lines[0]!.line).toMatch(/fp=[0-9a-f]{12}/);
    expect(lines[0]!.line).toContain("key continuity");
  });

  it("a key-bound manual entry differing from the stored pin warns with both fingerprints; a match stays silent", () => {
    observeNodeKey("default", 2, KEY_B, "pki-packet");
    const mismatch = identityGateStartupLines({
      accountId: "default",
      accountConfig: { pkiManuallyVerified: [`!00000002=${KEY_A}`] },
      transport: "tcp",
      coreConfig: BASE_CFG,
    });
    expect(mismatch).toHaveLength(1);
    expect(mismatch[0]!.line).toContain("differs from the stored pin");
    expect(mismatch[0]!.line).toContain("pkiRepin");
    expect(mismatch[0]!.line.match(/fp=[0-9a-f]{12}/g)?.length).toBeGreaterThanOrEqual(2);
    const match = identityGateStartupLines({
      accountId: "default",
      accountConfig: { pkiManuallyVerified: [`!00000002=${KEY_B}`] },
      transport: "tcp",
      coreConfig: BASE_CFG,
    });
    expect(match).toEqual([]);
  });

  it("firmware below 2.7.15 warns (CVE-2025-53627); newer, equal or unparseable stays silent", () => {
    expect(firmwareStartupLine("default", "2.7.10.abc")).toContain("CVE-2025-53627");
    expect(firmwareStartupLine("default", "2.6.99")).toContain("CVE-2025-53627");
    expect(firmwareStartupLine("default", "2.7.14")).toContain("CVE-2025-53627");
    expect(firmwareStartupLine("default", "2.7.15")).toBeNull();
    expect(firmwareStartupLine("default", "2.8.0")).toBeNull();
    expect(firmwareStartupLine("default", "3.0.0")).toBeNull();
    expect(firmwareStartupLine("default", "garbage")).toBeNull();
    expect(firmwareStartupLine("default", undefined)).toBeNull();
  });
});
