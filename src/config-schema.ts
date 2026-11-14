import {
  DmPolicySchema,
  GroupPolicySchema,
  MarkdownConfigSchema,
  ReplyRuntimeConfigSchemaShape,
  ToolPolicySchema,
  buildChannelConfigSchema,
  requireOpenAllowFrom,
} from "openclaw/plugin-sdk/channel-config-schema";
import { z } from "zod";
import { meshtasticChannelConfigUiHints } from "./config-ui-hints.js";
import { parseManualVerificationEntry, parseMeshtasticNodeNum } from "./normalize.js";

const MeshtasticGroupSchema = z
  .object({
    requireMention: z.boolean().optional(),
    tools: ToolPolicySchema,
    toolsBySender: z.record(z.string(), ToolPolicySchema).optional(),
    skills: z.array(z.string()).optional(),
    enabled: z.boolean().optional(),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    systemPrompt: z.string().optional(),
  })
  .strict();

const MeshtasticTransportSchema = z.enum(["http", "tcp", "serial"]);

/** Node-id list for PKI operator actions (issue #7): each entry must parse as a real node id (never 0, never the broadcast number). */
const MeshtasticNodeIdListSchema = z.array(z.string()).refine(
  (entries) =>
    entries.every((entry) => {
      const num = parseMeshtasticNodeNum(entry);
      return num !== undefined && num > 0 && num < 0xffffffff;
    }),
  { message: 'entries must be Meshtastic node ids (e.g. "!a1b2c3d4", "node:123", or decimal)' },
);

/** pkiManuallyVerified entries (issue #33): a node id, or key-bound as !id=<base64 of exactly 32 bytes>. */
const MeshtasticManualVerificationListSchema = z.array(z.string()).refine(
  (entries) =>
    entries.every((entry) => {
      const parsed = parseManualVerificationEntry(entry);
      return parsed !== null && !parsed.keyInvalid;
    }),
  {
    message:
      "entries must be Meshtastic node ids, optionally key-bound as !id=<base64 of exactly 32 bytes>",
  },
);

const MeshtasticAccountSchemaBase = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    transport: MeshtasticTransportSchema.optional().default("tcp"),
    host: z.string().optional(),
    port: z.number().int().min(1).max(65535).optional(),
    tls: z.boolean().optional(),
    serialPath: z.string().optional(),
    baudRate: z.number().int().min(9600).max(921600).optional(),
    dmPolicy: DmPolicySchema.optional().default("pairing"),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    defaultTo: z.string().optional(),
    groupPolicy: GroupPolicySchema.optional().default("disabled"),
    groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    groupTransmit: z.boolean().optional().default(false),
    groups: z.record(z.string(), MeshtasticGroupSchema.optional()).optional(),
    channels: z.array(z.number().int().min(0).max(7)).optional(),
    mentionPatterns: z.array(z.string()).optional(),
    markdown: MarkdownConfigSchema,
    ...ReplyRuntimeConfigSchemaShape,
    textChunkLimit: z.number().int().min(40).max(500).optional(),
    sendRateLimit: z
      .object({
        enabled: z.boolean().optional(),
        maxSends: z.number().int().min(1).optional(),
        windowMs: z.number().int().min(1_000).optional(),
        groupMaxSends: z.number().int().min(1).optional(),
      })
      .strict()
      .optional(),
    logInboundMessageContent: z.boolean().optional(),
    dmIdentity: z.enum(["known-keys", "strict", "off"]).optional().default("known-keys"),
    commandIdentity: z.enum(["verified", "policy"]).optional().default("verified"),
    pkiMismatch: z.enum(["unverified", "drop"]).optional().default("drop"),
    pkiRepin: MeshtasticNodeIdListSchema.optional(),
    pkiManuallyVerified: MeshtasticManualVerificationListSchema.optional(),
    durability: z
      .object({
        enabled: z.boolean().optional(),
        retentionDays: z.number().int().min(1).max(365).optional(),
        maxEvents: z.number().int().min(100).optional(),
        pruneBatch: z.number().int().min(10).optional(),
        maxReplayAgeMs: z.number().int().min(60_000).optional(),
        maxDispatchAttempts: z.number().int().min(1).max(10).optional(),
        leaseMs: z.number().int().min(10_000).optional(),
        dbPath: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const MeshtasticAccountSchema = MeshtasticAccountSchemaBase.superRefine((value, ctx) => {
  requireOpenAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message:
      'channels.meshtastic.dmPolicy="open" requires channels.meshtastic.allowFrom to include "*"',
  });
});

export const MeshtasticConfigSchema = MeshtasticAccountSchemaBase.extend({
  accounts: z.record(z.string(), MeshtasticAccountSchema.optional()).optional(),
  defaultAccount: z.string().optional(),
}).superRefine((value, ctx) => {
  requireOpenAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message:
      'channels.meshtastic.dmPolicy="open" requires channels.meshtastic.allowFrom to include "*"',
  });
});

export const MeshtasticChannelConfigSchema = buildChannelConfigSchema(MeshtasticConfigSchema, {
  uiHints: meshtasticChannelConfigUiHints,
});
