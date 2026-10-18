import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import { formatNormalizedAllowFromEntries } from "openclaw/plugin-sdk/allow-from";
import {
  adaptScopedAccountAccessor,
  createScopedChannelConfigAdapter,
  createScopedDmSecurityResolver,
} from "openclaw/plugin-sdk/channel-config-helpers";
import { createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { createPairingPrefixStripper } from "openclaw/plugin-sdk/channel-pairing";
import { createAllowlistProviderOpenWarningCollector } from "openclaw/plugin-sdk/channel-policy";
import {
  createChannelDirectoryAdapter,
  createResolvedDirectoryEntriesLister,
} from "openclaw/plugin-sdk/directory-runtime";
import {
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
import {
  listMeshtasticAccountIds,
  resolveDefaultMeshtasticAccountId,
  resolveMeshtasticAccount,
  type ResolvedMeshtasticAccount,
} from "./accounts.js";
import {
  buildBaseChannelStatusSummary,
  DEFAULT_ACCOUNT_ID,
  PAIRING_APPROVED_MESSAGE,
  type ChannelPlugin,
} from "./channel-api.js";
import { MeshtasticChannelConfigSchema } from "./config-schema.js";
import { startMeshtasticGatewayAccount } from "./gateway.js";
import { meshtasticMessageAdapter } from "./message-adapter.js";
import {
  isMeshtasticGroupTarget,
  looksLikeMeshtasticTargetId,
  normalizeMeshtasticAllowEntry,
  normalizeMeshtasticMessagingTarget,
} from "./normalize.js";
import { meshtasticOutboundBaseAdapter } from "./outbound-base.js";
import { resolveMeshtasticGroupMatch, resolveMeshtasticRequireMention } from "./policy.js";
import { probeMeshtastic } from "./probe.js";
import { resolveMeshtasticOutboundSessionRoute } from "./session-route.js";
import { meshtasticSetupAdapter, meshtasticSetupWizard } from "./setup-surface.js";
import type { CoreConfig, MeshtasticProbe } from "./types.js";

const meta = {
  id: "meshtastic",
  label: "Meshtastic",
  selectionLabel: "Meshtastic (HTTP / TCP / Serial)",
  docsPath: "/channels/meshtastic",
  docsLabel: "meshtastic",
  blurb: "LoRa mesh messaging via Meshtastic protobuf (HTTP, TCP, or USB serial).",
  order: 68,
  detailLabel: "Meshtastic",
  systemImage: "antenna.radiowaves.left.and.right",
};

type MeshtasticChannelRuntimeModule = typeof import("./channel-runtime.js");

let meshtasticChannelRuntimePromise: Promise<MeshtasticChannelRuntimeModule> | undefined;

async function loadMeshtasticChannelRuntime(): Promise<MeshtasticChannelRuntimeModule> {
  meshtasticChannelRuntimePromise ??= import("./channel-runtime.js");
  return await meshtasticChannelRuntimePromise;
}

const listMeshtasticDirectoryPeersFromConfig =
  createResolvedDirectoryEntriesLister<ResolvedMeshtasticAccount>({
    kind: "user",
    resolveAccount: adaptScopedAccountAccessor(resolveMeshtasticAccount),
    resolveSources: (account) => [
      account.config.allowFrom ?? [],
      account.config.groupAllowFrom ?? [],
      ...Object.values(account.config.groups ?? {}).map((group) => group.allowFrom ?? []),
    ],
    normalizeId: (entry) => normalizeMeshtasticAllowEntry(entry) || null,
  });

const listMeshtasticDirectoryGroupsFromConfig =
  createResolvedDirectoryEntriesLister<ResolvedMeshtasticAccount>({
    kind: "group",
    resolveAccount: adaptScopedAccountAccessor(resolveMeshtasticAccount),
    resolveSources: (account) => [
      ...(account.config.channels ?? []).map((channelIndex) => `channel:${channelIndex}`),
      Object.keys(account.config.groups ?? {}),
    ],
    normalizeId: (entry) => {
      const normalized = normalizeMeshtasticMessagingTarget(String(entry));
      return normalized && isMeshtasticGroupTarget(normalized) ? normalized : null;
    },
  });

const meshtasticConfigAdapter = createScopedChannelConfigAdapter<
  ResolvedMeshtasticAccount,
  ResolvedMeshtasticAccount
>({
  sectionKey: "meshtastic",
  listAccountIds: listMeshtasticAccountIds,
  resolveAccount: adaptScopedAccountAccessor(resolveMeshtasticAccount),
  defaultAccountId: resolveDefaultMeshtasticAccountId,
  clearBaseFields: ["name", "host", "port", "tls", "channels"],
  resolveAllowFrom: (account) => account.config.allowFrom,
  formatAllowFrom: (allowFrom) =>
    formatNormalizedAllowFromEntries({
      allowFrom,
      normalizeEntry: normalizeMeshtasticAllowEntry,
    }),
  resolveDefaultTo: (account) => account.config.defaultTo,
});

const resolveMeshtasticDmPolicy = createScopedDmSecurityResolver<ResolvedMeshtasticAccount>({
  channelKey: "meshtastic",
  resolvePolicy: (account) => account.config.dmPolicy,
  resolveAllowFrom: (account) => account.config.allowFrom,
  policyPathSuffix: "dmPolicy",
  normalizeEntry: (entry) => normalizeMeshtasticAllowEntry(entry),
});

const collectMeshtasticGroupPolicyWarnings =
  createAllowlistProviderOpenWarningCollector<ResolvedMeshtasticAccount>({
    providerConfigPresent: (cfg) => cfg.channels?.meshtastic !== undefined,
    resolveGroupPolicy: (account) => account.config.groupPolicy,
    buildOpenWarning: {
      surface: "Meshtastic broadcast channels",
      openBehavior: "allows all configured mesh channels and senders",
      remediation:
        'Prefer channels.meshtastic.groupPolicy="allowlist" with channels.meshtastic.groups',
    },
  });

export const meshtasticPlugin: ChannelPlugin<ResolvedMeshtasticAccount, MeshtasticProbe> =
  createChatChannelPlugin({
    base: {
      id: "meshtastic",
      meta: {
        ...meta,
        quickstartAllowFrom: true,
      },
      setup: meshtasticSetupAdapter,
      setupWizard: meshtasticSetupWizard,
      capabilities: {
        chatTypes: ["direct", "group"],
        blockStreaming: true,
      },
      reload: { configPrefixes: ["channels.meshtastic"] },
      configSchema: MeshtasticChannelConfigSchema,
      config: {
        ...meshtasticConfigAdapter,
        hasConfiguredState: ({ env }) =>
          typeof env?.MESHTASTIC_HOST === "string" && env.MESHTASTIC_HOST.trim().length > 0,
        isConfigured: (account) => account.configured,
        describeAccount: (account) =>
          describeAccountSnapshot({
            account,
            configured: account.configured,
            extra: {
              host: account.host,
              port: account.port,
              tls: account.tls,
            },
          }),
      },
      groups: {
        resolveRequireMention: ({ cfg, accountId, groupId }) => {
          const account = resolveMeshtasticAccount({ cfg: cfg as CoreConfig, accountId });
          if (!groupId) {
            return false;
          }
          const match = resolveMeshtasticGroupMatch({
            groups: account.config.groups,
            target: groupId,
          });
          return resolveMeshtasticRequireMention({
            groupConfig: match.groupConfig,
            wildcardConfig: match.wildcardConfig,
          });
        },
        resolveToolPolicy: ({ cfg, accountId, groupId }) => {
          const account = resolveMeshtasticAccount({ cfg: cfg as CoreConfig, accountId });
          if (!groupId) {
            return undefined;
          }
          const match = resolveMeshtasticGroupMatch({
            groups: account.config.groups,
            target: groupId,
          });
          return match.groupConfig?.tools ?? match.wildcardConfig?.tools;
        },
      },
      messaging: {
        targetPrefixes: ["meshtastic"],
        normalizeTarget: normalizeMeshtasticMessagingTarget,
        targetResolver: {
          looksLikeId: looksLikeMeshtasticTargetId,
          hint: "<!nodeId|node:123|channel:0|broadcast>",
        },
        resolveOutboundSessionRoute: (params) => resolveMeshtasticOutboundSessionRoute(params),
      },
      message: meshtasticMessageAdapter,
      resolver: {
        resolveTargets: async ({ inputs, kind }) => {
          return inputs.map((input) => {
            const normalized = normalizeMeshtasticMessagingTarget(input);
            if (!normalized) {
              return {
                input,
                resolved: false,
                note: "invalid Meshtastic target",
              };
            }
            if (kind === "group") {
              if (!isMeshtasticGroupTarget(normalized)) {
                return {
                  input,
                  resolved: false,
                  note: "expected group target",
                };
              }
              return {
                input,
                resolved: true,
                id: normalized,
                name: normalized,
              };
            }
            if (isMeshtasticGroupTarget(normalized)) {
              return {
                input,
                resolved: false,
                note: "expected direct target",
              };
            }
            return {
              input,
              resolved: true,
              id: normalized,
              name: normalized,
            };
          });
        },
      },
      directory: createChannelDirectoryAdapter({
        listPeers: async (params) => listMeshtasticDirectoryPeersFromConfig(params),
        listGroups: async (params) => {
          const entries = await listMeshtasticDirectoryGroupsFromConfig(params);
          return entries.map((entry) => Object.assign({}, entry, { name: entry.id }));
        },
      }),
      status: createComputedAccountStatusAdapter<ResolvedMeshtasticAccount, MeshtasticProbe>({
        defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
        buildChannelSummary: ({ account, snapshot }) => ({
          ...buildBaseChannelStatusSummary(snapshot),
          host: account.host,
          port: snapshot.port,
          tls: account.tls,
          probe: snapshot.probe,
          lastProbeAt: snapshot.lastProbeAt ?? null,
        }),
        probeAccount: async ({ cfg, account, timeoutMs }) =>
          probeMeshtastic(cfg as CoreConfig, { accountId: account.accountId, timeoutMs }),
        resolveAccountSnapshot: ({ account }) => ({
          accountId: account.accountId,
          name: account.name,
          enabled: account.enabled,
          configured: account.configured,
          extra: {
            host: account.host,
            port: account.port,
            tls: account.tls,
          },
        }),
      }),
      gateway: {
        startAccount: async (ctx) =>
          await startMeshtasticGatewayAccount({
            ...ctx,
            cfg: ctx.cfg as CoreConfig,
          }),
      },
    },
    pairing: {
      text: {
        idLabel: "meshtasticNode",
        message: PAIRING_APPROVED_MESSAGE,
        normalizeAllowEntry: createPairingPrefixStripper(/^meshtastic:|^node:/i, (entry) =>
          normalizeMeshtasticAllowEntry(entry),
        ),
        notify: async ({ cfg, id, message }) => {
          const target = normalizeMeshtasticAllowEntry(id);
          if (!target) {
            throw new Error(`invalid Meshtastic pairing id: ${id}`);
          }
          const { sendMessageMeshtastic } = await loadMeshtasticChannelRuntime();
          await sendMessageMeshtastic(target, message, {
            cfg: cfg as CoreConfig,
          });
        },
      },
    },
    security: {
      resolveDmPolicy: resolveMeshtasticDmPolicy,
      collectWarnings: collectMeshtasticGroupPolicyWarnings,
    },
    outbound: {
      base: meshtasticOutboundBaseAdapter,
      attachedResults: {
        channel: "meshtastic",
        sendText: async ({ cfg, to, text, accountId, replyToId }) => {
          const { sendMessageMeshtastic } = await loadMeshtasticChannelRuntime();
          const result = await sendMessageMeshtastic(to, text, {
            cfg: cfg as CoreConfig,
            accountId: accountId ?? undefined,
            replyTo: replyToId ?? undefined,
          });
          return {
            messageId: result.messageId,
            target: {
              kind: "conversation" as const,
              id: result.target,
            },
            receipt: result.receipt,
          };
        },
      },
    },
  });
