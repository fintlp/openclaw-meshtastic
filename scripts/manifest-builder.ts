import { MeshtasticChannelConfigSchema } from "../src/config-schema.js";

export type MeshtasticManifestPackage = {
  openclaw?: {
    channel?: {
      label?: string;
      blurb?: string;
    };
  };
};

export type MeshtasticManifestBuildOptions = {
  stripAccountObjectDefaults?: boolean;
  stripAccountInnerDefaults?: boolean;
};

/** Build the same manifest written by sync-manifest, with optional mutation hooks for drift tests. */
export function buildMeshtasticManifest(
  manifest: Record<string, unknown>,
  packageJson: MeshtasticManifestPackage,
  schema: Record<string, any> = MeshtasticChannelConfigSchema.schema,
  options: MeshtasticManifestBuildOptions = {},
): Record<string, unknown> {
  const channelMeta = packageJson.openclaw?.channel ?? {};
  const channelSchema = structuredClone(schema);
  const accountSessionLimit = channelSchema.properties?.accounts?.additionalProperties?.properties
    ?.sessionSendRateLimit as Record<string, any> | undefined;
  if (accountSessionLimit) {
    if (options.stripAccountObjectDefaults !== false) {
      delete accountSessionLimit.default;
      delete accountSessionLimit.required;
    }
    if (options.stripAccountInnerDefaults !== false) {
      for (const field of Object.values(accountSessionLimit.properties ?? {}) as Array<Record<string, unknown>>) {
        delete field.default;
      }
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
  return manifest;
}
