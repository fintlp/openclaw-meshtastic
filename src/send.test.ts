import { afterEach, describe, expect, it, vi } from "vitest";
import { clearOutboundEchoCache, isOutboundEcho } from "./echo-dedupe.js";
import { sendMessageMeshtastic } from "./send.js";
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

function createConfig(): CoreConfig {
  return {
    channels: {
      meshtastic: {
        host: "192.168.1.10",
        port: 4433,
      },
    },
  } as CoreConfig;
}

describe("sendMessageMeshtastic", () => {
  afterEach(() => {
    clearOutboundEchoCache();
    vi.clearAllMocks();
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
      cfg: createConfig(),
      ackWaitMs: 1,
    });

    expect(sendText).toHaveBeenCalledWith("hello mesh", "broadcast", true, 3, undefined);
    expect(result.messageId).toBe("77");
    expect(result.target).toBe("channel:3");
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
      cfg: createConfig(),
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
      cfg: createConfig(),
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
