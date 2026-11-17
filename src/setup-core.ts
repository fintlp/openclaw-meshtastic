import type { ChannelSetupAdapter, ChannelSetupInput } from "openclaw/plugin-sdk/channel-setup";
import type { DmPolicy } from "openclaw/plugin-sdk/config-contracts";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/routing";
import {
  applyAccountNameToChannelSection,
  createSetupInputPresenceValidator,
  createTopLevelChannelAllowFromSetter,
  createTopLevelChannelDmPolicySetter,
  patchScopedAccountConfig,
} from "openclaw/plugin-sdk/setup";
import { resolveMeshtasticAccount, resolveMeshtasticAccountKey } from "./accounts.js";
import { resolveMeshtasticEffectiveGroups } from "./policy.js";
import { splitHostPort } from "./setup-detect.js";
import {
  DEFAULT_SERIAL_BAUD,
  defaultPortForTransport,
  normalizeMeshtasticTransport,
} from "./transport.js";
import type { CoreConfig, MeshtasticAccountConfig, MeshtasticGroupConfig } from "./types.js";

const channel = "meshtastic" as const;
const setMeshtasticTopLevelDmPolicy = createTopLevelChannelDmPolicySetter({ channel });
const setMeshtasticTopLevelAllowFrom = createTopLevelChannelAllowFromSetter({ channel });

type MeshtasticSetupInput = ChannelSetupInput & {
  host?: string;
  port?: number | string;
  tls?: boolean;
  transport?: string;
  serialPath?: string;
  baudRate?: number | string;
  dmPolicy?: string;
  groupTransmit?: boolean | string;
  channels?: number[];
};

const DM_POLICIES: readonly string[] = ["pairing", "allowlist", "open", "disabled"];

function normalizeDmPolicyInput(raw?: string): DmPolicy | undefined {
  const value = raw?.trim().toLowerCase();
  return value && DM_POLICIES.includes(value) ? (value as DmPolicy) : undefined;
}

function normalizeBooleanInput(raw?: boolean | string): boolean | undefined {
  if (typeof raw === "boolean") {
    return raw;
  }
  const value = raw?.trim().toLowerCase();
  if (!value) {
    return undefined;
  }
  if (["true", "1", "yes", "on"].includes(value)) {
    return true;
  }
  if (["false", "0", "no", "off"].includes(value)) {
    return false;
  }
  return undefined;
}

export function parsePort(raw: string, fallback: number): number {
  const trimmed = raw.trim();
  if (!trimmed) {
    return fallback;
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 65535) {
    return fallback;
  }
  return parsed;
}

/** Baud rates live outside the port range, so they get their own parser (schema: 9600–921600). */
export function parseBaudRate(raw: string, fallback: number = DEFAULT_SERIAL_BAUD): number {
  const trimmed = raw.trim();
  if (!trimmed) {
    return fallback;
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed < 9600 || parsed > 921600) {
    return fallback;
  }
  return parsed;
}

export function updateMeshtasticAccountConfig(
  cfg: CoreConfig,
  accountId: string,
  patch: Partial<MeshtasticAccountConfig>,
): CoreConfig {
  const normalizedId = normalizeAccountId(accountId);
  // The SDK patch helper writes accounts[<normalized id>] and does not find an
  // account stored under a non-canonical key ("Ops Team"): it would add a
  // second "ops-team" section next to it. Patch the stored section in place.
  const storedKey =
    normalizedId === DEFAULT_ACCOUNT_ID ? undefined : resolveMeshtasticAccountKey(cfg, normalizedId);
  const section = cfg.channels?.meshtastic;
  if (storedKey !== undefined && storedKey !== normalizedId && section) {
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        meshtastic: {
          ...section,
          accounts: {
            ...section.accounts,
            [storedKey]: { ...section.accounts?.[storedKey], ...patch },
          },
        },
      },
    } as CoreConfig;
  }
  return patchScopedAccountConfig({
    cfg,
    channelKey: channel,
    accountId,
    patch,
    ensureChannelEnabled: false,
    ensureAccountEnabled: false,
  }) as CoreConfig;
}

export function setMeshtasticDmPolicy(cfg: CoreConfig, dmPolicy: DmPolicy): CoreConfig {
  return setMeshtasticTopLevelDmPolicy(cfg, dmPolicy) as CoreConfig;
}

export function setMeshtasticAllowFrom(cfg: CoreConfig, allowFrom: string[]): CoreConfig {
  return setMeshtasticTopLevelAllowFrom(cfg, allowFrom) as CoreConfig;
}

/**
 * Policy-only group step. Never touches \`groups\`: the host wizard calls
 * setPolicy("allowlist") and then applyAllowlist(entries), so the policy step
 * must not clear the map before the entries are merged (#49).
 */
export function setMeshtasticGroupPolicy(
  cfg: CoreConfig,
  accountId: string,
  policy: "open" | "allowlist" | "disabled",
): CoreConfig {
  return updateMeshtasticAccountConfig(cfg, accountId, { enabled: true, groupPolicy: policy });
}

function sameKeySet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((key) => right.has(key));
}

/**
 * Merge entered group entries into the existing group objects. Retained keys
 * keep their object (and position) exactly; new keys get {}; removed keys are
 * dropped.
 */
function mergeMeshtasticGroupEntries(
  base: Record<string, MeshtasticGroupConfig>,
  entries: readonly string[],
  normalizeGroupEntry: (raw: string) => string | null,
): Record<string, MeshtasticGroupConfig> {
  const wanted = new Set(entries);
  const merged: Record<string, MeshtasticGroupConfig> = {};
  const seen = new Set<string>();
  for (const [key, value] of Object.entries(base)) {
    // The prefill shows stored keys; entries come back normalized.
    const normalizedKey = normalizeGroupEntry(key) ?? key;
    if (wanted.has(key) || wanted.has(normalizedKey)) {
      merged[key] = value;
      seen.add(key);
      seen.add(normalizedKey);
    }
  }
  for (const entry of entries) {
    if (!seen.has(entry)) {
      merged[entry] = {};
      seen.add(entry);
    }
  }
  return merged;
}

export function setMeshtasticGroupAccess(
  cfg: CoreConfig,
  accountId: string,
  policy: "open" | "allowlist" | "disabled",
  entries: string[],
  normalizeGroupEntry: (raw: string) => string | null,
): CoreConfig {
  if (policy !== "allowlist") {
    return setMeshtasticGroupPolicy(cfg, accountId, policy);
  }
  const normalizedEntries = [
    ...new Set(
      entries.map((entry) => normalizeGroupEntry(entry)).filter((entry): entry is string => Boolean(entry)),
    ),
  ];
  const account = resolveMeshtasticAccount({ cfg, accountId });
  const storedKey = resolveMeshtasticAccountKey(cfg, accountId);
  const ownGroups =
    normalizeAccountId(accountId) === DEFAULT_ACCOUNT_ID
      ? cfg.channels?.meshtastic?.groups
      : storedKey === undefined
        ? undefined
        : cfg.channels?.meshtastic?.accounts?.[storedKey]?.groups;
  const effectiveKeys = Object.keys(resolveMeshtasticEffectiveGroups({ cfg, account }) ?? {}).map(
    (key) => normalizeGroupEntry(key) ?? key,
  );
  // No own groups and the operator kept what is effectively in force: do not
  // freeze inherited root groups into the account (later root edits must keep
  // applying). Policy/enabled are still applied.
  if (Object.keys(ownGroups ?? {}).length === 0 && sameKeySet(normalizedEntries, effectiveKeys)) {
    return updateMeshtasticAccountConfig(cfg, accountId, { enabled: true, groupPolicy: "allowlist" });
  }
  return updateMeshtasticAccountConfig(cfg, accountId, {
    enabled: true,
    groupPolicy: "allowlist",
    groups: mergeMeshtasticGroupEntries(account.config.groups ?? {}, normalizedEntries, normalizeGroupEntry),
  });
}

export const meshtasticSetupAdapter: ChannelSetupAdapter = {
  resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
  applyAccountName: ({ cfg, accountId, name }) =>
    applyAccountNameToChannelSection({
      cfg,
      channelKey: channel,
      accountId,
      name,
    }),
  validateInput: createSetupInputPresenceValidator({
    whenNotUseEnv: [
      { someOf: ["host", "serialPath"], message: "Meshtastic requires host (http/tcp) or serialPath (serial)." },
    ],
  }),
  applyAccountConfig: ({ cfg, accountId, input }) => {
    const setupInput = input as MeshtasticSetupInput;
    const namedConfig = applyAccountNameToChannelSection({
      cfg,
      channelKey: channel,
      accountId,
      name: setupInput.name,
    });
    const hostParts = setupInput.host?.trim() ? splitHostPort(setupInput.host) : undefined;
    const transport = setupInput.transport
      ? normalizeMeshtasticTransport(setupInput.transport)
      : setupInput.serialPath?.trim()
        ? "serial"
        : undefined;
    const portInput =
      typeof setupInput.port === "number" ? String(setupInput.port) : (setupInput.port ?? "");
    const portDefault = defaultPortForTransport(transport ?? "http");
    const baudInput =
      typeof setupInput.baudRate === "number"
        ? String(setupInput.baudRate)
        : (setupInput.baudRate ?? "");
    const patch: Partial<MeshtasticAccountConfig> = {
      enabled: true,
      transport,
      host: hostParts?.host || undefined,
      port:
        transport === "serial"
          ? undefined
          : parsePort(portInput, hostParts?.port ?? portDefault),
      tls: setupInput.tls,
      serialPath: setupInput.serialPath?.trim() || undefined,
      baudRate: baudInput ? parseBaudRate(baudInput) : undefined,
      dmPolicy: normalizeDmPolicyInput(setupInput.dmPolicy),
      groupTransmit: normalizeBooleanInput(setupInput.groupTransmit),
      channels: setupInput.channels?.length ? setupInput.channels : undefined,
    };
    return updateMeshtasticAccountConfig(namedConfig as CoreConfig, accountId, patch);
  },
};
