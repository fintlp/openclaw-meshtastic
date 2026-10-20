import { afterEach, describe, expect, it, vi } from "vitest";
import { clearOutboundEchoCache, isOutboundEcho } from "./echo-dedupe.js";
import { clearSendRateLimitState } from "./rate-limit.js";
import { sendMessageMeshtastic, sendTextWithoutBlockingForAck } from "./send.js";
import type { CoreConfig } from "./types.js";

const { connectMeshtasticDeviceMock, getMeshtasticDeviceMock } = vi.hoisted(() => ({
  connectMeshtasticDeviceMock: vi.fn(),
  getMeshtasticDeviceMock: vi.fn(),
}));

vi.mock("./device-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./device-client.js")>();
  return {
    ...actual,
    connectMeshtasticDevice: connectMeshtasticDeviceMock,
    getMeshtasticDevice: getMeshtasticDeviceMock,
  };
});

function createConfig(overrides?: Record<string, unknown>): CoreConfig {
  return {
    channels: {
      meshtastic: {
        host: "192.168.1.10",
        port: 4433,
        ...overrides,
      },
    },
  } as CoreConfig;
}

describe("sendMessageMeshtastic", () => {
  afterEach(() => {
    clearOutboundEchoCache();
    vi.clearAllMocks();
    clearSendRateLimitState();
  });

  it("does not block on Meshtastic routing ACK when HTTP send is queued", async () => {
    const sendText = vi.fn(() => new Promise<number>(() => undefined));
    const handle = {
      accountId: "default",
      myNodeNum: 123,
      device: {
        sendText,
        queue: {
          getState: () => [{ id: 77, added: new Date() }],
        },
      },
    };
    getMeshtasticDeviceMock.mockReturnValue(handle);

    const result = await sendMessageMeshtastic("channel:3", "hello mesh", {
      cfg: createConfig({ groupTransmit: true }),
      ackWaitMs: 1,
    });

    expect(sendText).toHaveBeenCalledWith("hello mesh", "broadcast", true, 3, undefined);
    expect(result.messageId).toBe("77");
    expect(result.target).toBe("channel:3");
  });

  it("rejects group targets by default to preserve LoRa airtime", async () => {
    const sendText = vi.fn(async () => 101);
    const handle = {
      accountId: "default",
      myNodeNum: 123,
      device: { sendText },
    };
    getMeshtasticDeviceMock.mockReturnValue(handle);

    await expect(
      sendMessageMeshtastic("channel:0", "broadcast forbidden", {
        cfg: createConfig(),
      }),
    ).rejects.toThrow(/receive-only/);

    await expect(
      sendMessageMeshtastic("broadcast", "broadcast forbidden", {
        cfg: createConfig(),
      }),
    ).rejects.toThrow(/receive-only/);

    expect(sendText).not.toHaveBeenCalled();
  });

  it("rejects group targets when groupTransmit is explicitly false", async () => {
    const sendText = vi.fn(async () => 101);
    const handle = {
      accountId: "default",
      myNodeNum: 123,
      device: { sendText },
    };
    getMeshtasticDeviceMock.mockReturnValue(handle);

    await expect(
      sendMessageMeshtastic("channel:0", "broadcast forbidden", {
        cfg: createConfig({ groupTransmit: false }),
      }),
    ).rejects.toThrow(/receive-only/);

    expect(sendText).not.toHaveBeenCalled();
  });

  it("transmits to group targets when groupTransmit is opted in", async () => {
    const sendText = vi.fn(async () => 42);
    const handle = {
      accountId: "default",
      myNodeNum: 123,
      device: { sendText },
    };
    getMeshtasticDeviceMock.mockReturnValue(handle);

    const result = await sendMessageMeshtastic("channel:0", "fleet update", {
      cfg: createConfig({ groupTransmit: true }),
      ackWaitMs: 50,
    });

    expect(sendText).toHaveBeenCalledWith("fleet update", "broadcast", true, 0, undefined);
    expect(result.target).toBe("channel:0");
  });

  it("refuses DMs once the rolling rate-limit budget is exhausted", async () => {
    const sendText = vi.fn(async () => 42);
    const handle = {
      accountId: "default",
      myNodeNum: 123,
      device: { sendText },
    };
    getMeshtasticDeviceMock.mockReturnValue(handle);
    const cfg = createConfig({ sendRateLimit: { maxSends: 2, windowMs: 60_000 } });

    await sendMessageMeshtastic("!00000002", "one", { cfg });
    await sendMessageMeshtastic("!00000002", "two", { cfg });
    expect(sendText).toHaveBeenCalledTimes(2);

    await expect(sendMessageMeshtastic("!00000002", "three", { cfg })).rejects.toThrow(
      /rate limit/,
    );
    expect(sendText).toHaveBeenCalledTimes(2);
  });

  it("caps opted-in group sends at the stricter group budget while DMs still pass", async () => {
    const sendText = vi.fn(async () => 42);
    const handle = {
      accountId: "default",
      myNodeNum: 123,
      device: { sendText },
    };
    getMeshtasticDeviceMock.mockReturnValue(handle);
    const cfg = createConfig({
      groupTransmit: true,
      sendRateLimit: { maxSends: 5, groupMaxSends: 1, windowMs: 60_000 },
    });

    await sendMessageMeshtastic("channel:0", "fleet one", { cfg });
    await expect(sendMessageMeshtastic("channel:0", "fleet two", { cfg })).rejects.toThrow(
      /rate limit/,
    );
    await sendMessageMeshtastic("!00000002", "dm still fine", { cfg });
    expect(sendText).toHaveBeenCalledTimes(2);
  });

  it("uses the packet queued by sendText when ACK does not resolve", async () => {
    const queued: Array<{ id: number; added: Date }> = [];
    const sendText = vi.fn(() => {
      queued.push({ id: 88, added: new Date() });
      return new Promise<number>(() => undefined);
    });
    const handle = {
      accountId: "default",
      myNodeNum: 123,
      device: {
        sendText,
        queue: {
          getState: () => queued,
        },
      },
    };
    getMeshtasticDeviceMock.mockReturnValue(handle);

    const result = await sendMessageMeshtastic("channel:3", "queued mesh", {
      cfg: createConfig({ groupTransmit: true }),
      ackWaitMs: 1,
    });

    expect(result.messageId).toBe("88");
  });

  it("uses the ACK packet id when Meshtastic resolves quickly", async () => {
    const sendText = vi.fn(async () => 99);
    const handle = {
      accountId: "default",
      myNodeNum: 123,
      device: {
        sendText,
        queue: {
          getState: () => [{ id: 77, added: new Date() }],
        },
      },
    };
    getMeshtasticDeviceMock.mockReturnValue(handle);

    const result = await sendMessageMeshtastic("!00000002", "hello dm", {
      cfg: createConfig(),
      ackWaitMs: 50,
    });

    expect(sendText).toHaveBeenCalledWith("hello dm", 2, true, undefined, undefined);
    expect(result.messageId).toBe("99");
    expect(result.target).toBe("!00000002");
  });

  it("does not split surrogate pairs when chunking text", async () => {
    const sendText = vi.fn(async () => 101);
    const handle = {
      accountId: "default",
      myNodeNum: 123,
      device: {
        sendText,
        queue: {
          getState: () => [{ id: 101, added: new Date() }],
        },
      },
    };
    getMeshtasticDeviceMock.mockReturnValue(handle);

    await sendMessageMeshtastic("channel:3", "😀😀😀", {
      cfg: {
        channels: {
          meshtastic: {
            host: "192.168.1.10",
            textChunkLimit: 2,
            groupTransmit: true,
          },
        },
      } as CoreConfig,
      ackWaitMs: 50,
    });

    expect(sendText).toHaveBeenNthCalledWith(1, "😀😀", "broadcast", true, 3, undefined);
    expect(sendText).toHaveBeenNthCalledWith(2, "😀", "broadcast", true, 3, undefined);
  });

  it("marks outbound text before sendText can emit a local echo", async () => {
    const sendText = vi.fn(async (text: string) => {
      expect(isOutboundEcho(text)).toBe(true);
      return 101;
    });
    const handle = {
      accountId: "default",
      myNodeNum: 123,
      device: {
        sendText,
        queue: {
          getState: () => [{ id: 101, added: new Date() }],
        },
      },
    };
    getMeshtasticDeviceMock.mockReturnValue(handle);

    await sendMessageMeshtastic("channel:3", "echo me", {
      cfg: createConfig({ groupTransmit: true }),
      ackWaitMs: 50,
    });

    expect(sendText).toHaveBeenCalledWith("echo me", "broadcast", true, 3, undefined);
  });

  it("uses a timestamp fallback message id when ACK and queue id are unavailable", async () => {
    const sendText = vi.fn(() => new Promise<number>(() => undefined));
    const handle = {
      accountId: "default",
      myNodeNum: 123,
      device: {
        sendText,
      },
    };
    getMeshtasticDeviceMock.mockReturnValue(handle);

    const result = await sendMessageMeshtastic("!00000002", "no ack", {
      cfg: createConfig(),
      ackWaitMs: 1,
    });

    expect(result.messageId).toMatch(/^fallback:\d+$/);
  });
});

describe("reserved broadcast refusal", () => {
  afterEach(() => {
    clearOutboundEchoCache();
    vi.clearAllMocks();
    clearSendRateLimitState();
  });

  const BROADCAST_FORMS = [
    "4294967295",
    "node:4294967295",
    "!ffffffff",
    "!FFFFFFFF",
    "meshtastic:!ffffffff",
    "!0ffffffff",
    "^all",
    "^ALL",
    "meshtastic:^all",
  ];

  it.each(BROADCAST_FORMS)("refuses %s by default", async (form) => {
    const sendText = vi.fn(async () => 42);
    getMeshtasticDeviceMock.mockReturnValue({
      accountId: "default",
      myNodeNum: 123,
      device: { sendText },
    });

    await expect(
      sendMessageMeshtastic(form, "no broadcast", { cfg: createConfig() }),
    ).rejects.toThrow(/reserved broadcast/i);
    expect(sendText).not.toHaveBeenCalled();
  });

  it.each(BROADCAST_FORMS)("refuses %s even with groupTransmit opted in", async (form) => {
    const sendText = vi.fn(async () => 42);
    getMeshtasticDeviceMock.mockReturnValue({
      accountId: "default",
      myNodeNum: 123,
      device: { sendText },
    });

    await expect(
      sendMessageMeshtastic(form, "no broadcast", {
        cfg: createConfig({ groupTransmit: true }),
      }),
    ).rejects.toThrow(/reserved broadcast/i);
    expect(sendText).not.toHaveBeenCalled();
  });

  it("still allows a direct node DM with groupTransmit opted in", async () => {
    const sendText = vi.fn(async () => 42);
    getMeshtasticDeviceMock.mockReturnValue({
      accountId: "default",
      myNodeNum: 123,
      device: { sendText },
    });

    const result = await sendMessageMeshtastic("!00000002", "dm ok", {
      cfg: createConfig({ groupTransmit: true }),
      ackWaitMs: 50,
    });

    expect(sendText).toHaveBeenCalledWith("dm ok", 2, true, undefined, undefined);
    expect(result.target).toBe("!00000002");
  });
});

describe("out-of-range node number refusal", () => {
  afterEach(() => {
    clearOutboundEchoCache();
    vi.clearAllMocks();
    clearSendRateLimitState();
  });

  it.each(["!1ffffffff", "node:4294967296", "!00000000", "node:0"])(
    "refuses %s as out of range",
    async (form) => {
      const sendText = vi.fn(async () => 42);
      getMeshtasticDeviceMock.mockReturnValue({
        accountId: "default",
        myNodeNum: 123,
        device: { sendText },
      });

      await expect(
        sendMessageMeshtastic(form, "no wrap", {
          cfg: createConfig({ groupTransmit: true }),
        }),
      ).rejects.toThrow(/valid node numbers are 1-4294967294/);
      expect(sendText).not.toHaveBeenCalled();
    },
  );

  it("refuses at the device exit even when called directly", async () => {
    const sendText = vi.fn(async () => 42);
    const handle = { accountId: "default", myNodeNum: 123, device: { sendText } };

    await expect(
      sendTextWithoutBlockingForAck({ handle, text: "wrap", destination: 8589934591 }),
    ).rejects.toThrow(/not a valid node number/);
    expect(sendText).not.toHaveBeenCalled();

    const ok = await sendTextWithoutBlockingForAck({
      handle,
      text: "ok",
      destination: 2,
      ackWaitMs: 5,
    });
    expect(sendText).toHaveBeenCalledWith("ok", 2, true, undefined, undefined);
    expect(ok).toBe(42);
  });
});
