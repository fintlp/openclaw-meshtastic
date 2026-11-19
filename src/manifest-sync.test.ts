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
      // Isolated from the case above: that one also injects an unrelated
      // "sessionSendRateLimit" entry into the account's own required list,
      // a key the builder never touches, so it alone would already make
      // broken !== committed even if object-default stripping were a no-op.
      // This case injects only accountSessionLimit.default (a real,
      // concrete root default value) so the parity failure below is
      // provably caused by the default leaking through, not by that
      // unrelated required-list artifact.
      name: "object default stripping in isolation (no required-list change)",
      options: { stripAccountObjectDefaults: false },
      prepare(schema: any) {
        const root = schema.properties.sessionSendRateLimit;
        const account = schema.properties.accounts.additionalProperties;
        account.properties.sessionSendRateLimit.default = structuredClone(root.default);
        return schema;
      },
      verify(schema: any) {
        const accounts = schema.properties.accounts.additionalProperties;
        expect(accounts.properties.sessionSendRateLimit.default).toEqual(
          MeshtasticChannelConfigSchema.schema.properties.sessionSendRateLimit.default,
        );
        expect(accounts.required ?? []).not.toContain("sessionSendRateLimit");
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
