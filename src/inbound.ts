import {
  createChannelInboundEnvelopeBuilderAsync,
  logInboundDrop,
  resolveInboundSessionEnvelopeContextAsync,
} from "openclaw/plugin-sdk/channel-inbound";
import {
  channelIngressRoutes,
  createChannelIngressResolver,
  defineStableChannelIngressIdentity,
} from "openclaw/plugin-sdk/channel-ingress-runtime";
import { createChannelPairingController } from "openclaw/plugin-sdk/channel-pairing";
import {
  DEFAULT_DURABILITY_CONFIG,
  meshtasticDedupeKey,
  type DurabilityStore,
} from "./durability.js";
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
  /** Inbound durability store (#8). When present, session-bound frames are logged before dispatch and the cursor advances after the host accepts the turn. */
  durability?: DurabilityStore | null;
  /** Set when dispatching from the startup replay path: skips intake logging and binds dispatch marks to the stored event id. */
  replayOf?: number;
  /** The stored LOCAL receive time of a replayed event (for the agent-visible replay tag). */
  replayReceivedAt?: number;
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

  params.statusSink?.({
    lastInboundAt: params.replayOf !== undefined ? Date.now() : message.timestamp,
  });

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
  // Fail-closed (2026.10.27): with groupPolicy "allowlist" a channel message
  // must pass BOTH the channel gate and a sender gate. When neither
  // groupAllowFrom nor a per-group allowFrom names anyone, NOBODY is admitted.
  // Pre-2026.10.27 this combination silently became "open", letting every
  // sender on a listed public channel trigger the agent (the ClawHub audit
  // finding that produced this change).
  const accessGroupPolicy: MeshtasticGroupPolicy =
    groupPolicy === "open" &&
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

  // Replay path (#8): admission flipped while we were down (config changed).
  // The attempt was already counted at claim time; release the claim — the
  // event goes back to pending and dead-letters at maxDispatchAttempts.
  if (params.replayOf !== undefined && access.ingress.admission !== "dispatch") {
    params.durability?.releaseClaim(
      account.accountId,
      params.replayOf,
      `admission flipped on replay (${access.ingress.admission})`,
    );
    runtime.log?.(
      `meshtastic: replay event ${params.replayOf} no longer admitted (${access.ingress.admission}) — claim released`,
    );
    return;
  }

  // Durability duplicate probe (#8): persistent dedupe collapses firmware
  // retransmissions and reconnect re-deliveries BEFORE any dispatch work.
  const store = params.durability ?? null;
  const dedupeKey = meshtasticDedupeKey({
    senderNodeNum: message.senderNodeNum,
    packetId: message.messageId,
  });
  // m7: a duplicate hit on a COMPLETE row is a drop; a hit on a pending /
  // inflight row is a redelivery we must dispatch (its first attempt failed).
  const existingDupe =
    store && params.replayOf === undefined
      ? store.findDuplicate(account.accountId, dedupeKey)
      : null;
  if (existingDupe && (existingDupe.state === "dispatched" || existingDupe.state === "dead")) {
    runtime.log?.(
      `meshtastic: drop duplicate inbound (sender ${message.senderId} packet ${message.messageId})`,
    );
    return;
  }
  const redeliverEventId = existingDupe?.id;

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

  // Durability intake + claim (#8): session-bound frames are logged as
  // admitted (admission is decided above) and claimed with a lease BEFORE any
  // dispatch work. Attempts count at claim, so process deaths and crash loops
  // are bounded by maxDispatchAttempts.
  let durabilityEventId: number | undefined = params.replayOf ?? redeliverEventId;
  if (store && durabilityEventId === undefined) {
    const res = store.intake({
      accountId: account.accountId,
      dedupeKey,
      kind: message.isGroup ? "group" : "direct",
      peerId: message.isGroup ? message.target : message.senderId,
      senderLabel: message.senderId,
      senderTs: message.timestamp,
      body: rawBody,
      rawJson: JSON.stringify(message),
    });
    if (res.duplicate) {
      runtime.log?.(
        `meshtastic: drop duplicate inbound (sender ${message.senderId} packet ${message.messageId})`,
      );
      return;
    }
    if (res.id >= 0) {
      durabilityEventId = res.id;
    } else {
      // Partial store failure (review M-2): dispatch WITHOUT durability rather
      // than drop — persistence must never be a single point of failure.
      runtime.log?.("meshtastic: durability intake degraded — dispatching without persistence");
    }
  }
  // Live path claims its event (replay arrives pre-claimed by claimNext —
  // claiming twice would double-count the attempt).
  const durCfg = { ...DEFAULT_DURABILITY_CONFIG, ...account.config.durability };
  if (store && durabilityEventId !== undefined && params.replayOf === undefined) {
    const verdict = store.claim(
      account.accountId,
      durabilityEventId,
      durCfg.maxDispatchAttempts,
      durCfg.leaseMs,
    );
    if (verdict !== "claimed") {
      runtime.log?.(
        `meshtastic: inbound event ${durabilityEventId} not dispatched (claim: ${verdict})`,
      );
      return;
    }
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
    await resolveInboundSessionEnvelopeContextAsync({
      cfg: config as OpenClawConfig,
      agentId: route.agentId,
      sessionKey: route.sessionKey,
    });
  const buildEnvelope = await createChannelInboundEnvelopeBuilderAsync({
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
    ChannelStructuredContext:
      params.replayOf !== undefined
        ? [
            {
              label: "Meshtastic Replay",
              source: "meshtastic",
              type: "mesh_replay",
              payload: {
                replayed: true,
                receivedAt: params.replayReceivedAt ?? message.timestamp,
                senderTs: message.timestamp,
                replayedAt: Date.now(),
              },
            },
          ]
        : undefined,
  });

  try {
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
        onFinalize: (result: {
          dispatched: boolean;
          admission?: { kind?: string };
          dispatchResult?: { deferredToActiveRun?: "steer" | "followup" } | null;
        }) => {
          if (!store || durabilityEventId === undefined) {
            return;
          }
          if (result.dispatchResult?.deferredToActiveRun === "followup") {
            // Queued behind a busy session: the host has ACCEPTED it into its
            // follow-up queue (review round-3 m6) — mark dispatched. Residual,
            // documented: the queue is in-memory, so a host crash before the
            // drain loses that one follow-up; no plugin can close that gap.
            runtime.log?.(
              `meshtastic: event ${durabilityEventId} accepted into the host follow-up queue`,
            );
            store.markDispatched(account.accountId, durabilityEventId);
            return;
          }
          if (result.dispatched && result.admission?.kind === "dispatch") {
            store.markDispatched(account.accountId, durabilityEventId);
          } else {
            store.releaseClaim(
              account.accountId,
              durabilityEventId,
              `turn not dispatched (${result.admission?.kind ?? "unknown"})`,
            );
          }
        },
      }),
    },
  });
  } catch (err) {
    if (store && durabilityEventId !== undefined) {
      store.releaseClaim(
        account.accountId,
        durabilityEventId,
        err instanceof Error ? err.message : String(err),
      );
    }
    throw err;
  }
}
