import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedMeshtasticAccount } from "./accounts.js";
import { handleMeshtasticInbound } from "./inbound.js";
import type { RuntimeEnv } from "./runtime-api.js";
import { clearMeshtasticRuntime, setMeshtasticRuntime } from "./runtime.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  observeNodeKey,
  resetNodeBookForTests,
  setKeyBookPathForTests,
  setNodeBookPathForTests,
} from "./node-book.js";
import type { CoreConfig, MeshtasticInboundMessage, MeshtasticSenderIdentity } from "./types.js";

// MCP07 regression suite (2026.11.1): forged channel-PSK sender numbers must
// never reach a known-key contact's session, never carry command or owner
// authority, and every refusal happens BEFORE pairing, durability and dispatch.
// Written against the spec in the 2026.11.1 brief. Against v2026.10.35 the
// security cases fail (red); the implementation must turn all of them green.

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


const KEY_A = Buffer.alloc(32, 0x11).toString("base64");
const KEY_B = Buffer.alloc(32, 0x22).toString("base64");
const BASE_CFG = { channels: { meshtastic: { host: "192.0.2.10" } } } as CoreConfig;

function pinWithContinuity(num: number, key = KEY_A) {
  observeNodeKey("default", num, key, "nodeinfo"); // first seen (TOFU)
  observeNodeKey("default", num, key, "pki-packet"); // continuity
}

function account(config: Record<string, unknown>) {
  return createAccount({
    config: { dmPolicy: "allowlist", allowFrom: ["!00000002"], groupPolicy: "disabled", channels: [0], ...config },
  } as ResolvedMeshtasticAccount);
}

async function run(params: {
  identity?: MeshtasticSenderIdentity;
  account?: ResolvedMeshtasticAccount;
  config?: CoreConfig;
  text?: string;
  overrides?: Partial<MeshtasticInboundMessage>;
  replayOf?: number;
  durability?: unknown;
}) {
  const capture: { ctxPayload?: Record<string, unknown> } = {};
  const inboundRun = installDispatchRuntime(capture);
  const runtime = createRuntimeEnv();
  const sendReply = vi.fn(async () => undefined);
  await handleMeshtasticInbound({
    message: createMessage(params.identity, { text: params.text ?? "fixture body", ...params.overrides }),
    account: params.account ?? createAccount(),
    config: params.config ?? BASE_CFG,
    runtime,
    sendReply,
    ...(params.replayOf !== undefined ? { replayOf: params.replayOf } : {}),
    ...(params.durability ? { durability: params.durability as never } : {}),
  });
  const logs = (runtime.log as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
  return { capture, inboundRun, runtime, sendReply, logs, dispatched: inboundRun.mock.calls.length > 0 };
}

const suppressed = (ctx?: Record<string, unknown>) => ctx?.CommandInterpretationSuppressed === true;

describe("MCP07 identity gate (2026.11.1)", () => {
  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "mcp07-"));
    setKeyBookPathForTests(join(dir, "keys.json"));
    setNodeBookPathForTests(join(dir, "nodes.json"));
    readAllowFromStoreMock.mockReset().mockResolvedValue([]);
    upsertPairingRequestMock.mockReset().mockResolvedValue({ code: "CODE", created: true });
    shouldHandleTextCommandsMock.mockReset().mockReturnValue(true);
    hasControlCommandMock.mockReset().mockReturnValue(false);
  });
  afterEach(() => {
    clearMeshtasticRuntime();
    resetNodeBookForTests();
  });

  // --- dmIdentity: "known-keys" (default) ---------------------------------
  it("T1 default: forged psk-grade DM claiming a pinned, allowlisted number is dropped before dispatch", async () => {
    pinWithContinuity(2);
    const r = await run({ identity: { grade: "psk-grade" } });
    expect(r.dispatched).toBe(false);
    expect(r.logs.some((l) => l.includes("identity gate") && l.includes("!00000002"))).toBe(true);
  });

  it("T2 default: forged psk-grade DM claiming a PAIRED (store) number with a pin is dropped", async () => {
    pinWithContinuity(2);
    readAllowFromStoreMock.mockResolvedValue(["!00000002"]);
    const r = await run({ identity: { grade: "psk-grade" }, account: account({ dmPolicy: "pairing", allowFrom: [] }) });
    expect(r.dispatched).toBe(false);
  });

  it("T3 default: forged psk-grade DM for a pinned, NOT yet approved number triggers no pairing challenge and no airtime", async () => {
    pinWithContinuity(2);
    const r = await run({ identity: { grade: "psk-grade" }, account: account({ dmPolicy: "pairing", allowFrom: [] }) });
    expect(upsertPairingRequestMock).not.toHaveBeenCalled();
    expect(r.sendReply).not.toHaveBeenCalled();
    expect(r.dispatched).toBe(false);
  });

  it("T4 default: psk-grade DM from an allowlisted number with NO pin is admitted, commands suppressed", async () => {
    hasControlCommandMock.mockReturnValue(true);
    const r = await run({ identity: { grade: "psk-grade" }, text: "/status" });
    expect(r.dispatched).toBe(true);
    expect(suppressed(r.capture.ctxPayload)).toBe(true);
    expect(r.capture.ctxPayload?.CommandAuthorized).not.toBe(true);
  });

  it("T5 default: pki-verified DM with continuity is admitted with command authority", async () => {
    pinWithContinuity(2);
    hasControlCommandMock.mockReturnValue(true);
    const r = await run({ identity: { grade: "pki-verified", keyFp: "001122334455" }, text: "/status" });
    expect(r.dispatched).toBe(true);
    expect(suppressed(r.capture.ctxPayload)).toBe(false);
    expect(r.capture.ctxPayload?.CommandAuthorized).toBe(true);
  });

  it("T6 default: pki-verified FIRST-CONTACT DM is admitted but commands are suppressed", async () => {
    hasControlCommandMock.mockReturnValue(true);
    const r = await run({ identity: { grade: "pki-verified", keyFp: "001122334455", firstContact: true }, text: "/status" });
    expect(r.dispatched).toBe(true);
    expect(suppressed(r.capture.ctxPayload)).toBe(true);
  });

  it("T7 default: a mismatch is dropped (pkiMismatch now defaults to drop)", async () => {
    const r = await run({ identity: { grade: "mismatch", keyFp: "abcdef012345", detail: "key changed" } });
    expect(r.dispatched).toBe(false);
  });

  it("T8 a message with NO identity annotation is treated as psk-grade (fail closed, not open)", async () => {
    pinWithContinuity(2);
    const r = await run({ identity: undefined });
    expect(r.dispatched).toBe(false);
  });

  // --- dmIdentity: "strict" ------------------------------------------------
  it("T9 strict: psk-grade DM from an unpinned allowlisted number is dropped", async () => {
    const r = await run({ identity: { grade: "psk-grade" }, account: account({ dmIdentity: "strict" }) });
    expect(r.dispatched).toBe(false);
  });

  it("T10 strict: psk-grade sender gets no pairing challenge", async () => {
    const r = await run({ identity: { grade: "psk-grade" }, account: account({ dmIdentity: "strict", dmPolicy: "pairing", allowFrom: [] }) });
    expect(upsertPairingRequestMock).not.toHaveBeenCalled();
    expect(r.sendReply).not.toHaveBeenCalled();
  });

  // --- dmIdentity: "off" (explicit legacy opt-out) -------------------------
  it("T11 off: v35 admission for a pinned number, but commands stay suppressed under commandIdentity=verified", async () => {
    pinWithContinuity(2);
    hasControlCommandMock.mockReturnValue(true);
    const r = await run({ identity: { grade: "psk-grade" }, account: account({ dmIdentity: "off" }), text: "/status" });
    expect(r.dispatched).toBe(true);
    expect(suppressed(r.capture.ctxPayload)).toBe(true);
  });

  // --- owner identity (unconditional) --------------------------------------
  it("T12 owner: an ownerAllowFrom mesh id over psk-grade is dropped even with dmIdentity=off", async () => {
    const cfg = { ...BASE_CFG, commands: { ownerAllowFrom: ["meshtastic:!00000002"] } } as unknown as CoreConfig;
    const r = await run({ identity: { grade: "psk-grade" }, account: account({ dmIdentity: "off" }), config: cfg });
    expect(r.dispatched).toBe(false);
  });

  it("T13 owner: bare (unprefixed) owner entry matches too; first-contact PKI is not enough", async () => {
    const cfg = { ...BASE_CFG, commands: { ownerAllowFrom: ["!00000002"] } } as unknown as CoreConfig;
    const r = await run({ identity: { grade: "pki-verified", keyFp: "001122334455", firstContact: true }, config: cfg });
    expect(r.dispatched).toBe(false);
  });

  it("T14 owner: a group message whose sender is an owner id is dropped (channel traffic cannot prove identity)", async () => {
    const cfg = { ...BASE_CFG, commands: { ownerAllowFrom: ["meshtastic:!00000002"] } } as unknown as CoreConfig;
    const r = await run({
      identity: { grade: "psk-grade" },
      config: cfg,
      account: account({ groupPolicy: "open", groups: { "*": {} } }),
      overrides: { isGroup: true, target: "channel:0" },
    });
    expect(r.dispatched).toBe(false);
  });

  // --- groups ----------------------------------------------------------------
  it("T15 group traffic never carries command authority under commandIdentity=verified", async () => {
    hasControlCommandMock.mockReturnValue(true);
    const r = await run({
      identity: { grade: "psk-grade" },
      text: "/status",
      account: account({ groupPolicy: "open", groups: { "*": {} } }),
      overrides: { isGroup: true, target: "channel:0" },
    });
    expect(r.dispatched).toBe(true);
    expect(suppressed(r.capture.ctxPayload)).toBe(true);
  });

  // --- manual verification ---------------------------------------------------
  it("T16 pkiManuallyVerified with a configured key: a pki-verified DM under a DIFFERENT key is dropped", async () => {
    pinWithContinuity(2, KEY_B);
    const r = await run({
      identity: { grade: "pki-verified", keyFp: "ffffffffffff" },
      account: account({ pkiManuallyVerified: [`!00000002=${KEY_A}`] }),
    });
    expect(r.dispatched).toBe(false);
  });

  it("T17 pkiManuallyVerified: a psk-grade DM for a listed id is dropped even with dmIdentity=off", async () => {
    const r = await run({ identity: { grade: "psk-grade" }, account: account({ dmIdentity: "off", pkiManuallyVerified: ["!00000002"] }) });
    expect(r.dispatched).toBe(false);
  });

  // --- replay path ------------------------------------------------------------
  it("T18 replay: a stored psk-grade event for a now-pinned number is not dispatched and leaves the queue", async () => {
    pinWithContinuity(2);
    const durability = {
      findDuplicate: vi.fn(() => null),
      intake: vi.fn(() => ({ id: 7, duplicate: false })),
      claim: vi.fn(() => "claimed"),
      releaseClaim: vi.fn(),
      deadLetter: vi.fn(),
      markDispatched: vi.fn(),
      markComplete: vi.fn(),
    };
    const r = await run({ identity: { grade: "psk-grade" }, replayOf: 7, durability });
    expect(r.dispatched).toBe(false);
    expect(durability.deadLetter.mock.calls.length + durability.releaseClaim.mock.calls.length).toBeGreaterThan(0);
  });
});
