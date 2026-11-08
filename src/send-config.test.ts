import { describe, expect, it } from "vitest";
import { sendMessageMeshtastic } from "./send.js";

// Replaces the deprecated SDK helper requireRuntimeConfig
// (openclaw/plugin-sdk/plugin-config-runtime). A send without a resolved
// config must still fail fast, before any device access.
describe("sendMessageMeshtastic config guard", () => {
  it("rejects when no resolved runtime config is passed", async () => {
    await expect(
      sendMessageMeshtastic("!00000001", "hi", { cfg: undefined } as unknown as Parameters<typeof sendMessageMeshtastic>[2]),
    ).rejects.toThrow("Meshtastic send requires a resolved runtime config");
  });
});
