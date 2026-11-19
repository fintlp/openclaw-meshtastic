import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MeshtasticChannelConfigSchema } from "../src/config-schema.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(repoRoot, "openclaw.plugin.json");
const packageJsonPath = path.join(repoRoot, "package.json");

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
  openclaw?: {
    channel?: {
      label?: string;
      blurb?: string;
    };
  };
};

const channelMeta = packageJson.openclaw?.channel ?? {};

// Named-account overrides must contain only fields the operator explicitly
// wrote. Hydrating account-level defaults here would re-enable a root opt-out
// and overwrite root tuning before resolveMergedAccountConfig can deep-merge.
const channelSchema = structuredClone(MeshtasticChannelConfigSchema.schema) as Record<string, any>;
const accountSessionLimit = channelSchema.properties?.accounts?.additionalProperties?.properties
  ?.sessionSendRateLimit as Record<string, any> | undefined;
if (accountSessionLimit) {
  delete accountSessionLimit.default;
  delete accountSessionLimit.required;
  for (const field of Object.values(accountSessionLimit.properties ?? {}) as Array<Record<string, unknown>>) {
    delete field.default;
  }
}
manifest.channelConfigs = {
  ...(typeof manifest.channelConfigs === "object" && manifest.channelConfigs
    ? manifest.channelConfigs
    : {}),
  meshtastic: {
    label: channelMeta.label ?? "Meshtastic",
    description:
      channelMeta.blurb ?? "LoRa mesh messaging via Meshtastic node HTTP API.",
    schema: channelSchema,
    uiHints: MeshtasticChannelConfigSchema.uiHints,
  },
};

fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log("synced channelConfigs.meshtastic in openclaw.plugin.json");
