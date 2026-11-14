import type {
  BlockStreamingCoalesceConfig,
  DmConfig,
  DmPolicy,
  GroupPolicy,
  GroupToolPolicyBySenderConfig,
  GroupToolPolicyConfig,
  MarkdownConfig,
  OpenClawConfig,
} from "openclaw/plugin-sdk/config-contracts";
import type { BaseProbeResult } from "openclaw/plugin-sdk/core";

export type MeshtasticGroupConfig = {
  requireMention?: boolean;
  tools?: GroupToolPolicyConfig;
  toolsBySender?: GroupToolPolicyBySenderConfig;
  skills?: string[];
  enabled?: boolean;
  allowFrom?: Array<string | number>;
  systemPrompt?: string;
};

import type { MeshtasticTransport } from "./transport.js";

export type { MeshtasticTransport };

/**
 * Sender identity grade for an inbound message (issue #7, phase 1).
 *
 * - "pki-verified": the attached radio's firmware AEAD-decrypted this packet
 *   with the per-node public key its node DB pins for the sender number, and
 *   the plugin keybook has continuity for that key (first-seen pin or match).
 * - "psk-grade": channel-PSK or cleartext provenance — the sender number is a
 *   claim, not proof (anyone holding the channel PSK can forge it).
 * - "mismatch": PKI-marked provenance that conflicts with the pinned key (or
 *   carries no key material at all) — never treated as verified.
 *
 * Trust root: the grade certifies the ATTACHED RADIO'S claim about the
 * packet, not physical reality. A compromised gateway-side radio can assert
 * any of it. Key fingerprints, never full keys, appear in logs.
 */
export type MeshtasticSenderIdentity = {
  grade: "pki-verified" | "psk-grade" | "mismatch";
  /** SHA-256 fingerprint prefix (12 hex chars) of the observed key, when known. */
  keyFp?: string;
  /**
   * True only when this key was just first observed (a brand-new pin). An
   * attacker can win a first-contact race, so consumers gating consequential
   * actions must require continuity (firstContact absent) — never parse
   * `detail` to distinguish the two.
   */
  firstContact?: boolean;
  /** Short machine-safe detail, e.g. "first-seen pin (TOFU)" or "key changed". */
  detail?: string;
};

export type MeshtasticAccountConfig = {
  name?: string;
  enabled?: boolean;
  /** Connection mode: HTTP API, native TCP protobuf (port 4403), or USB serial. */
  transport?: MeshtasticTransport;
  host?: string;
  port?: number;
  tls?: boolean;
  /** Device path for transport=serial (e.g. /dev/ttyUSB0). */
  serialPath?: string;
  baudRate?: number;
  dmPolicy?: DmPolicy;
  allowFrom?: Array<string | number>;
  defaultTo?: string;
  groupPolicy?: GroupPolicy;
  groupAllowFrom?: Array<string | number>;
  /** Default false: the send path refuses every channel/broadcast target (LoRa airtime rule). Set true to opt in to group transmission. Independent of this flag: the reserved broadcast address (4294967295 / ^all) is always refused. */
  groupTransmit?: boolean;
  groups?: Record<string, MeshtasticGroupConfig>;
  /** Mesh channel indices (0-7) to listen for broadcast messages. */
  channels?: number[];
  mentionPatterns?: string[];
  markdown?: MarkdownConfig;
  historyLimit?: number;
  dmHistoryLimit?: number;
  dms?: Record<string, DmConfig>;
  textChunkLimit?: number;
  /** Outbound flood guard: cap airtime packets per rolling window (defaults: 20/10min DMs, 3/10min group). Refuses with a retry hint when tripped. Set enabled:false to disable. */
  sendRateLimit?: { enabled?: boolean; maxSends?: number; windowMs?: number; groupMaxSends?: number };
  /** Inbound durability (#8): at-least-once delivery across gateway restarts. Admitted frames are logged locally before dispatch and replayed after a restart. Default ON; set enabled:false to opt out (delete the .sqlite + sidecars when opting out). */
  durability?: {
    enabled?: boolean;
    retentionDays?: number;
    maxEvents?: number;
    pruneBatch?: number;
    maxReplayAgeMs?: number;
    maxDispatchAttempts?: number;
    leaseMs?: number;
    dbPath?: string;
  };
  /**
   * PKI key-mismatch policy (issue #7): how a sender whose PKI provenance
   * conflicts with the pinned keybook entry is admitted. "drop" (default since
   * 2026.11.1) refuses it at the identity gate; "unverified" admits the
   * message marked unverified. With dmIdentity "known-keys" or "strict" a
   * mismatch is dropped anyway; "unverified" then only changes unanchored
   * anomalies. Tier-3 actions must fail closed on a mismatch
   * regardless of this setting.
   */
  pkiMismatch?: "unverified" | "drop";
  /**
   * DM sender-identity gate (issue #33, ClawScan MCP07). "known-keys"
   * (default): a DM from a number the keybook anchors (pin OR eviction
   * tombstone) must be pki-verified. "strict": every DM must be pki-verified
   * (drops pre-2.5 firmware nodes). "off": 2026.10.35 behaviour — forged
   * channel-PSK senders are admitted; logged at start, not recommended.
   */
  dmIdentity?: "known-keys" | "strict" | "off";
  /**
   * Command authority over the mesh (issue #33). "verified" (default):
   * commands run only from a pki-verified DM with key continuity; everything
   * else reaches the agent as plain text (CommandInterpretationSuppressed).
   * "policy": 2026.10.35 behaviour — forged senders are command-capable;
   * logged at start, not recommended.
   */
  commandIdentity?: "verified" | "policy";
  /**
   * Operator re-pin list (key rotation remediation, issue #7): node ids whose
   * stored key pins are cleared at channel start, so the node's next observed
   * key re-pins (TOFU). Use ONLY after a legitimate rotation (factory reset,
   * replaced radio, re-imported private key); remove the entry once the node
   * verifies again — while listed, every restart re-opens first-seen.
   */
  pkiRepin?: string[];
  /**
   * Operator manual-verification list (issue #7, enforced at the identity
   * gate since 2026.11.1 / issue #33): entries are a node id or the key-bound
   * form "!id=<base64 32-byte public key>" (read the key off the Meshtastic
   * app — never a 12-hex fingerprint; 48 bits can be ground). A listed id and
   * its DMs must be pki-verified; the id-only form also requires key
   * continuity and the verified mark, the key-bound form a byte-exact pin
   * match. These pins are never evicted.
   */
  pkiManuallyVerified?: string[];
  /** When true, inbound info logs include up to 80 characters of message text (default: metadata only). */
  logInboundMessageContent?: boolean;
  chunkMode?: "length" | "newline";
  blockStreaming?: boolean;
  blockStreamingCoalesce?: BlockStreamingCoalesceConfig;
  responsePrefix?: string;
};

type MeshtasticConfig = MeshtasticAccountConfig & {
  accounts?: Record<string, MeshtasticAccountConfig>;
  defaultAccount?: string;
};

export type CoreConfig = OpenClawConfig & {
  channels?: OpenClawConfig["channels"] & {
    meshtastic?: MeshtasticConfig;
  };
};

export type MeshtasticInboundMessage = {
  messageId: string;
  /** Conversation peer: node id for DMs, channel:N for groups. */
  target: string;
  senderNodeNum: number;
  senderId: string;
  /** Structured sender-identity annotation (issue #7). Rides the message object — never concatenated into text — and survives durability persistence. */
  senderIdentity?: MeshtasticSenderIdentity;
  text: string;
  timestamp: number;
  isGroup: boolean;
  meshChannel: number;
  replyToId?: string;
};

export type MeshtasticProbe = BaseProbeResult<string> & {
  transport: MeshtasticTransport;
  host: string;
  port: number;
  tls: boolean;
  serialPath?: string;
  latencyMs?: number;
};

export type { MeshtasticConfig };
