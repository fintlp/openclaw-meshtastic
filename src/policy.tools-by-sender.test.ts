import { describe, expect, it } from "vitest";
import { meshtasticPlugin } from "./channel.js";
import { resolveMeshtasticSenderToolDenials } from "./policy.js";
import type { CoreConfig, MeshtasticGroupConfig } from "./types.js";

const SENDER = "!aabbccdd";

type Groups = Record<string, MeshtasticGroupConfig>;

function resolve(groups: Groups | undefined, senderId: string | null = SENDER) {
  return resolveMeshtasticSenderToolDenials({
    groups,
    target: "channel:0",
    senderId,
    messageProvider: "meshtastic",
  });
}

function resolveAdapter(params: {
  cfg: CoreConfig;
  accountId?: string;
  groupId?: string | null;
  senderId?: string;
  senderPolicyMode?: "always" | "never";
}) {
  const resolver = meshtasticPlugin.groups?.resolveToolPolicy;
  if (!resolver) {
    throw new Error("meshtastic group tool-policy adapter is not registered");
  }
  return resolver({
    cfg: params.cfg as never,
    accountId: params.accountId ?? "default",
    groupId: params.groupId === undefined ? "channel:0" : params.groupId,
    senderId: params.senderId ?? SENDER,
    senderPolicyMode: params.senderPolicyMode,
  });
}

describe("Meshtastic sender-scoped additional tool denials (MCP05 / #40)", () => {
  it("combines exact group tools with a matching sender deny and preserves positive controls", () => {
    const result = resolve({
      "channel:0": {
        tools: {
          allow: ["read", "write", "exec"],
          alsoAllow: ["status"],
          deny: ["write"],
        },
        toolsBySender: { "id:!aabbccdd": { deny: ["exec"] } },
      },
    });

    expect(result).toEqual({
      allow: ["read", "write", "exec"],
      alsoAllow: ["status"],
      deny: ["write", "exec"],
    });
    expect(result?.deny).not.toContain("read");
    expect(result?.deny).not.toContain("status");
  });

  it("layers wildcard base and sender floors under an exact sender deny", () => {
    const groups: Groups = {
      "*": {
        tools: { deny: ["write"] },
        toolsBySender: { "*": { deny: ["wildcard-floor"] } },
      },
      "channel:0": {
        toolsBySender: {
          "channel:meshtastic:!aabbccdd": { deny: ["exec"] },
        },
      },
    };

    expect(resolve(groups)?.deny).toEqual(["write", "wildcard-floor", "exec"]);
    expect(resolve(groups, "!11223344")?.deny).toEqual(["write", "wildcard-floor"]);
  });

  it("never lets exact rules erase wildcard sender denials and dedupes the union", () => {
    const result = resolve({
      "*": {
        toolsBySender: {
          "*": { deny: ["wildcard-floor", "shared"] },
          "id:!aabbccdd": { deny: ["wildcard-node"] },
        },
      },
      "channel:0": {
        toolsBySender: {
          "*": { deny: ["exact-floor", "shared"] },
          "id:!aabbccdd": { deny: ["exact-node"] },
        },
      },
    });

    expect(result?.deny).toEqual([
      "wildcard-floor",
      "shared",
      "wildcard-node",
      "exact-floor",
      "exact-node",
    ]);
  });

  it("keeps deny precedence visible when baseline allow/alsoAllow names the same tool", () => {
    const result = resolve({
      "channel:0": {
        tools: { allow: [], alsoAllow: ["exec", "read"], deny: ["write"] },
        toolsBySender: { "id:!aabbccdd": { deny: ["exec"] } },
      },
    });

    expect(result?.allow).toEqual([]);
    expect(result?.alsoAllow).toEqual(["exec", "read"]);
    expect(result?.deny).toEqual(["write", "exec"]);
    expect(result?.deny).not.toContain("read");
  });

  it("senderPolicyMode=never skips both sender overlays and returns the baseline unchanged", () => {
    const tools = { allow: ["read"], deny: ["write"] };
    const result = resolveMeshtasticSenderToolDenials({
      groups: {
        "*": { toolsBySender: { "*": { deny: ["wildcard-floor"] } } },
        "channel:0": {
          tools,
          toolsBySender: { "id:!aabbccdd": { deny: ["exec"] } },
        },
      },
      target: "channel:0",
      senderId: SENDER,
      senderPolicyMode: "never",
    });

    expect(result).toBe(tools);
  });

  it("conservatively unions every configured denial when sender id is missing", () => {
    for (const senderId of [undefined, null, "   "]) {
      const result = resolveMeshtasticSenderToolDenials({
        groups: {
          "*": {
            toolsBySender: {
              "*": { deny: ["floor"] },
              "id:!11223344": { deny: ["write", "shared"] },
            },
          },
          "channel:0": {
            tools: { deny: ["base"] },
            toolsBySender: {
              "id:!aabbccdd": { deny: ["exec", "shared"] },
            },
          },
        },
        target: "channel:0",
        senderId,
      });
      expect(result?.deny).toEqual(["base", "floor", "write", "shared", "exec"]);
    }
  });

  it("owns a neutral policy for recognized groups and returns undefined only without a group id", () => {
    expect(resolve({})).toEqual({ deny: [] });
    expect(resolve(undefined)).toEqual({ deny: [] });
    expect(
      resolveMeshtasticSenderToolDenials({ groups: {}, target: null, senderId: SENDER }),
    ).toBeUndefined();
    expect(
      resolveMeshtasticSenderToolDenials({
        groups: {},
        target: "channel:0",
        senderId: SENDER,
        senderPolicyMode: "never",
      }),
    ).toEqual({ deny: [] });
  });

  it("uses case-insensitive group and hex node matching with channel-qualified keys", () => {
    const result = resolveMeshtasticSenderToolDenials({
      groups: {
        "Channel:0": {
          toolsBySender: {
            "channel:meshtastic:!AABBCCDD": { deny: ["exec"] },
          },
        },
      },
      target: "channel:0",
      senderId: "!aabbccdd",
      messageProvider: "meshtastic",
    });
    expect(result?.deny).toEqual(["exec"]);
  });
});

describe("registered Meshtastic group tool-policy adapter", () => {
  it("regression: the real callback returns baseline AND sender denials (pre-fix returned baseline only)", () => {
    const cfg = {
      channels: {
        meshtastic: {
          host: "192.0.2.10",
          groups: {
            "channel:0": {
              tools: { allow: ["read"], deny: ["write"] },
              toolsBySender: { "id:!aabbccdd": { deny: ["exec"] } },
            },
          },
        },
      },
    } as CoreConfig;

    expect(resolveAdapter({ cfg })).toEqual({
      allow: ["read"],
      deny: ["write", "exec"],
    });
    expect(resolveAdapter({ cfg, groupId: null })).toBeUndefined();
  });

  it("uses inherited root groups for a named account when admission uses that same inheritance", () => {
    const cfg = {
      channels: {
        meshtastic: {
          host: "192.0.2.10",
          groups: {
            "channel:0": {
              tools: { deny: ["root-base"] },
              toolsBySender: { "id:!aabbccdd": { deny: ["root-sender"] } },
            },
          },
          accounts: { work: { host: "192.0.2.11" } },
        },
      },
    } as CoreConfig;

    expect(resolveAdapter({ cfg, accountId: "work" })?.deny).toEqual([
      "root-base",
      "root-sender",
    ]);
  });

  // Decision 2026-11-16 (owner, issue #43): aligned with openclaw-meshcore
  // #77/#89. An explicit groups:{} on a SINGLE named account inherits root
  // groups via the host inheritEmptyKeys rule, so the root group's tool deny
  // list now applies. c0bd8a4 pinned neutrality before the host semantics were
  // adopted.
  it("explicit groups={} on a single named account inherits root group tool denials (host inheritEmptyKeys)", () => {
    const cfg = {
      channels: {
        meshtastic: {
          host: "192.0.2.10",
          groups: {
            "channel:0": {
              tools: { deny: ["root-base"] },
              toolsBySender: { "*": { deny: ["root-floor"] } },
            },
          },
          accounts: { work: { host: "192.0.2.11", groups: {} } },
        },
      },
    } as CoreConfig;

    expect(resolveAdapter({ cfg, accountId: "work" })).toEqual({
      deny: ["root-base", "root-floor"],
    });
  });

  it("named-account groups replace root groups and retain their own exact/wildcard overlays", () => {
    const cfg = {
      channels: {
        meshtastic: {
          host: "192.0.2.10",
          groups: {
            "channel:0": { tools: { deny: ["root-base"] } },
          },
          accounts: {
            work: {
              host: "192.0.2.11",
              groups: {
                "*": { toolsBySender: { "*": { deny: ["account-floor"] } } },
                "channel:0": {
                  tools: { deny: ["account-base"] },
                  toolsBySender: { "id:!aabbccdd": { deny: ["account-sender"] } },
                },
              },
            },
          },
        },
      },
    } as CoreConfig;

    expect(resolveAdapter({ cfg, accountId: "work" })?.deny).toEqual([
      "account-base",
      "account-floor",
      "account-sender",
    ]);
  });
});
