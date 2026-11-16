import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedMeshtasticAccount } from "./accounts.js";
import { meshtasticDedupeKey, openDurabilityStore } from "./durability.js";
import { handleMeshtasticInbound } from "./inbound.js";
import type { RuntimeEnv } from "./runtime-api.js";
import { clearMeshtasticRuntime, getMeshtasticRuntime, setMeshtasticRuntime } from "./runtime.js";
import type { CoreConfig, MeshtasticGroupConfig, MeshtasticInboundMessage } from "./types.js";

const {
  buildMentionRegexesMock,
  hasControlCommandMock,
  matchesMentionPatternsMock,
  readAllowFromStoreMock,
  shouldHandleTextCommandsMock,
  upsertPairingRequestMock,
} = vi.hoisted(() => ({
  buildMentionRegexesMock: vi.fn(() => []),
  hasControlCommandMock: vi.fn(() => false),
  matchesMentionPatternsMock: vi.fn(() => false),
  readAllowFromStoreMock: vi.fn(async () => []),
  shouldHandleTextCommandsMock: vi.fn(() => false),
  upsertPairingRequestMock: vi.fn(async () => ({ code: "CODE", created: true })),
}));

vi.mock("./send.js", () => ({
  sendMessageMeshtastic: vi.fn(async () => ({
    messageId: "1",
    target: "!00000002",
    receipt: { kind: "text" },
  })),
}));

function installMeshtasticRuntime() {
  setMeshtasticRuntime({
    channel: {
      pairing: {
        readAllowFromStore: readAllowFromStoreMock,
        upsertPairingRequest: upsertPairingRequestMock,
      },
      commands: {
        shouldHandleTextCommands: shouldHandleTextCommandsMock,
      },
      text: {
        hasControlCommand: hasControlCommandMock,
      },
      mentions: {
        buildMentionRegexes: buildMentionRegexesMock,
        matchesMentionPatterns: matchesMentionPatternsMock,
      },
    },
  } as never);
}

function createRuntimeEnv() {
  return {
    log: vi.fn(),
    error: vi.fn(),
  } as unknown as RuntimeEnv;
}

function createAccount(overrides?: Partial<ResolvedMeshtasticAccount>): ResolvedMeshtasticAccount {
  return {
    accountId: "default",
    enabled: true,
    configured: true,
    host: "192.168.1.10",
    port: 4433,
    tls: false,
    config: {
      dmPolicy: "pairing",
      allowFrom: [],
      groupPolicy: "allowlist",
      groupAllowFrom: [],
      channels: [0],
    },
    ...overrides,
  } as ResolvedMeshtasticAccount;
}

function createMessage(overrides?: Partial<MeshtasticInboundMessage>): MeshtasticInboundMessage {
  return {
    messageId: "42",
    target: "!00000002",
    senderNodeNum: 2,
    senderId: "!00000002",
    text: "hello",
    timestamp: Date.now(),
    isGroup: false,
    meshChannel: 0,
    ...overrides,
  };
}


function installDispatchRuntime(inboundRun: ReturnType<typeof vi.fn>) {
  setMeshtasticRuntime({
    channel: {
      pairing: {
        readAllowFromStore: readAllowFromStoreMock,
        upsertPairingRequest: upsertPairingRequestMock,
      },
      commands: {
        shouldHandleTextCommands: shouldHandleTextCommandsMock,
      },
      text: {
        hasControlCommand: hasControlCommandMock,
      },
      mentions: {
        buildMentionRegexes: buildMentionRegexesMock,
        matchesMentionPatterns: matchesMentionPatternsMock,
      },
      routing: {
        resolveAgentRoute: vi.fn(() => ({
          agentId: "meshtastic",
          sessionKey: "meshtastic:channel:0",
          accountId: "default",
        })),
      },
      reply: {
        finalizeInboundContext: vi.fn((ctx) => ctx),
        resolveEnvelopeFormatOptions: vi.fn(() => ({})),
        formatAgentEnvelope: vi.fn(({ body }) => ({
          storePath: "/tmp/sessions.json",
          body,
        })),
        dispatchReplyWithBufferedBlockDispatcher: vi.fn(),
      },
      inbound: {
        run: inboundRun,
      },
      session: {
        recordInboundSession: vi.fn(),
        resolveStorePath: vi.fn(() => "/tmp/sessions.json"),
        readSessionUpdatedAt: vi.fn(() => undefined),
      },
    },
    config: {
      current: () => ({ channels: { meshtastic: { host: "192.168.1.10" } } }),
    },
  } as never);
}

describe("meshtastic inbound behavior", () => {
  beforeEach(() => {
    readAllowFromStoreMock.mockReset().mockResolvedValue([]);
    upsertPairingRequestMock.mockReset().mockResolvedValue({ code: "CODE", created: true });
    installMeshtasticRuntime();
  });

  afterEach(() => {
    clearMeshtasticRuntime();
  });

  it("issues pairing challenge for unknown DM senders (legacy pairingIdentity=any; B1 default covers verified in mcp07)", async () => {
    const sendReply = vi.fn(async () => undefined);
    await handleMeshtasticInbound({
      message: createMessage(),
      account: createAccount({ config: { pairingIdentity: "any" } } as never),
      config: { channels: { meshtastic: { host: "192.168.1.10" } } } as CoreConfig,
      runtime: createRuntimeEnv(),
      sendReply,
    });

    expect(upsertPairingRequestMock).toHaveBeenCalled();
    expect(sendReply).toHaveBeenCalled();
  });

  it("drops a listed channel with no sender list (fail-closed since 2026.10.27)", async () => {
    const sendReply = vi.fn(async () => undefined);
    setMeshtasticRuntime({
      channel: {
        pairing: {
          readAllowFromStore: readAllowFromStoreMock,
          upsertPairingRequest: upsertPairingRequestMock,
        },
        commands: {
          shouldHandleTextCommands: shouldHandleTextCommandsMock,
        },
        text: {
          hasControlCommand: hasControlCommandMock,
        },
        mentions: {
          buildMentionRegexes: buildMentionRegexesMock,
          matchesMentionPatterns: matchesMentionPatternsMock,
        },
        routing: {
          resolveAgentRoute: vi.fn(() => ({
            agentId: "meshtastic",
            sessionKey: "meshtastic:channel:3",
            accountId: "default",
          })),
        },
        reply: {
          finalizeInboundContext: vi.fn((ctx) => ctx),
          resolveEnvelopeFormatOptions: vi.fn(() => ({})),
          formatAgentEnvelope: vi.fn(({ body }) => ({
            storePath: "/tmp/sessions.json",
            body,
          })),
          dispatchReplyWithBufferedBlockDispatcher: vi.fn(),
        },
        inbound: {
          run: vi.fn(async () => ({ dispatched: true })),
        },
        session: {
          recordInboundSession: vi.fn(),
          resolveStorePath: vi.fn(() => "/tmp/sessions.json"),
          readSessionUpdatedAt: vi.fn(() => undefined),
        },
      },
      config: {
        current: () => ({ channels: { meshtastic: { host: "192.168.1.10" } } }),
      },
    } as never);

    await handleMeshtasticInbound({
      message: createMessage({
        isGroup: true,
        target: "channel:3",
        senderId: "!aabbccdd",
        senderNodeNum: 3740243670,
        text: "И опять привет",
      }),
      account: createAccount({
        config: {
          dmPolicy: "pairing",
          groupPolicy: "allowlist",
          channels: [3],
          groups: {
            "channel:3": {
              requireMention: false,
            },
          },
        },
      }),
      config: { channels: { meshtastic: { host: "192.168.1.10" } } } as CoreConfig,
      runtime: createRuntimeEnv(),
      sendReply,
    });

    expect(getMeshtasticRuntime().channel.inbound.run).not.toHaveBeenCalled();
    expect(sendReply).not.toHaveBeenCalled();
  });

  it("drops broadcast from unallowlisted channel", async () => {
    const runtime = createRuntimeEnv();
    await handleMeshtasticInbound({
      message: createMessage({
        isGroup: true,
        target: "channel:0",
      }),
      account: createAccount({
        config: {
          dmPolicy: "pairing",
          groupPolicy: "allowlist",
          channels: [0],
          groups: {},
        },
      }),
      config: { channels: { meshtastic: { host: "192.168.1.10" } } } as CoreConfig,
      runtime,
      sendReply: vi.fn(async () => undefined),
    });

    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("drop channel channel:0 (not allowlisted)"),
    );
  });

  it("dispatches a listed sender on a listed channel (explicit sender gate)", async () => {
    const inboundRun = vi.fn(async () => ({ dispatched: true }));
    installDispatchRuntime(inboundRun);

    await handleMeshtasticInbound({
      message: createMessage({ isGroup: true, target: "channel:0", text: "hello mesh" }),
      account: createAccount({
        config: {
          dmPolicy: "pairing",
          groupPolicy: "allowlist",
          channels: [0],
          groupAllowFrom: ["!00000002"],
          groups: { "channel:0": { requireMention: false } },
        },
      }),
      config: { channels: { meshtastic: { host: "192.168.1.10" } } } as CoreConfig,
      runtime: createRuntimeEnv(),
      sendReply: vi.fn(async () => undefined),
    });

    expect(inboundRun).toHaveBeenCalled();
  });

  it("drops group messages when groupPolicy is disabled (the default)", async () => {
    const runtime = createRuntimeEnv();
    await handleMeshtasticInbound({
      message: createMessage({ isGroup: true, target: "channel:0" }),
      account: createAccount({
        config: { dmPolicy: "pairing", groupPolicy: "disabled", channels: [0] },
      }),
      config: { channels: { meshtastic: { host: "192.168.1.10" } } } as CoreConfig,
      runtime,
      sendReply: vi.fn(async () => undefined),
    });

    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("policy=disabled"));
  });

  it("drops senders outside groupAllowFrom on an allowlisted channel", async () => {
    const runtime = createRuntimeEnv();
    await handleMeshtasticInbound({
      message: createMessage({
        isGroup: true,
        target: "channel:0",
        senderId: "!deadbeef",
        senderNodeNum: 3735928559,
      }),
      account: createAccount({
        config: {
          dmPolicy: "pairing",
          groupPolicy: "allowlist",
          channels: [0],
          groupAllowFrom: ["!00000002"],
          groups: { "channel:0": { requireMention: false } },
        },
      }),
      config: { channels: { meshtastic: { host: "192.168.1.10" } } } as CoreConfig,
      runtime,
      sendReply: vi.fn(async () => undefined),
    });

    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("policy=allowlist"));
  });

  it("drops unmentioned group messages when requireMention is true", async () => {
    matchesMentionPatternsMock.mockReturnValue(false);
    const runtime = createRuntimeEnv();
    await handleMeshtasticInbound({
      message: createMessage({ isGroup: true, target: "channel:0" }),
      account: createAccount({
        config: {
          dmPolicy: "pairing",
          groupPolicy: "allowlist",
          channels: [0],
          groupAllowFrom: ["!00000002"],
          groups: { "channel:0": { requireMention: true } },
        },
      }),
      config: { channels: { meshtastic: { host: "192.168.1.10" } } } as CoreConfig,
      runtime,
      sendReply: vi.fn(async () => undefined),
    });

    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("drop"));
  });

  it("dispatches a mentioned group message when requireMention is true", async () => {
    matchesMentionPatternsMock.mockReturnValue(true);
    const inboundRun = vi.fn(async () => ({ dispatched: true }));
    installDispatchRuntime(inboundRun);

    await handleMeshtasticInbound({
      message: createMessage({ isGroup: true, target: "channel:0", text: "hey agent" }),
      account: createAccount({
        config: {
          dmPolicy: "pairing",
          groupPolicy: "allowlist",
          channels: [0],
          groupAllowFrom: ["!00000002"],
          groups: { "channel:0": { requireMention: true } },
        },
      }),
      config: { channels: { meshtastic: { host: "192.168.1.10" } } } as CoreConfig,
      runtime: createRuntimeEnv(),
      sendReply: vi.fn(async () => undefined),
    });

    expect(inboundRun).toHaveBeenCalled();
  });

});


describe("inbound durability (#8, redelivery + duplicate-drop)", () => {
  it("m7: a plain-DM retry after a failed first dispatch is redelivered, not dropped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "meshtastic-beh-dur-"));
    const store = await openDurabilityStore({ dbPath: join(dir, "d.sqlite") });
    try {
      const msg = createMessage({ text: "hello", timestamp: 1700000001234 });
      store!.intake({
        accountId: "default",
        dedupeKey: meshtasticDedupeKey({
          senderNodeNum: msg.senderNodeNum,
          packetId: msg.messageId,
        }),
        kind: "direct",
        peerId: msg.senderId,
        senderTs: msg.timestamp,
        body: "hello",
        rawJson: JSON.stringify(msg),
      });
      const inboundRun = vi.fn(async () => ({ dispatched: true }));
      installDispatchRuntime(inboundRun);
      await handleMeshtasticInbound({
        message: msg,
        account: createAccount({
          config: { dmPolicy: "allowlist", allowFrom: ["!00000002"], groupPolicy: "disabled" },
        }),
        config: { channels: { meshtastic: { host: "192.168.1.10" } } } as CoreConfig,
        runtime: createRuntimeEnv(),
        sendReply: vi.fn(async () => undefined),
        durability: store,
      });
      expect(inboundRun).toHaveBeenCalled();
    } finally {
      store?.close();
    }
  });

  it("a duplicate of an already-dispatched frame is dropped before any dispatch work", async () => {
    const dir = mkdtempSync(join(tmpdir(), "meshtastic-beh-dur-"));
    const store = await openDurabilityStore({ dbPath: join(dir, "d.sqlite") });
    try {
      const msg = createMessage({ text: "hello", timestamp: 1700000001234 });
      const key = meshtasticDedupeKey({
        senderNodeNum: msg.senderNodeNum,
        packetId: msg.messageId,
      });
      const row = store!.intake({
        accountId: "default",
        dedupeKey: key,
        kind: "direct",
        peerId: msg.senderId,
        senderTs: msg.timestamp,
        body: "hello",
        rawJson: JSON.stringify(msg),
      });
      store!.claim("default", row.id, 3, 60_000);
      store!.markDispatched("default", row.id);
      const inboundRun = vi.fn(async () => ({ dispatched: true }));
      installDispatchRuntime(inboundRun);
      const runtime = createRuntimeEnv();
      await handleMeshtasticInbound({
        message: msg,
        account: createAccount({
          config: { dmPolicy: "allowlist", allowFrom: ["!00000002"], groupPolicy: "disabled" },
        }),
        config: { channels: { meshtastic: { host: "192.168.1.10" } } } as CoreConfig,
        runtime,
        sendReply: vi.fn(async () => undefined),
        durability: store,
      });
      expect(inboundRun).not.toHaveBeenCalled();
      expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("drop duplicate inbound"));
    } finally {
      store?.close();
    }
  });

  it("replay: admission flipped while down releases the claim, no pairing re-challenge", async () => {
    const dir = mkdtempSync(join(tmpdir(), "meshtastic-beh-dur-"));
    const store = await openDurabilityStore({ dbPath: join(dir, "d.sqlite") });
    try {
      const msg = createMessage({ text: "hello", timestamp: 1700000001234 });
      const row = store!.intake({
        accountId: "default",
        dedupeKey: meshtasticDedupeKey({
          senderNodeNum: msg.senderNodeNum,
          packetId: msg.messageId,
        }),
        kind: "direct",
        peerId: msg.senderId,
        senderTs: msg.timestamp,
        body: "hello",
        rawJson: JSON.stringify(msg),
      });
      expect(store!.claim("default", row.id, 3, 60_000)).toBe("claimed");
      // Sender is NOT admitted now (pairing policy, unknown sender).
      const runtime = createRuntimeEnv();
      await handleMeshtasticInbound({
        message: msg,
        account: createAccount({
          config: { dmPolicy: "allowlist", allowFrom: ["!99999999"], groupPolicy: "disabled" },
        }),
        config: { channels: { meshtastic: { host: "192.168.1.10" } } } as CoreConfig,
        runtime,
        sendReply: vi.fn(async () => undefined),
        durability: store,
        replayOf: row.id,
        replayReceivedAt: 1700000001234,
      });
      // claim released back to pending with the flip noted; no challenge sent
      const ev = store!.findDuplicate("default", meshtasticDedupeKey({
        senderNodeNum: msg.senderNodeNum,
        packetId: msg.messageId,
      }));
      expect(ev?.state).toBe("pending");
      expect(upsertPairingRequestMock).not.toHaveBeenCalled();
      expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("no longer admitted"));
    } finally {
      store?.close();
    }
  });
});

describe("MCP05 groupScope=main tool-policy guard", () => {
  beforeEach(() => {
    readAllowFromStoreMock.mockReset().mockResolvedValue([]);
    matchesMentionPatternsMock.mockReset().mockReturnValue(false);
    hasControlCommandMock.mockReset().mockReturnValue(false);
    shouldHandleTextCommandsMock.mockReset().mockReturnValue(false);
  });

  afterEach(() => {
    clearMeshtasticRuntime();
  });

  function groupAccount(group: MeshtasticGroupConfig) {
    return createAccount({
      config: {
        dmPolicy: "pairing",
        groupPolicy: "allowlist",
        channels: [0],
        groupAllowFrom: ["!00000002"],
        groups: { "channel:0": { requireMention: false, ...group } },
      },
    });
  }

  function routeConfig(
    groupScope: "main" | "per-group",
    bindingScope?: "main" | "per-group",
  ): CoreConfig {
    return {
      session: { groupScope },
      ...(bindingScope
        ? {
            bindings: [
              {
                agentId: "main",
                match: {
                  channel: "meshtastic",
                  accountId: "default",
                  peer: { kind: "group", id: "channel:0" },
                },
                session: { groupScope: bindingScope },
              },
            ],
          }
        : {}),
      channels: { meshtastic: { host: "192.0.2.10" } },
    } as CoreConfig;
  }

  async function runGroupScope(params: {
    account: ResolvedMeshtasticAccount;
    config: CoreConfig;
    replayOf?: number;
  }) {
    const inboundRun = vi.fn(async () => ({ dispatched: true }));
    installDispatchRuntime(inboundRun);
    const runtime = createRuntimeEnv();
    const durability = {
      findDuplicate: vi.fn(() => null),
      intake: vi.fn(() => ({ id: 7, duplicate: false })),
      claim: vi.fn(() => "claimed"),
      releaseClaim: vi.fn(),
      deadLetter: vi.fn(),
      markDispatched: vi.fn(),
      markComplete: vi.fn(),
    };
    await handleMeshtasticInbound({
      message: createMessage({
        isGroup: true,
        target: "channel:0",
        text: "group turn",
        timestamp: 1790000000000,
      }),
      account: params.account,
      config: params.config,
      runtime,
      durability: durability as never,
      ...(params.replayOf !== undefined ? { replayOf: params.replayOf } : {}),
    });
    return { inboundRun, runtime, durability };
  }

  it("refuses a global main route with a base-only group tool policy before intake or dispatch", async () => {
    const r = await runGroupScope({
      account: groupAccount({ tools: { deny: ["write"] } }),
      config: routeConfig("main"),
    });

    expect(r.inboundRun).not.toHaveBeenCalled();
    expect(r.durability.intake).not.toHaveBeenCalled();
    expect(r.runtime.log).toHaveBeenCalledWith(
      expect.stringContaining('groupScope="per-group" in the effective binding or session config'),
    );
  });

  it("protects a sender-only policy even when the current sender has no matching entry", async () => {
    const r = await runGroupScope({
      account: groupAccount({
        toolsBySender: { "id:!aabbccdd": { deny: ["exec"] } },
      }),
      config: routeConfig("main"),
    });

    expect(r.inboundRun).not.toHaveBeenCalled();
    expect(r.durability.intake).not.toHaveBeenCalled();
    expect(r.runtime.log).toHaveBeenCalledWith(expect.stringContaining("would shed its tool policy"));
  });

  it("honors a binding that overrides a per-group global default to main", async () => {
    const r = await runGroupScope({
      account: groupAccount({ tools: { deny: ["write"] } }),
      config: routeConfig("per-group", "main"),
    });

    expect(r.inboundRun).not.toHaveBeenCalled();
    expect(r.durability.intake).not.toHaveBeenCalled();
    expect(r.runtime.log).toHaveBeenCalledWith(expect.stringContaining('groupScope="main"'));
  });

  it("honors a binding that restores per-group under a main global default", async () => {
    const r = await runGroupScope({
      account: groupAccount({ tools: { deny: ["write"] } }),
      config: routeConfig("main", "per-group"),
    });

    expect(r.inboundRun).toHaveBeenCalled();
    expect(r.durability.intake).toHaveBeenCalled();
    expect(r.durability.deadLetter).not.toHaveBeenCalled();
  });

  it("dead-letters a protected replay with the terminal group-scope-main reason", async () => {
    const r = await runGroupScope({
      account: groupAccount({ tools: { deny: ["write"] } }),
      config: routeConfig("main"),
      replayOf: 7,
    });

    expect(r.inboundRun).not.toHaveBeenCalled();
    expect(r.durability.intake).not.toHaveBeenCalled();
    expect(r.durability.deadLetter).toHaveBeenCalledWith("default", 7, "group-scope-main");
    expect(r.durability.releaseClaim).not.toHaveBeenCalled();
  });

  it("allows an unprotected group to use a main route as a positive control", async () => {
    const r = await runGroupScope({
      account: groupAccount({}),
      config: routeConfig("main"),
    });

    expect(r.inboundRun).toHaveBeenCalled();
    expect(r.durability.intake).toHaveBeenCalled();
    expect(r.durability.deadLetter).not.toHaveBeenCalled();
  });
});


// Issue #43 (port of openclaw-meshcore #77): handler-level pins. A single named
// account with explicit groups:{} is admitted / mention-gated / prompted through
// inherited root groups; multi-account setups (incl. non-canonical keys) are not.
describe("issue #43: inbound group lookups use the host-aware group map", () => {
  beforeEach(() => {
    readAllowFromStoreMock.mockReset().mockResolvedValue([]);
    upsertPairingRequestMock.mockReset().mockResolvedValue({ code: "CODE", created: true });
    matchesMentionPatternsMock.mockReset().mockReturnValue(false);
    installMeshtasticRuntime();
  });

  afterEach(() => {
    clearMeshtasticRuntime();
  });

  function cfgWith(
    rootGroups: Record<string, MeshtasticGroupConfig>,
    accounts: Record<string, Record<string, unknown>>,
  ): CoreConfig {
    return {
      channels: {
        meshtastic: {
          host: "192.0.2.10",
          dmPolicy: "pairing",
          groupPolicy: "allowlist",
          groupAllowFrom: ["!00000002"],
          channels: [0],
          groups: rootGroups,
          accounts,
        },
      },
    } as unknown as CoreConfig;
  }

  async function run(config: CoreConfig, accountId: string, text = "hello mesh") {
    const { resolveMeshtasticAccount } = await import("./accounts.js");
    const inboundRun = vi.fn(async () => ({ dispatched: true }));
    installDispatchRuntime(inboundRun);
    const runtime = createRuntimeEnv();
    await handleMeshtasticInbound({
      message: createMessage({ isGroup: true, target: "channel:0", text }),
      account: resolveMeshtasticAccount({ cfg: config, accountId }),
      config,
      runtime,
      sendReply: vi.fn(async () => undefined),
    });
    return { inboundRun, runtime };
  }

  const ROOT = {
    "channel:0": { requireMention: false, systemPrompt: "Root prompt", skills: ["weather"] },
  };

  it("admits an inherited allowlisted channel and applies its systemPrompt and skills", async () => {
    const r = await run(cfgWith(ROOT, { ops: { host: "192.0.2.11", groups: {} } }), "ops");
    expect(r.inboundRun).toHaveBeenCalledTimes(1);
    const turn = (
      r.inboundRun.mock.calls[0] as unknown as [{ adapter: { resolveTurn: () => any } }]
    )[0].adapter.resolveTurn();
    expect(turn.ctxPayload.GroupSystemPrompt).toBe("Root prompt");
    expect(turn.replyOptions.skillFilter).toEqual(["weather"]);
  });

  it("gates an inherited requireMention channel on the mention", async () => {
    const config = cfgWith(
      { "channel:0": { requireMention: true } },
      { ops: { host: "192.0.2.11", groups: {} } },
    );
    const unmentioned = await run(config, "ops");
    expect(unmentioned.inboundRun).not.toHaveBeenCalled();
    expect(unmentioned.runtime.log).toHaveBeenCalledWith(
      "meshtastic: drop channel channel:0 (missing-mention)",
    );
    matchesMentionPatternsMock.mockReturnValue(true);
    const mentioned = await run(config, "ops", "hey agent");
    expect(mentioned.inboundRun).toHaveBeenCalledTimes(1);
  });

  it.each(["ops", "ops.team", "Ops Team"])(
    "does not inherit root groups for multi-account key %j",
    async (key) => {
      const r = await run(
        cfgWith(ROOT, { [key]: { host: "192.0.2.11", groups: {} }, lab: { host: "192.0.2.12" } }),
        key,
      );
      expect(r.inboundRun).not.toHaveBeenCalled();
      expect(r.runtime.log).toHaveBeenCalledWith("meshtastic: drop channel channel:0 (not allowlisted)");
    },
  );

  it("keeps explicit non-empty account groups authoritative over root groups", async () => {
    const r = await run(
      cfgWith(ROOT, { ops: { host: "192.0.2.11", groups: { "channel:1": { requireMention: false } } } }),
      "ops",
    );
    expect(r.inboundRun).not.toHaveBeenCalled();
    expect(r.runtime.log).toHaveBeenCalledWith("meshtastic: drop channel channel:0 (not allowlisted)");
  });
});
