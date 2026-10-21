import { join } from "node:path";
import { runPassiveAccountLifecycle } from "openclaw/plugin-sdk/channel-outbound";
import {
  DEFAULT_DURABILITY_CONFIG,
  openDurabilityStore,
  type DurabilityStore,
} from "./durability.js";
import { pluginStateDir } from "./state-dir.js";

// Shared durability-store registry (#8, meshcore#48 review round-2 M-4): one
// open handle per db path for the PROCESS LIFETIME. Closing mid-turn silently
// loses dispatch marks, so release only drops the reference — the OS reclaims
// the handle at exit. The pending open is registered before awaiting so
// concurrent acquires share one handle.
const durabilityRegistry = new Map<
  string,
  { promise: Promise<DurabilityStore | null>; refs: number }
>();

async function acquireDurabilityStore(
  dbPath: string,
  log: (msg: string) => void,
): Promise<DurabilityStore | null> {
  const existing = durabilityRegistry.get(dbPath);
  if (existing) {
    existing.refs += 1;
    return existing.promise;
  }
  const promise = openDurabilityStore({ dbPath, log });
  durabilityRegistry.set(dbPath, { promise, refs: 1 });
  // A failed or unavailable open is never cached (review round-3 m11): drop
  // the entry so the next start retries instead of staying degraded forever.
  void promise
    .then((s) => {
      if (!s) {
        durabilityRegistry.delete(dbPath);
      }
    })
    .catch(() => {
      durabilityRegistry.delete(dbPath);
    });
  return promise;
}

function releaseDurabilityStore(dbPath: string): void {
  const entry = durabilityRegistry.get(dbPath);
  if (entry && entry.refs > 0) {
    entry.refs -= 1;
  }
}
import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/status-helpers";
import type { ResolvedMeshtasticAccount } from "./accounts.js";
import { createAccountStatusSink } from "./channel-api.js";
import { monitorMeshtasticProvider } from "./monitor.js";
import { formatMeshtasticEndpoint } from "./transport.js";
import type { RuntimeEnv } from "./runtime-api.js";
import type { CoreConfig } from "./types.js";

export async function startMeshtasticGatewayAccount(ctx: {
  cfg: CoreConfig;
  accountId: string;
  account: ResolvedMeshtasticAccount;
  runtime: RuntimeEnv;
  abortSignal: AbortSignal;
  setStatus: (next: ChannelAccountSnapshot) => void;
  log?: {
    info?: (message: string) => void;
  };
}): Promise<void> {
  const account = ctx.account;
  const statusSink = createAccountStatusSink({
    accountId: ctx.accountId,
    setStatus: ctx.setStatus,
  });
  if (!account.configured) {
    throw new Error(
      account.transport === "serial"
        ? `Meshtastic is not configured for account "${account.accountId}" (need serialPath in channels.meshtastic).`
        : `Meshtastic is not configured for account "${account.accountId}" (need host in channels.meshtastic).`,
    );
  }
  ctx.log?.info?.(
    `[${account.accountId}] starting Meshtastic provider (${account.transport}) at ${formatMeshtasticEndpoint(account)}`,
  );
  // Inbound durability (#8): shared store per dbPath, startup maintenance
  // (legacy admissions + expired leases + first prune), hourly pruning.
  // Default ON; disabled via channels.meshtastic.durability.enabled=false or
  // when node:sqlite is absent.
  // Defaults merge in code (review round-2 M-6): no schema default, so a
  // top-level enabled:false survives the per-account merge untouched.
  const durabilityCfg = { ...DEFAULT_DURABILITY_CONFIG, ...account.config.durability };
  const durabilityPath =
    durabilityCfg.dbPath ??
    join(pluginStateDir(), `meshtastic-durability-${account.accountId}.sqlite`);
  let durability: DurabilityStore | null = null;
  if (durabilityCfg.enabled !== false) {
    try {
      durability = await acquireDurabilityStore(durabilityPath, (line) => ctx.log?.info?.(line));
    } catch (err) {
      // Round-4 major 1: a store error must never take the channel down.
      ctx.log?.info?.(
        `[${account.accountId}] durability acquire failed (${err instanceof Error ? err.message : String(err)}) — continuing without durability`,
      );
      durability = null;
    }
    if (durability) {
      durability.startupSweep(account.accountId);
      durability.prune({
        retentionDays: durabilityCfg.retentionDays,
        maxEvents: durabilityCfg.maxEvents,
        batch: durabilityCfg.pruneBatch,
      });
    }
  }
  const pruneTimer = durability
    ? setInterval(() => {
        try {
          durability.prune({
            retentionDays: durabilityCfg.retentionDays,
            maxEvents: durabilityCfg.maxEvents,
            batch: durabilityCfg.pruneBatch,
          });
        } catch (err) {
          ctx.log?.info?.(`[${account.accountId}] durability prune failed: ${String(err)}`);
        }
        // Unconditional (m2): blanked bodies must not linger in the WAL for
        // the first retention window even when prune removed nothing.
        durability.checkpoint();
      }, 3_600_000)
    : null;
  pruneTimer?.unref?.();

  try {
    await runPassiveAccountLifecycle({
      abortSignal: ctx.abortSignal,
      start: async () =>
        await monitorMeshtasticProvider({
          accountId: account.accountId,
          config: ctx.cfg,
          runtime: ctx.runtime,
          abortSignal: ctx.abortSignal,
          statusSink,
          durability,
        }),
      stop: async (monitor) => {
        monitor.stop();
      },
    });
  } finally {
    // Cleanup must run even when the SDK never calls stop (failed connects).
    // Release ONLY what this invocation acquired (review round-2 M-4).
    if (pruneTimer) {
      clearInterval(pruneTimer);
    }
    if (durability) {
      releaseDurabilityStore(durabilityPath);
    }
  }
}
