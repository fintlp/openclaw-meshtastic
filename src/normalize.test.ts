import { describe, expect, it } from "vitest";
import {
  formatMeshtasticChannelTarget,
  formatMeshtasticNodeId,
  isMeshtasticBroadcastAlias,
  isReservedMeshtasticBroadcastTarget,
  isValidMeshtasticNodeNum,
  normalizeMeshtasticAllowEntry,
  normalizeMeshtasticMessagingTarget,
  parseMeshtasticChannelIndex,
  parseMeshtasticNodeNum,
  resolveMeshtasticAllowlistMatch,
} from "./normalize.js";

describe("meshtastic normalize", () => {
  it("formats and parses node ids", () => {
    expect(formatMeshtasticNodeId(305419896)).toBe("!12345678");
    expect(parseMeshtasticNodeNum("!12345678")).toBe(305419896);
    expect(parseMeshtasticNodeNum("node:305419896")).toBe(305419896);
    expect(parseMeshtasticNodeNum("305419896")).toBe(305419896);
  });

  it("normalizes messaging targets", () => {
    expect(normalizeMeshtasticMessagingTarget("meshtastic:channel:0")).toBe("channel:0");
    expect(normalizeMeshtasticMessagingTarget("ch:2")).toBe("channel:2");
    expect(normalizeMeshtasticMessagingTarget("broadcast")).toBe("channel:0");
    expect(normalizeMeshtasticMessagingTarget("!00000001")).toBe("!00000001");
    expect(normalizeMeshtasticMessagingTarget("\n")).toBeUndefined();
  });

  it("parses channel indices", () => {
    expect(parseMeshtasticChannelIndex("channel:0")).toBe(0);
    expect(parseMeshtasticChannelIndex("ch:3")).toBe(3);
    expect(formatMeshtasticChannelTarget(1)).toBe("channel:1");
  });

  it("normalizes allowlist entries", () => {
    expect(normalizeMeshtasticAllowEntry("node:1")).toBe("!00000001");
    expect(normalizeMeshtasticAllowEntry("meshtastic:!00000002")).toBe("!00000002");
  });

  it("matches senders by node id or decimal", () => {
    expect(
      resolveMeshtasticAllowlistMatch({
        allowFrom: ["!00000001"],
        senderNodeNum: 1,
      }).allowed,
    ).toBe(true);
    expect(
      resolveMeshtasticAllowlistMatch({
        allowFrom: ["1"],
        senderNodeNum: 1,
      }).allowed,
    ).toBe(true);
  });
});

describe("reserved broadcast targets", () => {
  it.each(["^all", "^ALL", "meshtastic:^all"])("alias %s is reserved", (form) => {
    expect(isMeshtasticBroadcastAlias(form)).toBe(true);
    expect(isReservedMeshtasticBroadcastTarget(form)).toBe(true);
  });

  it.each([
    "4294967295",
    "node:4294967295",
    "!ffffffff",
    "!FFFFFFFF",
    "meshtastic:!ffffffff",
  ])("node-number form %s is reserved", (form) => {
    expect(isReservedMeshtasticBroadcastTarget(form)).toBe(true);
  });

  it.each([
    "!00000000",
    "!fffffffe",
    "node:4294967294",
    "channel:0",
    "ch:7",
    "broadcast",
    "!1234abcd",
    "^allx",
    "",
  ])("%j is not reserved", (form) => {
    expect(isReservedMeshtasticBroadcastTarget(form)).toBe(false);
  });

  it("the reserved node id still normalizes (the send-path guard refuses it)", () => {
    expect(normalizeMeshtasticMessagingTarget("!ffffffff")).toBe("!ffffffff");
  });
});

describe("isValidMeshtasticNodeNum", () => {
  it.each([1, 2, 305419896, 4294967294])("accepts %d", (nodeNum) => {
    expect(isValidMeshtasticNodeNum(nodeNum)).toBe(true);
  });

  it.each([0, -1, 4294967295, 4294967296, 8589934591, 1.5, Number.MAX_SAFE_INTEGER])(
    "rejects %d",
    (nodeNum) => {
      expect(isValidMeshtasticNodeNum(nodeNum)).toBe(false);
    },
  );
});
