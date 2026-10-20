import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/routing";
import type { ChannelSetupWizard } from "openclaw/plugin-sdk/setup";
import {
  createAllowFromSection,
  createPromptParsedAllowFromForAccount,
  createSetupTranslator,
  createStandardChannelSetupStatus,
  formatDocsLink,
  mergeAllowFromEntries,
  setSetupChannelEnabled,
  splitSetupEntries,
} from "openclaw/plugin-sdk/setup";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveDefaultMeshtasticAccountId, resolveMeshtasticAccount } from "./accounts.js";
import { probeMeshtastic } from "./probe.js";
import {
  normalizeMeshtasticAllowEntry,
  normalizeMeshtasticMessagingTarget,
  formatMeshtasticChannelTarget,
} from "./normalize.js";
import { diagnoseProbeFailure, listSerialPorts, splitHostPort } from "./setup-detect.js";
import { readMeshtasticNodeIdentity, type MeshtasticNodeIdentity } from "./setup-node-info.js";
import {
  meshtasticSetupAdapter,
  parseBaudRate,
  parsePort,
  setMeshtasticGroupAccess,
  updateMeshtasticAccountConfig,
} from "./setup-core.js";
import {
  DEFAULT_SERIAL_BAUD,
  defaultPortForTransport,
  formatMeshtasticEndpoint,
  type MeshtasticTransport,
} from "./transport.js";
import type { CoreConfig, MeshtasticAccountConfig } from "./types.js";

const t = createSetupTranslator();
const channel = "meshtastic" as const;

function normalizeGroupEntry(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed === "*") {
    return "*";
  }
  return normalizeMeshtasticMessagingTarget(trimmed) ?? trimmed;
}

function resolveMeshtasticConfigKeys(accountId?: string): { policyKey: string; allowFromKey: string } {
  if (accountId && accountId !== DEFAULT_ACCOUNT_ID) {
    return {
      policyKey: `channels.meshtastic.accounts.${accountId}.dmPolicy`,
      allowFromKey: `channels.meshtastic.accounts.${accountId}.allowFrom`,
    };
  }
  return {
    policyKey: "channels.meshtastic.dmPolicy",
    allowFromKey: "channels.meshtastic.allowFrom",
  };
}

function readAccountSection(
  cfg: CoreConfig,
  accountId: string,
): MeshtasticAccountConfig | undefined {
  const section = cfg.channels?.meshtastic;
  if (!section) {
    return undefined;
  }
  if (accountId === DEFAULT_ACCOUNT_ID) {
    return section;
  }
  return section.accounts?.[accountId];
}

/** Mesh group entries created during setup default to mention-gated: the
 * agent may listen, but only speaks (when groupTransmit is opted into) when
 * addressed. Existing explicit values are never clobbered. */
function withDefaultRequireMention(cfg: CoreConfig, accountId: string): CoreConfig {
  const section = readAccountSection(cfg, accountId);
  const groups = section?.groups;
  if (!groups || typeof groups !== "object") {
    return cfg;
  }
  let changed = false;
  const nextGroups = Object.fromEntries(
    Object.entries(groups).map(([key, value]) => {
      if (value && typeof value === "object" && value.requireMention === undefined) {
        changed = true;
        return [key, { ...value, requireMention: true }];
      }
      return [key, value];
    }),
  );
  if (!changed) {
    return cfg;
  }
  return updateMeshtasticAccountConfig(cfg, accountId, { groups: nextGroups });
}

export { meshtasticSetupAdapter };

export const meshtasticSetupWizard: ChannelSetupWizard = {
  channel,
  status: createStandardChannelSetupStatus({
    channelLabel: "Meshtastic",
    configuredLabel: t("wizard.channels.statusConfigured"),
    unconfiguredLabel: "Needs connection",
    configuredHint: t("wizard.channels.statusConfigured"),
    unconfiguredHint:
      "Set channels.meshtastic.host (http/tcp) or serialPath (serial) for the Meshtastic device.",
    configuredScore: 1,
    unconfiguredScore: 0,
    includeStatusLine: true,
    resolveConfigured: ({ cfg, accountId }) =>
      resolveMeshtasticAccount({ cfg: cfg as CoreConfig, accountId }).configured,
    resolveExtraStatusLines: ({ cfg, accountId }) => {
      const account = resolveMeshtasticAccount({ cfg: cfg as CoreConfig, accountId });
      if (!account.configured) {
        return [];
      }
      return [`${account.transport}: ${formatMeshtasticEndpoint(account)}`];
    },
  }),
  introNote: {
    title: "Meshtastic setup",
    lines: [
      "Connect via native TCP protobuf (4403, recommended), HTTP API (4433), or USB serial.",
      "The wizard probes the node before anything is written, so typos cost seconds, not evenings.",
      `Docs: ${formatDocsLink("/channels/meshtastic", "channels/meshtastic")}`,
    ],
  },
  credentials: [],
  finalize: async ({ cfg, prompter, accountId }) => {
    const resolvedAccountId = accountId ?? resolveDefaultMeshtasticAccountId(cfg as CoreConfig);
    let workingCfg = cfg as CoreConfig;
    const account = resolveMeshtasticAccount({ cfg: workingCfg, accountId: resolvedAccountId });

    // ── Step 1: transport ────────────────────────────────────────────────
    let transport: MeshtasticTransport = await prompter.select<MeshtasticTransport>({
      message: "How does this gateway reach your Meshtastic node?",
      options: [
        {
          value: "tcp",
          label: "TCP protobuf (recommended)",
          hint: "WiFi/LAN node — native stream on port 4403, nothing to enable on the node",
        },
        {
          value: "http",
          label: "HTTP API",
          hint: "port 4433 — must be explicitly enabled in the node's network settings",
        },
        {
          value: "serial",
          label: "USB serial",
          hint: "node plugged directly into this machine",
        },
      ],
      initialValue: account.transport,
    });

    let endpoint = {
      host: account.host,
      port: account.port || defaultPortForTransport(transport),
      tls: account.tls,
      serialPath: account.serialPath,
      baudRate: account.baudRate || DEFAULT_SERIAL_BAUD,
    };
    let probeOk = false;
    let identity: MeshtasticNodeIdentity | null = null;

    // ── Steps 2–4: endpoint → probe (with diagnosis) → identity ─────────
    for (;;) {
      if (transport === "serial") {
        const MANUAL = "__manual__";
        const detected = await listSerialPorts();
        if (detected.length > 0) {
          const picked = await prompter.select<string>({
            message: "Serial port",
            options: [
              ...detected.map((path) => ({ value: path, label: path })),
              { value: MANUAL, label: "Enter path manually" },
            ],
            initialValue: detected.includes(endpoint.serialPath) ? endpoint.serialPath : detected[0],
          });
          if (picked !== MANUAL) {
            endpoint.serialPath = picked;
          }
        }
        if (detected.length === 0 || endpoint.serialPath === MANUAL || !endpoint.serialPath) {
          endpoint.serialPath = normalizeOptionalString(
            await prompter.text({
              message: "Serial device path",
              placeholder: "/dev/cu.usbserial-0001",
              initialValue: endpoint.serialPath === MANUAL ? "" : endpoint.serialPath,
              validate: (value: string) => (normalizeOptionalString(value) ? undefined : "Required"),
            }),
          ) ?? "";
        }
        endpoint.baudRate = parseBaudRate(
          await prompter.text({
            message: "Baud rate",
            initialValue: String(endpoint.baudRate),
          }),
          endpoint.baudRate,
        );
        endpoint.host = "";
        endpoint.tls = false;
      } else {
        const hostRaw = await prompter.text({
          message: "Meshtastic node host or IP",
          placeholder: "192.168.1.10 or meshtastic.local (host:port also works)",
          initialValue: endpoint.host || process.env.MESHTASTIC_HOST || "",
          validate: (value: string) => (normalizeOptionalString(value) ? undefined : "Required"),
        });
        const split = splitHostPort(hostRaw);
        endpoint.host = split.host;
        const portDefault = defaultPortForTransport(transport);
        endpoint.port = parsePort(
          await prompter.text({
            message: transport === "tcp" ? "TCP port" : "HTTP API port",
            initialValue: String(split.port ?? endpoint.port ?? portDefault),
          }),
          split.port ?? portDefault,
        );
        endpoint.tls =
          transport === "http"
            ? await prompter.confirm({
                message: "Use HTTPS for the Meshtastic HTTP API?",
                initialValue: endpoint.tls,
              })
            : false;
        endpoint.serialPath = "";
      }

      const candidateCfg = updateMeshtasticAccountConfig(workingCfg, resolvedAccountId, {
        transport,
        host: endpoint.host || undefined,
        port: transport === "serial" ? undefined : endpoint.port,
        tls: endpoint.tls,
        serialPath: endpoint.serialPath || undefined,
        baudRate: endpoint.baudRate,
      });
      const target = formatMeshtasticEndpoint({ transport, ...endpoint });
      const progress = prompter.progress(`Probing ${target}…`);
      const probe = await probeMeshtastic(candidateCfg, {
        accountId: resolvedAccountId,
        timeoutMs: 8000,
      });
      if (probe.ok) {
        progress.stop(`Node answers at ${target} — ${probe.latencyMs}ms`);
        probeOk = true;
        workingCfg = candidateCfg;
        break;
      }

      progress.stop(`No answer from ${target}`);
      const diagnosis = diagnoseProbeFailure({
        transport,
        host: endpoint.host,
        port: endpoint.port,
        serialPath: endpoint.serialPath,
        error: probe.error,
      });
      await prompter.note(
        [diagnosis.summary, "", ...diagnosis.hints.map((hint) => `• ${hint}`)].join("\n"),
        "Connection diagnosis",
      );
      const next = await prompter.select<string>({
        message: "How do you want to proceed?",
        options: [
          ...(diagnosis.suggestTransport
            ? [
                {
                  value: "switch",
                  label: `Switch to ${diagnosis.suggestTransport} (port ${diagnosis.suggestPort}) and retry`,
                },
              ]
            : []),
          { value: "retry", label: "Re-enter connection details" },
          { value: "save", label: "Save anyway — I'll troubleshoot later" },
        ],
        initialValue: diagnosis.suggestTransport ? "switch" : "retry",
      });
      if (next === "save") {
        workingCfg = candidateCfg;
        break;
      }
      if (next === "switch" && diagnosis.suggestTransport) {
        transport = diagnosis.suggestTransport;
        endpoint.port = diagnosis.suggestPort ?? defaultPortForTransport(transport);
        endpoint.tls = false;
      }
    }

    // ── Step 4: node identity (only meaningful after a live probe) ──────
    if (probeOk) {
      const progress = prompter.progress("Reading node identity…");
      identity = await readMeshtasticNodeIdentity({
        transport,
        host: endpoint.host,
        port: endpoint.port,
        tls: endpoint.tls,
        serialPath: endpoint.serialPath,
        baudRate: endpoint.baudRate,
        timeoutMs: 12_000,
      }).catch(() => null);
      if (identity?.nodeId) {
        progress.stop(
          `Node ${identity.nodeId}${identity.longName ? ` — "${identity.longName}"` : ""}`,
        );
        const lines: string[] = [];
        if (identity.region && identity.region !== "UNSET") {
          lines.push(`LoRa region: ${identity.region}`);
        }
        if (identity.region === "UNSET") {
          lines.push(
            "⚠ LoRa region is UNSET — the node cannot transmit until you pick a region in the Meshtastic phone app.",
          );
        }
        if (identity.firmwareVersion) {
          lines.push(`Firmware: ${identity.firmwareVersion}`);
        }
        if (lines.length > 0) {
          await prompter.note(lines.join("\n"), "Node identity");
        }
      } else {
        progress.stop("Connected — node identity unread, but DMs will still work");
      }
    }

    // ── Step 5: mesh channels to listen ──────────────────────────────────
    const channelsRaw = await prompter.text({
      message: "Mesh channel indices to listen on (comma-separated, 0-7)",
      initialValue: (account.config.channels ?? [0]).join(","),
    });
    const channels = channelsRaw
      .split(/[,;\s]+/)
      .map((entry: string) => Number.parseInt(entry.trim(), 10))
      .filter((value: number) => Number.isFinite(value) && value >= 0 && value <= 7);

    // ── Step 6: the airtime rule (groupTransmit opt-in) ──────────────────
    await prompter.note(
      [
        "LoRa airtime is a shared commons: every node in range hears every channel message, and there is no delete button on the airwaves.",
        "",
        "This plugin's send path REFUSES channel/broadcast messages unless you explicitly opt in, and ALWAYS refuses the reserved broadcast address (^all, !ffffffff). Direct messages always work either way.",
      ].join("\n"),
      "The airtime rule",
    );
    const groupTransmit = await prompter.confirm({
      message: "Allow the agent to TRANSMIT on mesh channels? (flood guard caps it at 3 msgs/10 min)",
      initialValue: account.config.groupTransmit === true,
    });

    // ── Step 7: write, default mention-gating, summary ───────────────────
    let next = updateMeshtasticAccountConfig(workingCfg, resolvedAccountId, {
      transport,
      host: transport === "serial" ? undefined : endpoint.host || undefined,
      port: transport === "serial" ? undefined : endpoint.port,
      tls: endpoint.tls,
      serialPath: transport === "serial" ? endpoint.serialPath || undefined : undefined,
      baudRate: transport === "serial" ? endpoint.baudRate : undefined,
      channels: channels.length ? channels : [0],
      groupTransmit,
    });
    next = withDefaultRequireMention(next, resolvedAccountId);
    next = setSetupChannelEnabled(next, channel, true) as CoreConfig;

    const finalAccount = resolveMeshtasticAccount({ cfg: next, accountId: resolvedAccountId });
    const target = formatMeshtasticEndpoint({
      transport,
      host: endpoint.host,
      port: endpoint.port,
      tls: endpoint.tls,
      serialPath: endpoint.serialPath,
    });
    await prompter.note(
      [
        `Endpoint: ${transport} ${target}${probeOk ? " (probe passed)" : " (not verified — saved anyway)"}`,
        identity?.nodeId
          ? `Node: ${identity.nodeId}${identity.longName ? ` "${identity.longName}"` : ""}${identity.region ? `, region ${identity.region}` : ""}`
          : "",
        `DM policy: ${finalAccount.config.dmPolicy ?? "pairing"} — group transmit: ${groupTransmit ? "ON (opted in)" : "refused (default)"}`,
        "Always on: flood guard (20 DMs / 10 min, 3 channel msgs / 10 min), replies chunked to ~200 chars, metadata-only logging.",
        "",
        `Self-test: send a DM to ${identity?.nodeId ?? "your node"} from the Meshtastic phone app — expect a reply within about a minute (LoRa is slow).`,
      ]
        .filter(Boolean)
        .join("\n"),
      "Meshtastic configured",
    );

    return { cfg: next };
  },
  dmPolicy: {
    label: "Meshtastic",
    channel,
    policyKey: "channels.meshtastic.dmPolicy",
    allowFromKey: "channels.meshtastic.allowFrom",
    resolveConfigKeys: (_cfg, accountId) => resolveMeshtasticConfigKeys(accountId),
    getCurrent: (cfg, accountId) =>
      resolveMeshtasticAccount({ cfg: cfg as CoreConfig, accountId }).config.dmPolicy ?? "pairing",
    setPolicy: (cfg, policy, accountId) =>
      updateMeshtasticAccountConfig(
        cfg as CoreConfig,
        accountId ?? resolveDefaultMeshtasticAccountId(cfg as CoreConfig),
        { dmPolicy: policy },
      ),
    promptAllowFrom: createPromptParsedAllowFromForAccount({
      defaultAccountId: resolveDefaultMeshtasticAccountId,
      message: "Allowed Meshtastic node ids",
      placeholder: "!aabbccdd, node:1234567890, *",
      parseEntries: (raw: string) => ({
        entries: mergeAllowFromEntries(undefined, splitSetupEntries(raw)),
      }),
      getExistingAllowFrom: ({ cfg, accountId }) =>
        resolveMeshtasticAccount({ cfg: cfg as CoreConfig, accountId }).config.allowFrom ?? [],
      applyAllowFrom: ({ cfg, accountId, allowFrom }) =>
        updateMeshtasticAccountConfig(cfg as CoreConfig, accountId, { allowFrom }),
    }),
  },
  allowFrom: createAllowFromSection({
    message: "Allowed Meshtastic node ids",
    placeholder: "!aabbccdd, node:1234567890, *",
    invalidWithoutCredentialNote: "Entries that are not valid Meshtastic node ids will be ignored.",
    parseId: normalizeMeshtasticAllowEntry,
    apply: ({ cfg, accountId, allowFrom }) =>
      updateMeshtasticAccountConfig(cfg as CoreConfig, accountId, { allowFrom }),
  }),
  groupAccess: {
    label: "Meshtastic broadcast channels",
    placeholder: formatMeshtasticChannelTarget(0),
    currentPolicy: ({ cfg, accountId }) =>
      resolveMeshtasticAccount({ cfg: cfg as CoreConfig, accountId }).config.groupPolicy ??
      "allowlist",
    currentEntries: ({ cfg, accountId }) =>
      Object.keys(resolveMeshtasticAccount({ cfg: cfg as CoreConfig, accountId }).config.groups ?? {}),
    updatePrompt: () => true,
    setPolicy: ({ cfg, accountId, policy }) =>
      setMeshtasticGroupAccess(cfg as CoreConfig, accountId, policy, [], normalizeGroupEntry),
    resolveAllowlist: async ({ entries }) => entries,
    applyAllowlist: ({ cfg, accountId, resolved }) =>
      setMeshtasticGroupAccess(
        cfg as CoreConfig,
        accountId,
        "allowlist",
        Array.isArray(resolved) ? resolved.filter((entry): entry is string => typeof entry === "string") : [],
        normalizeGroupEntry,
      ),
  },
};
