import {
  createMessageReceiptFromOutboundResults,
  verifyChannelMessageAdapterCapabilityProofs,
} from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it, vi } from "vitest";
import { meshtasticMessageAdapter } from "./message-adapter.js";

const sendMessageMeshtasticMock = vi.hoisted(() => vi.fn());

vi.mock("./send.js", () => ({
  sendMessageMeshtastic: sendMessageMeshtasticMock,
}));

const cfg = {
  channels: {
    meshtastic: {
      host: "192.168.1.10",
      port: 4433,
    },
  },
} as OpenClawConfig;

describe("meshtastic message adapter", () => {
  it("declares durable text and replyTo capabilities with receipt proofs", async () => {
    sendMessageMeshtasticMock.mockResolvedValue({
      messageId: "99",
      target: "!00000001",
      receipt: createMessageReceiptFromOutboundResults({
        results: [{ channel: "meshtastic", messageId: "99" }],
        kind: "text",
      }),
    });

    await verifyChannelMessageAdapterCapabilityProofs({
      adapterName: "meshtastic",
      adapter: meshtasticMessageAdapter,
      proofs: {
        text: async () => {
          const result = await meshtasticMessageAdapter.send?.text?.({
            cfg,
            to: "!00000001",
            text: "hello mesh",
          });
          expect(sendMessageMeshtasticMock).toHaveBeenCalledWith(
            "!00000001",
            "hello mesh",
            expect.objectContaining({
              cfg,
            }),
          );
          expect(result?.receipt.platformMessageIds).toEqual(["99"]);
        },
        replyTo: async () => {
          sendMessageMeshtasticMock.mockResolvedValueOnce({
            messageId: "100",
            target: "channel:0",
            receipt: createMessageReceiptFromOutboundResults({
              results: [{ channel: "meshtastic", messageId: "100" }],
              kind: "text",
              replyToId: "42",
            }),
          });
          const result = await meshtasticMessageAdapter.send?.text?.({
            cfg,
            to: "channel:0",
            text: "reply body",
            replyToId: "42",
          });
          expect(sendMessageMeshtasticMock).toHaveBeenCalledWith(
            "channel:0",
            "reply body",
            expect.objectContaining({
              cfg,
              replyTo: "42",
            }),
          );
          expect(result?.receipt.replyToId).toBe("42");
        },
      },
    });
  });
});
