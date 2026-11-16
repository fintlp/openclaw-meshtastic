import { describe, expect, it } from "vitest";
import { resolveMeshtasticAccount } from "./accounts.js";
import { meshtasticPlugin } from "./channel.js";
import {
  resolveMeshtasticEffectiveGroupMatch,
  resolveMeshtasticEffectiveGroups,
  resolveMeshtasticGroupMatch,
} from "./policy.js";
import type { CoreConfig } from "./types.js";

// Issue #43 (port of openclaw-meshcore #77/#89; owner decision 2026-11-16):
// a SINGLE named account with an explicit groups:{} inherits root
// channels.meshtastic.groups (host inheritEmptyKeys). Admission/mention,
// requireMention, tool policy, systemPrompt and skills all read that map.
// Multi-account setups (including non-canonical keys) never inherit.

const ROOT_GROUPS = {
  "channel:0": {
    requireMention: true,
    systemPrompt: "Root prompt",
    skills: ["weather"],
    tools: { deny: ["root-tool"] },
  },
};

function cfgWith(accounts?: Record<string, Record<string, unknown>>, rootGroups: unknown = ROOT_GROUPS) {
  return {
    channels: {
      meshtastic: {
        host: "192.0.2.10",
        groupPolicy: "allowlist",
        groups: rootGroups,
        ...(accounts ? { accounts } : {}),
      },
    },
  } as unknown as CoreConfig;
}

function requireMention(cfg: CoreConfig, accountId: string, groupId: string): unknown {
  const resolver = meshtasticPlugin.groups?.resolveRequireMention as unknown as (params: {
    cfg: CoreConfig;
    accountId?: string | null;
    groupId?: string | null;
  }) => unknown;
  return resolver({ cfg, accountId, groupId });
}

function toolPolicy(cfg: CoreConfig, accountId: string, groupId: string): unknown {
  const resolver = meshtasticPlugin.groups?.resolveToolPolicy as unknown as (params: {
    cfg: CoreConfig;
    accountId?: string | null;
    groupId?: string | null;
    senderId?: string;
    senderPolicyMode?: "always" | "never";
  }) => unknown;
  return resolver({ cfg, accountId, groupId, senderId: "id:!00000002", senderPolicyMode: "always" });
}

describe("#43 single named account with groups:{} inherits root groups", () => {
  const cfg = () => cfgWith({ ops: { host: "192.0.2.11", groups: {} } });

  it("the account's own map is empty (precondition of the bug)", () => {
    expect(resolveMeshtasticAccount({ cfg: cfg(), accountId: "ops" }).config.groups).toEqual({});
  });

  it("effective match resolves the inherited root channel and its fields", () => {
    const c = cfg();
    const account = resolveMeshtasticAccount({ cfg: c, accountId: "ops" });
    const match = resolveMeshtasticEffectiveGroupMatch({ cfg: c, account, target: "channel:0" });
    expect(match.allowed).toBe(true);
    expect(match.hasConfiguredGroups).toBe(true);
    expect(match.groupConfig?.requireMention).toBe(true);
    expect(match.groupConfig?.systemPrompt).toBe("Root prompt");
    expect(match.groupConfig?.skills).toEqual(["weather"]);
  });

  it("channel adapter resolveRequireMention honors the inherited root group", () => {
    expect(requireMention(cfg(), "ops", "channel:0")).toBe(true);
  });

  it("tool policy gets STRICTER: the inherited root deny list applies (c0bd8a4 scenario, inverted)", () => {
    expect(JSON.stringify(toolPolicy(cfg(), "ops", "channel:0"))).toContain("root-tool");
  });

  it("a lone accounts.default with groups:{} inherits too (intended, host counting)", () => {
    const c = cfgWith({ default: { host: "192.0.2.11", groups: {} } });
    const account = resolveMeshtasticAccount({ cfg: c, accountId: "default" });
    expect(account.config.groups).toEqual({});
    expect(resolveMeshtasticEffectiveGroupMatch({ cfg: c, account, target: "channel:0" }).allowed).toBe(true);
    expect(requireMention(c, "default", "channel:0")).toBe(true);
    expect(JSON.stringify(toolPolicy(c, "default", "channel:0"))).toContain("root-tool");
  });
});

describe("#43 negative controls: no inheritance leakage", () => {
  it.each(["ops", "ops.team", "Ops Team"])(
    "multi-account key %j with groups:{} does NOT inherit (admission, mention, tool policy)",
    (key) => {
      const c = cfgWith({ [key]: { host: "192.0.2.11", groups: {} }, lab: { host: "192.0.2.12" } });
      const account = resolveMeshtasticAccount({ cfg: c, accountId: key });
      expect(account.config.groups).toEqual({});
      expect(resolveMeshtasticEffectiveGroups({ cfg: c, account })).toEqual({});
      const match = resolveMeshtasticEffectiveGroupMatch({ cfg: c, account, target: "channel:0" });
      expect(match).toEqual(resolveMeshtasticGroupMatch({ groups: account.config.groups, target: "channel:0" }));
      expect(match.allowed).toBe(false);
      expect(match.hasConfiguredGroups).toBe(false);
      expect(requireMention(c, key, "channel:0")).toBe(false);
      expect(JSON.stringify(toolPolicy(c, key, "channel:0") ?? null)).not.toContain("root-tool");
    },
  );

  it("explicit non-empty account groups win over root groups", () => {
    const c = cfgWith({ ops: { host: "192.0.2.11", groups: { "channel:1": { requireMention: false } } } });
    const account = resolveMeshtasticAccount({ cfg: c, accountId: "ops" });
    expect(resolveMeshtasticEffectiveGroups({ cfg: c, account })).toBe(account.config.groups);
    expect(resolveMeshtasticEffectiveGroupMatch({ cfg: c, account, target: "channel:0" }).allowed).toBe(false);
    expect(requireMention(c, "ops", "channel:0")).toBe(false);
    expect(JSON.stringify(toolPolicy(c, "ops", "channel:0") ?? null)).not.toContain("root-tool");
  });

  it("a single named account WITHOUT a groups key keeps its ordinary root merge", () => {
    const c = cfgWith({ ops: { host: "192.0.2.11" } });
    const account = resolveMeshtasticAccount({ cfg: c, accountId: "ops" });
    expect(resolveMeshtasticEffectiveGroups({ cfg: c, account })).toBe(account.config.groups);
    expect(requireMention(c, "ops", "channel:0")).toBe(true);
  });

  it("the default account (no accounts map) resolves root groups as before", () => {
    const c = cfgWith();
    const account = resolveMeshtasticAccount({ cfg: c });
    expect(resolveMeshtasticEffectiveGroups({ cfg: c, account })).toBe(account.config.groups);
    expect(requireMention(c, "default", "channel:0")).toBe(true);
    expect(requireMention(c, "default", "channel:9")).toBe(false);
  });

  it("an empty root map with an empty single account still resolves nothing", () => {
    const c = cfgWith({ ops: { host: "192.0.2.11", groups: {} } }, {});
    const account = resolveMeshtasticAccount({ cfg: c, accountId: "ops" });
    const match = resolveMeshtasticEffectiveGroupMatch({ cfg: c, account, target: "channel:0" });
    expect(match.allowed).toBe(false);
    expect(match.hasConfiguredGroups).toBe(false);
    expect(requireMention(c, "ops", "channel:0")).toBe(false);
  });
});
