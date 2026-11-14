import { getNodeKeyPin, hasKeyAnchor, meshtasticKeyFingerprint } from "./node-book.js";
import {
  formatMeshtasticNodeId,
  parseManualVerificationEntry,
  parseMeshtasticNodeNum,
} from "./normalize.js";
import type {
  CoreConfig,
  MeshtasticAccountConfig,
  MeshtasticSenderIdentity,
} from "./types.js";

/**
 * Identity gate (issue #33, ClawScan MCP07): the single decision point that
 * turns the phase-1 sender-identity grade into admission and command rights.
 *
 * Pure: reads the keybook, never writes it. Runs at every inbound entry
 * point (monitor live dispatch, handleMeshtasticInbound for live + replay)
 * BEFORE any side effect — no pairing request, no reply, no durability
 * intake, no agent route. The gate only ever REMOVES rights the ordinary
 * access policy might grant; it never admits a sender the policy denies.
 */

export type IdentityGateGrade = "pki-verified" | "psk-grade" | "mismatch";

export type IdentityGateDecision = {
  action: "admit" | "drop";
  /** Machine-safe drop reason (identity-gate:<reason> in dead-letters). */
  reason?: string;
  /** True when the message must NOT carry command authority into the agent run. */
  suppressCommands: boolean;
  grade: IdentityGateGrade;
  keyFp?: string;
};

type GateAccountConfig = Pick<
  MeshtasticAccountConfig,
  "dmIdentity" | "commandIdentity" | "pkiMismatch" | "pkiManuallyVerified"
>;

const BROADCAST_NUM = 0xffffffff;

/**
 * Owner entries that resolve to mesh node numbers. Entries are compared as
 * node numbers: "meshtastic:<id>" or an unprefixed "<id>" (decimal, !hex or
 * node:N). Entries for other channels never parse into the uint32 range
 * (a phone number is far above 0xffffffff), so they can never match here.
 */
export function ownerMeshNodeNums(coreConfig: CoreConfig): Set<number> {
  const nums = new Set<number>();
  const commands = (coreConfig as { commands?: { ownerAllowFrom?: unknown } }).commands;
  const entries = Array.isArray(commands?.ownerAllowFrom) ? commands.ownerAllowFrom : [];
  for (const entry of entries) {
    if (typeof entry !== "string" && typeof entry !== "number") {
      continue;
    }
    const num = parseMeshtasticNodeNum(String(entry));
    if (num !== undefined && num > 0 && num < BROADCAST_NUM) {
      nums.add(num);
    }
  }
  return nums;
}

function keyBytesEqual(aBase64: string, bBase64: string): boolean {
  const a = Buffer.from(aBase64, "base64");
  const b = Buffer.from(bBase64, "base64");
  return a.length === b.length && a.equals(b);
}

function keyFpOfBase64(keyBase64: string): string {
  return meshtasticKeyFingerprint(new Uint8Array(Buffer.from(keyBase64, "base64")));
}

function manualEntryFor(
  entries: string[] | undefined,
  num: number,
): { num: number; key?: string; keyInvalid?: boolean } | null {
  for (const entry of entries ?? []) {
    const parsed = parseManualVerificationEntry(String(entry));
    if (parsed && parsed.num === num) {
      return parsed;
    }
  }
  return null;
}

/**
 * Evaluate the gate. First matching rule wins; the rules only ever refuse.
 */
export function evaluateIdentityGate(params: {
  accountId: string;
  senderNodeNum: number;
  isGroup: boolean;
  senderIdentity?: MeshtasticSenderIdentity;
  accountConfig: GateAccountConfig;
  coreConfig: CoreConfig;
}): IdentityGateDecision {
  // Rule 1: no annotation == psk-grade. Fail closed, never open.
  const identity = params.senderIdentity;
  const grade: IdentityGateGrade = identity?.grade ?? "psk-grade";
  const firstContact = identity?.firstContact === true;
  const dmIdentity = params.accountConfig.dmIdentity ?? "known-keys";
  const commandIdentity = params.accountConfig.commandIdentity ?? "verified";
  const pkiMismatch = params.accountConfig.pkiMismatch ?? "drop";

  // Command rights are computed for every outcome: a dropped message never
  // reaches the agent anyway; an admitted one carries exactly these rights.
  const suppressCommands =
    commandIdentity === "verified" &&
    !(!params.isGroup && grade === "pki-verified" && !firstContact);

  const decide = (action: "admit" | "drop", reason?: string): IdentityGateDecision => ({
    action,
    ...(reason ? { reason } : {}),
    suppressCommands,
    grade,
    ...(identity?.keyFp ? { keyFp: identity.keyFp } : {}),
  });

  // Rule 2 — owner authority, unconditional in every mode.
  if (ownerMeshNodeNums(params.coreConfig).has(params.senderNodeNum)) {
    // Channel traffic cannot prove identity: a group message is never an
    // owner message.
    if (params.isGroup) {
      return decide("drop", "owner-group");
    }
    // Owner authority needs key continuity — a first contact can be won in a
    // TOFU race, so it is never enough.
    if (grade !== "pki-verified" || firstContact) {
      return decide("drop", "owner-unverified");
    }
    // A key-bound manual entry is the strongest trust root and applies to
    // owner nodes too (cross-check blocker, 2026-11-14): continuity alone
    // must never bypass an operator-configured key binding.
    const ownerManual = manualEntryFor(
      params.accountConfig.pkiManuallyVerified,
      params.senderNodeNum,
    );
    if (ownerManual?.keyInvalid) {
      return decide("drop", "manual-key-mismatch");
    }
    if (ownerManual?.key) {
      const pin = getNodeKeyPin(params.accountId, params.senderNodeNum);
      if (!pin || !keyBytesEqual(pin.publicKey, ownerManual.key)) {
        return decide("drop", "manual-key-mismatch");
      }
    }
    return decide("admit");
  }

  // Rule 3 — operator manual-verification list, unconditional in every mode.
  // DMs only: group traffic from listed ids follows the normal group rules.
  if (!params.isGroup) {
    const manual = manualEntryFor(params.accountConfig.pkiManuallyVerified, params.senderNodeNum);
    if (manual) {
      if (manual.keyInvalid) {
        // The schema rejects this at load; at runtime never silently
        // downgrade a key-bound entry to a weaker check.
        return decide("drop", "manual-key-mismatch");
      }
      if (manual.key) {
        // Key-bound form: the configured full key is the trust root, so a
        // byte-exact pin match proves the contact — first contact included.
        if (grade !== "pki-verified") {
          return decide("drop", "manual-unverified");
        }
        const pin = getNodeKeyPin(params.accountId, params.senderNodeNum);
        if (!pin || !keyBytesEqual(pin.publicKey, manual.key)) {
          return decide("drop", "manual-key-mismatch");
        }
        return decide("admit");
      }
      // Id-only form: out-of-band verification gates on a pin with
      // established continuity that the operator marked.
      if (grade !== "pki-verified" || firstContact) {
        return decide("drop", "manual-unverified");
      }
      const pin = getNodeKeyPin(params.accountId, params.senderNodeNum);
      if (!pin?.manuallyVerified) {
        return decide("drop", "manual-unverified");
      }
      return decide("admit");
    }
  }

  // Rule 4 — key mismatch. Default drop; "unverified" is a legacy escape
  // hatch (under known-keys an anchored mismatch is still dropped by rule 6).
  if (grade === "mismatch" && pkiMismatch === "drop") {
    return decide("drop", "pki-mismatch");
  }

  // Rule 5 — strict: every DM must prove its key.
  if (!params.isGroup && dmIdentity === "strict" && grade !== "pki-verified") {
    return decide("drop", "strict-unverified");
  }

  // Rule 6 — known-keys: a number the keybook anchors (pin OR eviction
  // tombstone) must prove it. A tombstone anchors too — otherwise pin-flood
  // eviction would reopen impersonation of the evicted.
  if (
    !params.isGroup &&
    dmIdentity === "known-keys" &&
    grade !== "pki-verified" &&
    hasKeyAnchor(params.accountId, params.senderNodeNum)
  ) {
    return decide("drop", "known-key-unverified");
  }

  // Rule 7 — otherwise admit. Ordinary access policy decides from here; the
  // gate never grants what the policy would deny.
  return decide("admit");
}

// ---------------------------------------------------------------------------
// Drop logging — one throttled line per sender, fingerprints only
// ---------------------------------------------------------------------------

const DROP_LOG_THROTTLE_MS = 60_000;
const DROP_LOG_MAX_KEYS = 10_000;

type DropLogEntry = { lastLoggedAt: number; suppressed: number };
const dropLogState = new Map<string, DropLogEntry>();

export function formatIdentityGateDropLine(params: {
  accountId: string;
  isGroup: boolean;
  senderId: string;
  decision: IdentityGateDecision;
}): string {
  const kind = params.isGroup ? "group" : "DM";
  return (
    `[${params.accountId}] meshtastic: identity gate drop ${kind} ${params.senderId} ` +
    `(reason=${params.decision.reason ?? "unknown"} grade=${params.decision.grade} ` +
    `fp=${params.decision.keyFp ?? "none"})`
  );
}

/** One line per sender per 60 s; the next line carries suppressed=<n>. */
export function logIdentityGateDrop(params: {
  accountId: string;
  senderNodeNum: number;
  senderId: string;
  isGroup: boolean;
  decision: IdentityGateDecision;
  log: (line: string) => void;
  now?: number;
}): void {
  const now = params.now ?? Date.now();
  const key = `${params.accountId}:${params.senderNodeNum}`;
  const entry = dropLogState.get(key);
  if (entry && now - entry.lastLoggedAt < DROP_LOG_THROTTLE_MS) {
    entry.suppressed += 1;
    return;
  }
  let line = formatIdentityGateDropLine({
    accountId: params.accountId,
    isGroup: params.isGroup,
    senderId: params.senderId,
    decision: params.decision,
  });
  if (entry && entry.suppressed > 0) {
    line += ` suppressed=${entry.suppressed}`;
  }
  if (!entry) {
    if (dropLogState.size >= DROP_LOG_MAX_KEYS) {
      const oldest = dropLogState.keys().next().value;
      if (oldest !== undefined) {
        dropLogState.delete(oldest);
      }
    }
    dropLogState.set(key, { lastLoggedAt: now, suppressed: 0 });
  } else {
    entry.lastLoggedAt = now;
    entry.suppressed = 0;
  }
  params.log(line);
}

/** @internal Clears throttle state between tests. */
export function resetIdentityGateThrottleForTests(): void {
  dropLogState.clear();
}

// ---------------------------------------------------------------------------
// Startup checks — one line per condition, once per channel start
// ---------------------------------------------------------------------------

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) {
      return a[i]! < b[i]! ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Gateway radio firmware below 2.7.15 => CVE-2025-53627 warn line; null
 * otherwise or when the version string is unparseable. Defence in depth
 * only — the gate is safe without it.
 */
export function firmwareStartupLine(accountId: string, firmwareVersion?: string): string | null {
  if (!firmwareVersion) {
    return null;
  }
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(firmwareVersion.trim());
  if (!m) {
    return null;
  }
  const version = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (compareVersions(version, [2, 7, 15]) >= 0) {
    return null;
  }
  return (
    `[${accountId}] meshtastic: WARN gateway radio firmware ${firmwareVersion} is below 2.7.15 — ` +
    "CVE-2025-53627 (channel-key DM downgrade); update the radio firmware " +
    "(defence in depth — the identity gate enforces regardless)`".replace("`", "")
  );
}

export function identityGateStartupLines(params: {
  accountId: string;
  accountConfig: GateAccountConfig;
  transport: string;
  coreConfig: CoreConfig;
}): Array<{ level: "warn" | "info"; line: string }> {
  const prefix = `[${params.accountId}] meshtastic:`;
  const lines: Array<{ level: "warn" | "info"; line: string }> = [];
  const dmIdentity = params.accountConfig.dmIdentity ?? "known-keys";
  const commandIdentity = params.accountConfig.commandIdentity ?? "verified";

  if (dmIdentity === "off") {
    lines.push({
      level: "warn",
      line: `${prefix} WARN dmIdentity=off — forged channel-PSK senders are ADMITTED (2026.10.35 behaviour); set dmIdentity to "known-keys" or "strict"`,
    });
  }
  if (commandIdentity === "policy") {
    lines.push({
      level: "warn",
      line: `${prefix} WARN commandIdentity=policy — forged channel-PSK senders are COMMAND-CAPABLE; set commandIdentity to "verified"`,
    });
  }
  if (params.transport === "http" && dmIdentity !== "off") {
    lines.push({
      level: "warn",
      line: `${prefix} WARN transport=http carries no PKI provenance — DMs from nodes with a pinned key are dropped under dmIdentity=${dmIdentity}; use transport=tcp (or serial)`,
    });
  }

  const owners = ownerMeshNodeNums(params.coreConfig);
  if (owners.size > 0) {
    const listing = [...owners].map((num) => {
      const pin = getNodeKeyPin(params.accountId, num);
      return `${formatMeshtasticNodeId(num)} (fp=${pin ? keyFpOfBase64(pin.publicKey) : "no pin"})`;
    });
    lines.push({
      level: "info",
      line: `${prefix} INFO commands.ownerAllowFrom resolves to mesh node(s) ${listing.join(", ")} — owner authority requires a PKI-verified DM with key continuity`,
    });
  }

  for (const entry of params.accountConfig.pkiManuallyVerified ?? []) {
    const parsed = parseManualVerificationEntry(String(entry));
    if (!parsed?.key) {
      continue;
    }
    const pin = getNodeKeyPin(params.accountId, parsed.num);
    if (!pin || keyBytesEqual(pin.publicKey, parsed.key)) {
      continue;
    }
    lines.push({
      level: "warn",
      line: `${prefix} WARN pkiManuallyVerified key for ${formatMeshtasticNodeId(parsed.num)} (configured fp=${keyFpOfBase64(parsed.key)}) differs from the stored pin (fp=${keyFpOfBase64(pin.publicKey)}) — keeping the pin; re-pin via channels.meshtastic.pkiRepin after a legitimate rotation`,
    });
  }

  return lines;
}
