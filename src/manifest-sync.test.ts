import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildMeshtasticManifest } from "../scripts/manifest-builder.js";
import { MeshtasticChannelConfigSchema } from "./config-schema.js";

const manifestPath = new URL("../openclaw.plugin.json", import.meta.url);
const packageJsonPath = new URL("../package.json", import.meta.url);
const committed = JSON.parse(readFileSync(manifestPath, "utf8"));
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
const committedText = readFileSync(manifestPath, "utf8");

describe("Meshtastic manifest sync drift guard", () => {
  it("matches the committed manifest to a fresh sync-manifest build", () => {
    const fresh = buildMeshtasticManifest(structuredClone(committed), packageJson);
    expect(fresh).toEqual(committed);
  });

  it.each([
    {
      name: "object default/required stripping",
      options: { stripAccountObjectDefaults: false },
      prepare(schema: any) {
        const root = schema.properties.sessionSendRateLimit;
        const account = schema.properties.accounts.additionalProperties;
        account.properties.sessionSendRateLimit.default = structuredClone(root.default);
        account.required = [...(account.required ?? []), "sessionSendRateLimit"];
        return schema;
      },
      verify(schema: any) {
        const accounts = schema.properties.accounts.additionalProperties;
        expect(accounts.properties.sessionSendRateLimit.default).toBeDefined();
        expect(accounts.required).toContain("sessionSendRateLimit");
      },
    },
    {
      name: "inner-field default stripping",
      options: { stripAccountInnerDefaults: false },
      verify(schema: any) {
        const limit = schema.properties.accounts.additionalProperties.properties.sessionSendRateLimit;
        expect(limit.default).toBeUndefined();
        expect(limit.properties.enabled.default).toBe(true);
      },
    },
  ])("proves removing $name makes committed-output parity fail", ({ options, verify, prepare }) => {
    const schema = prepare
      ? prepare(structuredClone(MeshtasticChannelConfigSchema.schema))
      : MeshtasticChannelConfigSchema.schema;
    const broken = buildMeshtasticManifest(
      structuredClone(committed),
      packageJson,
      schema,
      options,
    );
    verify(broken.channelConfigs.meshtastic.schema);
    expect(broken).not.toEqual(committed);
    // Mutation checks are in-memory only: no broken generated manifest is left behind.
    expect(readFileSync(manifestPath, "utf8")).toBe(committedText);
  });
});
