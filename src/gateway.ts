import { runPassiveAccountLifecycle } from "openclaw/plugin-sdk/channel-outbound";
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
  await runPassiveAccountLifecycle({
    abortSignal: ctx.abortSignal,
    start: async () =>
      await monitorMeshtasticProvider({
        accountId: account.accountId,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        statusSink,
      }),
    stop: async (monitor) => {
      monitor.stop();
    },
  });
}
