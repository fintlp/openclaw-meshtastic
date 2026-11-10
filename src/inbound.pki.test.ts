import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedMeshtasticAccount } from "./accounts.js";
import { handleMeshtasticInbound } from "./inbound.js";
import type { RuntimeEnv } from "./runtime-api.js";
import { clearMeshtasticRuntime, setMeshtasticRuntime } from "./runtime.js";
import type { CoreConfig, MeshtasticInboundMessage, MeshtasticSenderIdentity } from "./types.js";

// Inbound PKI identity behavior (issue #7 phase 1): the mismatch downgrade
// rides the envelope as structured channel context (never message text), the
// pkiMismatch flag controls admit-vs-drop, and ordinary admission logic is
// unchanged.

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

function createRuntimeEnv() {
  return { log: vi.fn(), error: vi.fn() } as unknown as RuntimeEnv;
}

function createAccount(overrides?: Partial<ResolvedMeshtasticAccount>): ResolvedMeshtasticAccount {
  return {
    accountId: "default",
    enabled: true,
    configured: true,
    host: "192.0.2.10",
    port: 4403,
    tls: false,
    config: {
      dmPolicy: "allowlist",
      allowFrom: ["!00000002"],
      groupPolicy: "disabled",
      channels: [0],
    },
    ...overrides,
  } as ResolvedMeshtasticAccount;
}

function createMessage(
  senderIdentity?: MeshtasticSenderIdentity,
  overrides?: Partial<MeshtasticInboundMessage>,
): MeshtasticInboundMessage {
  return {
    messageId: "42",
    target: "!00000002",
    senderNodeNum: 2,
    senderId: "!00000002",
    text: "fixture body",
    timestamp: 1790000000000,
    isGroup: false,
    meshChannel: 0,
    ...(senderIdentity ? { senderIdentity } : {}),
    ...overrides,
  };
}

function installDispatchRuntime(capture: { ctxPayload?: Record<string, unknown> }) {
  const inboundRun = vi.fn(async () => ({ dispatched: true }));
  setMeshtasticRuntime({
    channel: {
      pairing: {
        readAllowFromStore: readAllowFromStoreMock,
        upsertPairingRequest: upsertPairingRequestMock,
      },
      commands: { shouldHandleTextCommands: shouldHandleTextCommandsMock },
      text: { hasControlCommand: hasControlCommandMock },
      mentions: {
        buildMentionRegexes: buildMentionRegexesMock,
        matchesMentionPatterns: matchesMentionPatternsMock,
      },
      routing: {
        resolveAgentRoute: vi.fn(() => ({
          agentId: "meshtastic",
          sessionKey: "meshtastic:direct:!00000002",
          accountId: "default",
        })),
      },
      reply: {
        finalizeInboundContext: vi.fn((ctx: Record<string, unknown>) => {
          capture.ctxPayload = ctx;
          return ctx;
        }),
        resolveEnvelopeFormatOptions: vi.fn(() => ({})),
        formatAgentEnvelope: vi.fn(({ body }: { body: string }) => ({
          storePath: "/tmp/sessions.json",
          body,
        })),
        dispatchReplyWithBufferedBlockDispatcher: vi.fn(),
      },
      inbound: { run: inboundRun },
      session: {
        recordInboundSession: vi.fn(),
        resolveStorePath: vi.fn(() => "/tmp/sessions.json"),
        readSessionUpdatedAt: vi.fn(() => undefined),
      },
    },
    config: {
      current: () => ({ channels: { meshtastic: { host: "192.0.2.10" } } }),
    },
  } as never);
  return inboundRun;
}

type StructuredEntry = {
  label: string;
  source: string;
  type: string;
  payload: Record<string, unknown>;
};

function identityEntries(capture: { ctxPayload?: Record<string, unknown> }): StructuredEntry[] {
  const ctx = (capture.ctxPayload?.ChannelStructuredContext ?? []) as StructuredEntry[];
  return ctx.filter((entry) => entry.type === "mesh_sender_identity");
}

describe("inbound PKI sender identity (issue #7)", () => {
  beforeEach(() => {
    readAllowFromStoreMock.mockReset().mockResolvedValue([]);
    upsertPairingRequestMock.mockReset().mockResolvedValue({ code: "CODE", created: true });
  });

  afterEach(() => {
    clearMeshtasticRuntime();
  });

  it("a mismatch is admitted as unverified by default and annotated in structured context", async () => {
    const capture: { ctxPayload?: Record<string, unknown> } = {};
    const inboundRun = installDispatchRuntime(capture);
    const identity: MeshtasticSenderIdentity = {
      grade: "mismatch",
      keyFp: "abcdef012345",
      detail: "key changed (pinned fp=001122334455) — admitted unverified",
    };
    await handleMeshtasticInbound({
      message: createMessage(identity),
      account: createAccount(),
      config: { channels: { meshtastic: { host: "192.0.2.10" } } } as CoreConfig,
      runtime: createRuntimeEnv(),
      sendReply: vi.fn(async () => undefined),
    });
    expect(inboundRun).toHaveBeenCalled();
    const entries = identityEntries(capture);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      label: "Meshtastic Sender Identity",
      source: "meshtastic",
      payload: { grade: "mismatch", keyFp: "abcdef012345" },
    });
    expect(entries[0].payload.detail).toContain("key changed");
    // Spoof-proof: the annotation never touches the message text.
    expect(capture.ctxPayload?.RawBody).toBe("fixture body");
  });

  it("pkiMismatch=drop refuses a mismatched sender with a distinct log line", async () => {
    const capture: { ctxPayload?: Record<string, unknown> } = {};
    const inboundRun = installDispatchRuntime(capture);
    const runtime = createRuntimeEnv();
    const identity: MeshtasticSenderIdentity = {
      grade: "mismatch",
      keyFp: "abcdef012345",
      detail: "key changed",
    };
    await handleMeshtasticInbound({
      message: createMessage(identity),
      account: createAccount({
        config: {
          dmPolicy: "allowlist",
          allowFrom: ["!00000002"],
          groupPolicy: "disabled",
          channels: [0],
          pkiMismatch: "drop",
        },
      } as ResolvedMeshtasticAccount),
      config: { channels: { meshtastic: { host: "192.0.2.10" } } } as CoreConfig,
      runtime,
      sendReply: vi.fn(async () => undefined),
    });
    expect(inboundRun).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("drop DM sender !00000002 (pki key mismatch"),
    );
  });

  it("a pki-verified message carries grade and fingerprint in structured context", async () => {
    const capture: { ctxPayload?: Record<string, unknown> } = {};
    const inboundRun = installDispatchRuntime(capture);
    await handleMeshtasticInbound({
      message: createMessage({ grade: "pki-verified", keyFp: "001122334455" }),
      account: createAccount(),
      config: { channels: { meshtastic: { host: "192.0.2.10" } } } as CoreConfig,
      runtime: createRuntimeEnv(),
      sendReply: vi.fn(async () => undefined),
    });
    expect(inboundRun).toHaveBeenCalled();
    expect(identityEntries(capture)[0]?.payload).toEqual({
      grade: "pki-verified",
      keyFp: "001122334455",
    });
  });

  it("a psk-grade message is annotated psk-grade (uniform field, no key data)", async () => {
    const capture: { ctxPayload?: Record<string, unknown> } = {};
    const inboundRun = installDispatchRuntime(capture);
    await handleMeshtasticInbound({
      message: createMessage({ grade: "psk-grade" }),
      account: createAccount(),
      config: { channels: { meshtastic: { host: "192.0.2.10" } } } as CoreConfig,
      runtime: createRuntimeEnv(),
      sendReply: vi.fn(async () => undefined),
    });
    expect(inboundRun).toHaveBeenCalled();
    expect(identityEntries(capture)[0]?.payload).toEqual({ grade: "psk-grade" });
  });

  it("a message without identity annotation gets no structured entry (legacy callers)", async () => {
    const capture: { ctxPayload?: Record<string, unknown> } = {};
    const inboundRun = installDispatchRuntime(capture);
    await handleMeshtasticInbound({
      message: createMessage(undefined),
      account: createAccount(),
      config: { channels: { meshtastic: { host: "192.0.2.10" } } } as CoreConfig,
      runtime: createRuntimeEnv(),
      sendReply: vi.fn(async () => undefined),
    });
    expect(inboundRun).toHaveBeenCalled();
    expect(capture.ctxPayload?.ChannelStructuredContext).toBeUndefined();
  });

  it("ordinary admission logic is unchanged: an unknown mismatched sender still pairs first", async () => {
    const capture: { ctxPayload?: Record<string, unknown> } = {};
    const inboundRun = installDispatchRuntime(capture);
    const sendReply = vi.fn(async () => undefined);
    await handleMeshtasticInbound({
      message: createMessage({ grade: "mismatch", keyFp: "abcdef012345", detail: "key changed" }),
      account: createAccount({
        config: { dmPolicy: "pairing", allowFrom: [], groupPolicy: "disabled", channels: [0] },
      } as ResolvedMeshtasticAccount),
      config: { channels: { meshtastic: { host: "192.0.2.10" } } } as CoreConfig,
      runtime: createRuntimeEnv(),
      sendReply,
    });
    // Pairing challenge, not dispatch — mismatch does not bypass dmPolicy.
    expect(upsertPairingRequestMock).toHaveBeenCalled();
    expect(inboundRun).not.toHaveBeenCalled();
  });
});