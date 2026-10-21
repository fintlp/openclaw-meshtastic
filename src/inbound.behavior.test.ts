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
import type { CoreConfig, MeshtasticInboundMessage } from "./types.js";

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

  it("issues pairing challenge for unknown DM senders", async () => {
    const sendReply = vi.fn(async () => undefined);
    await handleMeshtasticInbound({
      message: createMessage(),
      account: createAccount(),
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
