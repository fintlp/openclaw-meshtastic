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
  /** Default false: the send path refuses every channel/broadcast target (LoRa airtime rule). Set true to opt in to group transmission. */
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
