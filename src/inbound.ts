import {
  createChannelInboundEnvelopeBuilder,
  logInboundDrop,
  resolveInboundSessionEnvelopeContext,
} from "openclaw/plugin-sdk/channel-inbound";
import {
  channelIngressRoutes,
  createChannelIngressResolver,
  defineStableChannelIngressIdentity,
} from "openclaw/plugin-sdk/channel-ingress-runtime";
import { createChannelPairingController } from "openclaw/plugin-sdk/channel-pairing";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  deliverFormattedTextWithAttachments,
  type OutboundReplyPayload,
} from "openclaw/plugin-sdk/reply-payload";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import {
  GROUP_POLICY_BLOCKED_LABEL,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "openclaw/plugin-sdk/runtime-group-policy";
import { normalizeStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { ResolvedMeshtasticAccount } from "./accounts.js";
import {
  buildMeshtasticAllowlistCandidates,
  formatMeshtasticNodeId,
  normalizeMeshtasticAllowEntry,
} from "./normalize.js";
import { resolveMeshtasticGroupMatch, resolveMeshtasticRequireMention } from "./policy.js";
import { getMeshtasticRuntime } from "./runtime.js";
import { sendMessageMeshtastic } from "./send.js";
import type { CoreConfig, MeshtasticInboundMessage } from "./types.js";

const CHANNEL_ID = "meshtastic" as const;
type MeshtasticGroupPolicy = "open" | "allowlist" | "disabled";

const meshtasticIngressIdentity = defineStableChannelIngressIdentity({
  key: "meshtastic-node",
  normalizeEntry: normalizeMeshtasticAllowEntry,
  normalizeSubject: normalizeMeshtasticAllowEntry,
  sensitivity: "pii",
  isWildcardEntry: (entry) => normalizeMeshtasticAllowEntry(entry) === "*",
  resolveEntryId: ({ entryIndex }) => `meshtastic-entry-${entryIndex + 1}:node`,
});

function hasEntries(entries: Array<string | number> | undefined): boolean {
  return normalizeStringEntries(entries).some((entry) => normalizeMeshtasticAllowEntry(entry));
}

function createMeshtasticIngressSubject(message: MeshtasticInboundMessage) {
  const candidates = buildMeshtasticAllowlistCandidates(message.senderNodeNum);
  return {
    stableId: candidates[0] ?? formatMeshtasticNodeId(message.senderNodeNum),
    aliases: {
      "meshtastic-node": formatMeshtasticNodeId(message.senderNodeNum),
    },
  };
}

function routeDescriptorsForMeshtasticGroup(params: {
  isGroup: boolean;
  groupPolicy: MeshtasticGroupPolicy;
  groupAllowed: boolean;
  hasConfiguredGroups: boolean;
  groupEnabled: boolean;
  routeGroupAllowFrom: string[];
}) {
  if (!params.isGroup) {
    return [];
  }
  return channelIngressRoutes(
    params.groupPolicy === "allowlist" && {
      id: "meshtastic:channel",
      allowed: params.hasConfiguredGroups && params.groupAllowed,
      precedence: 0,
      matchId: "meshtastic-channel",
      blockReason: "channel_not_allowlisted",
    },
    !params.groupEnabled && {
      id: "meshtastic:channel-enabled",
      enabled: false,
      precedence: 10,
      blockReason: "channel_disabled",
    },
    hasEntries(params.routeGroupAllowFrom) && {
      id: "meshtastic:channel-sender",
      precedence: 20,
      senderPolicy: "replace",
      senderAllowFrom: params.routeGroupAllowFrom,
    },
  );
}

async function deliverMeshtasticReply(params: {
  payload: OutboundReplyPayload;
  cfg: CoreConfig;
  target: string;
  accountId: string;
  sendReply?: (target: string, text: string, replyToId?: string) => Promise<void>;
  statusSink?: (patch: { lastOutboundAt?: number }) => void;
}) {
  await deliverFormattedTextWithAttachments({
    payload: params.payload,
    send: async ({ text, replyToId }) => {
      if (params.sendReply) {
        await params.sendReply(params.target, text, replyToId);
      } else {
        await sendMessageMeshtastic(params.target, text, {
          cfg: params.cfg,
          accountId: params.accountId,
          replyTo: replyToId,
        });
      }
      params.statusSink?.({ lastOutboundAt: Date.now() });
    },
  });
}

export async function handleMeshtasticInbound(params: {
  message: MeshtasticInboundMessage;
  account: ResolvedMeshtasticAccount;
  config: CoreConfig;
  runtime: RuntimeEnv;
  myNodeNum?: number | null;
  sendReply?: (target: string, text: string, replyToId?: string) => Promise<void>;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
}): Promise<void> {
  const { message, account, config, runtime } = params;
  const core = getMeshtasticRuntime();
  const pairing = createChannelPairingController({
    core,
    channel: CHANNEL_ID,
    accountId: account.accountId,
  });

  const rawBody = message.text?.trim() ?? "";
  if (!rawBody) {
    return;
  }

  params.statusSink?.({ lastInboundAt: message.timestamp });

  const dmPolicy = account.config.dmPolicy ?? "pairing";
  const defaultGroupPolicy = resolveDefaultGroupPolicy(config);
  const { groupPolicy, providerMissingFallbackApplied } =
    resolveAllowlistProviderRuntimeGroupPolicy({
      providerConfigPresent: config.channels?.meshtastic !== undefined,
      groupPolicy: account.config.groupPolicy,
      defaultGroupPolicy,
    });
  warnMissingProviderGroupPolicyFallbackOnce({
    providerMissingFallbackApplied,
    providerKey: "meshtastic",
    accountId: account.accountId,
    blockedLabel: GROUP_POLICY_BLOCKED_LABEL.channel,
    log: (line) => runtime.log?.(line),
  });

  const groupMatch = resolveMeshtasticGroupMatch({
    groups: account.config.groups,
    target: message.target,
  });

  const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
    cfg: config as OpenClawConfig,
    surface: CHANNEL_ID,
  });
  const hasControlCommand = core.channel.text.hasControlCommand(rawBody, config as OpenClawConfig);
  const mentionRegexes = core.channel.mentions.buildMentionRegexes(config as OpenClawConfig);
  const wasMentioned = core.channel.mentions.matchesMentionPatterns(rawBody, mentionRegexes);
  const requireMention = message.isGroup
    ? resolveMeshtasticRequireMention({
        groupConfig: groupMatch.groupConfig,
        wildcardConfig: groupMatch.wildcardConfig,
      })
    : false;
  const routeGroupAllowFrom = normalizeStringEntries(
    groupMatch.groupConfig?.allowFrom?.length
      ? groupMatch.groupConfig.allowFrom
      : groupMatch.wildcardConfig?.allowFrom,
  );
  const channelAllowlistedWithoutSenderFilter =
    groupPolicy === "allowlist" &&
    message.isGroup &&
    groupMatch.allowed &&
    groupMatch.hasConfiguredGroups &&
    !hasEntries(account.config.groupAllowFrom) &&
    !hasEntries(routeGroupAllowFrom);
  const accessGroupPolicy: MeshtasticGroupPolicy = channelAllowlistedWithoutSenderFilter
    ? "open"
    : groupPolicy === "open" &&
        (hasEntries(account.config.groupAllowFrom) || hasEntries(routeGroupAllowFrom))
      ? "allowlist"
      : groupPolicy;

  const access = await createChannelIngressResolver({
    channelId: CHANNEL_ID,
    accountId: account.accountId,
    identity: meshtasticIngressIdentity,
    cfg: config as OpenClawConfig,
    readStoreAllowFrom: async () => await pairing.readAllowFromStore(),
  }).message({
    subject: createMeshtasticIngressSubject(message),
    conversation: {
      kind: message.isGroup ? "group" : "direct",
      id: message.target,
    },
    route: routeDescriptorsForMeshtasticGroup({
      isGroup: message.isGroup,
      groupPolicy,
      groupAllowed: groupMatch.allowed,
      hasConfiguredGroups: groupMatch.hasConfiguredGroups,
      groupEnabled:
        groupMatch.groupConfig?.enabled !== false && groupMatch.wildcardConfig?.enabled !== false,
      routeGroupAllowFrom,
    }),
    mentionFacts: message.isGroup
      ? {
          canDetectMention: true,
          wasMentioned,
          hasAnyMention: wasMentioned,
        }
      : undefined,
    dmPolicy,
    groupPolicy: accessGroupPolicy,
    policy: {
      groupAllowFromFallbackToAllowFrom: false,
      activation: {
        requireMention: message.isGroup && requireMention,
        allowTextCommands,
      },
    },
    allowFrom: account.config.allowFrom,
    groupAllowFrom: account.config.groupAllowFrom,
    command: {
      allowTextCommands,
      hasControlCommand,
    },
  });
  const commandAuthorized = access.commandAccess.authorized;

  if (access.ingress.admission === "pairing-required") {
    await pairing.issueChallenge({
      senderId: message.senderId,
      senderIdLine: `Your Meshtastic node id: ${message.senderId}`,
      meta: { name: message.senderId },
      sendPairingReply: async (text) => {
        await deliverMeshtasticReply({
          payload: { text },
          cfg: config,
          target: message.senderId,
          accountId: account.accountId,
          sendReply: params.sendReply,
          statusSink: params.statusSink,
        });
      },
      onReplyError: (err) => {
        runtime.error?.(`meshtastic: pairing reply failed for ${message.senderId}: ${String(err)}`);
      },
    });
    runtime.log?.(`meshtastic: drop DM sender ${message.senderId} (dmPolicy=${dmPolicy})`);
    return;
  }
  if (access.ingress.admission === "skip") {
    runtime.log?.(`meshtastic: drop channel ${message.target} (missing-mention)`);
    return;
  }
  if (access.ingress.admission !== "dispatch") {
    if (
      message.isGroup &&
      access.ingress.decisiveGateId === "command" &&
      access.commandAccess.shouldBlockControlCommand
    ) {
      logInboundDrop({
        log: (line) => runtime.log?.(line),
        channel: CHANNEL_ID,
        reason: "control command (unauthorized)",
        target: message.senderId,
      });
      return;
    }
    if (message.isGroup) {
      if (access.routeAccess.reason === "channel_not_allowlisted") {
        runtime.log?.(`meshtastic: drop channel ${message.target} (not allowlisted)`);
      } else if (access.routeAccess.reason === "channel_disabled") {
        runtime.log?.(`meshtastic: drop channel ${message.target} (disabled)`);
      } else {
        runtime.log?.(`meshtastic: drop group sender ${message.senderId} (policy=${groupPolicy})`);
      }
    } else {
      runtime.log?.(`meshtastic: drop DM sender ${message.senderId} (dmPolicy=${dmPolicy})`);
    }
    return;
  }

  const peerId = message.isGroup ? message.target : message.senderId;
  const route = resolveAgentRoute({
    cfg: config as OpenClawConfig,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    peer: {
      kind: message.isGroup ? "group" : "direct",
      id: peerId,
    },
  });

  const fromLabel = message.isGroup ? message.target : message.senderId;
  const { storePath, envelopeOptions, previousTimestamp } =
    resolveInboundSessionEnvelopeContext({
      cfg: config as OpenClawConfig,
      agentId: route.agentId,
      sessionKey: route.sessionKey,
    });
  const buildEnvelope = createChannelInboundEnvelopeBuilder({
    cfg: config as OpenClawConfig,
    route: { agentId: route.agentId, sessionKey: route.sessionKey },
  });
  const body = buildEnvelope({
    channel: "Meshtastic",
    from: fromLabel,
    timestamp: message.timestamp,
    body: rawBody,
    previousTimestamp,
    envelope: envelopeOptions,
  });

  const groupSystemPrompt = groupMatch.groupConfig?.systemPrompt?.trim() || undefined;

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: message.isGroup
      ? `meshtastic:channel:${message.target}`
      : `meshtastic:${message.senderId}`,
    To: `meshtastic:${peerId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: message.isGroup ? "group" : "direct",
    ConversationLabel: fromLabel,
    SenderName: message.senderId,
    SenderId: message.senderId,
    GroupSubject: message.isGroup ? message.target : undefined,
    GroupSystemPrompt: message.isGroup ? groupSystemPrompt : undefined,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    WasMentioned: message.isGroup ? wasMentioned : undefined,
    MessageSid: message.messageId,
    Timestamp: message.timestamp,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: `meshtastic:${peerId}`,
    CommandAuthorized: commandAuthorized,
    ReplyToId: message.replyToId,
  });

  await core.channel.inbound.run({
    channel: CHANNEL_ID,
    accountId: account.accountId,
    raw: message,
    adapter: {
      ingest: () => ({
        id: message.messageId,
        timestamp: message.timestamp,
        rawText: rawBody,
        raw: message,
      }),
      classify: () => ({
        canStartAgentTurn: true,
        kind: "message" as const,
      }),
      resolveTurn: () => ({
        cfg: config as OpenClawConfig,
        channel: CHANNEL_ID,
        accountId: account.accountId,
        agentId: route.agentId,
        routeSessionKey: route.sessionKey,
        storePath,
        ctxPayload,
        recordInboundSession: core.channel.session.recordInboundSession,
        dispatchReplyWithBufferedBlockDispatcher:
          core.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
        delivery: {
          deliver: async (payload) => {
            await deliverMeshtasticReply({
              payload,
              cfg: config,
              target: peerId,
              accountId: account.accountId,
              sendReply: params.sendReply,
              statusSink: params.statusSink,
            });
          },
          onError: (err, info) => {
            runtime.error?.(`meshtastic ${info.kind} reply failed: ${err instanceof Error ? err.message : JSON.stringify(err)}`);
          },
        },
        replyPipeline: {},
        replyOptions: {
          // Meshtastic is plain text over LoRa; message_tool_only adds an internal
          // delivery hint to the agent prompt and expects visible sends via the
          // message tool, which does not fit this channel.
          sourceReplyDeliveryMode: "automatic",
          skillFilter: groupMatch.groupConfig?.skills,
          disableBlockStreaming:
            typeof account.config.blockStreaming === "boolean"
              ? !account.config.blockStreaming
              : undefined,
        },
        record: {
          onRecordError: (err) => {
            runtime.error?.(`meshtastic: failed updating session meta: ${String(err)}`);
          },
        },
      }),
    },
  });
}
