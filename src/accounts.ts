import { createAccountListHelpers } from "openclaw/plugin-sdk/account-helpers";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { resolveAccountKey, resolveMergedAccountConfig } from "openclaw/plugin-sdk/account-resolution";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  defaultPortForTransport,
  DEFAULT_SERIAL_BAUD,
  normalizeMeshtasticTransport,
  type MeshtasticTransport,
} from "./transport.js";
import type { CoreConfig, MeshtasticAccountConfig } from "./types.js";

const TRUTHY_ENV = new Set(["true", "1", "yes", "on"]);
const DEFAULT_MESH_CHANNELS = [0];

export type ResolvedMeshtasticAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  configured: boolean;
  transport: MeshtasticTransport;
  host: string;
  port: number;
  tls: boolean;
  serialPath: string;
  baudRate: number;
  config: MeshtasticAccountConfig;
};

function parseTruthy(value?: string): boolean {
  if (!value) {
    return false;
  }
  return TRUTHY_ENV.has(normalizeLowercaseStringOrEmpty(value));
}

function parseIntEnv(value?: string): number | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
    return undefined;
  }
  return parsed;
}

function parseHostEnv(raw?: string): { host: string; port?: number } {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) {
    return { host: "" };
  }
  const colonIndex = trimmed.lastIndexOf(":");
  if (colonIndex > 0 && colonIndex < trimmed.length - 1) {
    const hostPart = trimmed.slice(0, colonIndex).trim();
    const portPart = trimmed.slice(colonIndex + 1).trim();
    const port = Number.parseInt(portPart, 10);
    if (hostPart && Number.isFinite(port) && port > 0 && port <= 65535) {
      return { host: hostPart, port };
    }
  }
  return { host: trimmed };
}

function resolveTransport(
  merged: MeshtasticAccountConfig,
  accountId: string,
): MeshtasticTransport {
  if (merged.transport) {
    return normalizeMeshtasticTransport(merged.transport);
  }
  if (accountId === DEFAULT_ACCOUNT_ID && process.env.MESHTASTIC_TRANSPORT?.trim()) {
    return normalizeMeshtasticTransport(process.env.MESHTASTIC_TRANSPORT);
  }
  if (merged.serialPath?.trim()) {
    return "serial";
  }
  if (accountId === DEFAULT_ACCOUNT_ID && process.env.MESHTASTIC_SERIAL?.trim()) {
    return "serial";
  }
  return "tcp";
}

const {
  listAccountIds: listMeshtasticAccountIds,
  resolveDefaultAccountId: resolveDefaultMeshtasticAccountId,
} = createAccountListHelpers("meshtastic", {
  normalizeAccountId,
  hasImplicitDefaultAccount: (cfg) => {
    const envHost = process.env.MESHTASTIC_HOST?.trim();
    const envSerial = process.env.MESHTASTIC_SERIAL?.trim();
    const configHost = cfg.channels?.meshtastic?.host?.trim();
    const configSerial = cfg.channels?.meshtastic?.serialPath?.trim();
    return Boolean(envHost || configHost || envSerial || configSerial);
  },
});
export { listMeshtasticAccountIds, resolveDefaultMeshtasticAccountId };

/**
 * The key an account is stored under in channels.meshtastic.accounts, or
 * undefined when it has no own section. Uses the same lookup the account
 * reader (resolveMergedAccountConfig below) applies, so a non-canonical stored
 * key ("Ops Team") is found for the normalized id ("ops-team"). Setup writers
 * and readers must go through this instead of indexing accounts[accountId].
 */
export function resolveMeshtasticAccountKey(
  cfg: CoreConfig,
  accountId?: string | null,
): string | undefined {
  return resolveAccountKey(
    cfg.channels?.meshtastic?.accounts as Record<string, unknown> | undefined,
    normalizeAccountId(accountId),
    normalizeAccountId,
  );
}

function mergeMeshtasticAccountConfig(cfg: CoreConfig, accountId: string): MeshtasticAccountConfig {
  return resolveMergedAccountConfig<MeshtasticAccountConfig>({
    channelConfig: cfg.channels?.meshtastic as MeshtasticAccountConfig | undefined,
    accounts: cfg.channels?.meshtastic?.accounts as
      | Record<string, Partial<MeshtasticAccountConfig>>
      | undefined,
    accountId,
    omitKeys: ["defaultAccount"],
    normalizeAccountId,
  });
}

export function resolveMeshtasticAccount(params: {
  cfg: CoreConfig;
  accountId?: string | null;
}): ResolvedMeshtasticAccount {
  const hasExplicitAccountId = Boolean(params.accountId?.trim());
  const baseEnabled = params.cfg.channels?.meshtastic?.enabled !== false;

  const resolve = (accountId: string) => {
    const merged = mergeMeshtasticAccountConfig(params.cfg, accountId);
    const accountEnabled = merged.enabled !== false;
    const enabled = baseEnabled && accountEnabled;
    const transport = resolveTransport(merged, accountId);

    const envHost =
      accountId === DEFAULT_ACCOUNT_ID ? parseHostEnv(process.env.MESHTASTIC_HOST) : { host: "" };
    const configHost = parseHostEnv(merged.host);
    const host = configHost.host || envHost.host;
    const envPort =
      accountId === DEFAULT_ACCOUNT_ID ? parseIntEnv(process.env.MESHTASTIC_PORT) : undefined;
    const tls =
      typeof merged.tls === "boolean"
        ? merged.tls
        : accountId === DEFAULT_ACCOUNT_ID && process.env.MESHTASTIC_TLS
          ? parseTruthy(process.env.MESHTASTIC_TLS)
          : false;
    const port =
      configHost.port ?? envHost.port ?? merged.port ?? envPort ?? defaultPortForTransport(transport);
    const envSerial =
      accountId === DEFAULT_ACCOUNT_ID ? normalizeOptionalString(process.env.MESHTASTIC_SERIAL) : "";
    const serialPath = normalizeOptionalString(merged.serialPath) ?? envSerial ?? "";
    const baudRate = merged.baudRate ?? DEFAULT_SERIAL_BAUD;
    const channels = merged.channels?.length ? merged.channels : DEFAULT_MESH_CHANNELS;

    const configured =
      transport === "serial" ? Boolean(serialPath) : Boolean(host);

    const config: MeshtasticAccountConfig = {
      ...merged,
      transport,
      host,
      port,
      tls,
      serialPath,
      baudRate,
      channels,
    };

    return {
      accountId,
      enabled,
      name: normalizeOptionalString(merged.name),
      configured,
      transport,
      host,
      port,
      tls,
      serialPath,
      baudRate,
      config,
    } satisfies ResolvedMeshtasticAccount;
  };

  const normalized = normalizeAccountId(params.accountId);
  const primary = resolve(normalized);
  if (hasExplicitAccountId) {
    return primary;
  }
  if (primary.configured) {
    return primary;
  }

  const fallbackId = resolveDefaultMeshtasticAccountId(params.cfg);
  if (fallbackId === primary.accountId) {
    return primary;
  }
  const fallback = resolve(fallbackId);
  if (!fallback.configured) {
    return primary;
  }
  return fallback;
}

export function listEnabledMeshtasticAccounts(cfg: CoreConfig): ResolvedMeshtasticAccount[] {
  return listMeshtasticAccountIds(cfg)
    .map((accountId) => resolveMeshtasticAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
