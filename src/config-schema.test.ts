import { describe, expect, it } from "vitest";
import { MeshtasticConfigSchema } from "./config-schema.js";

function expectValidConfig(result: ReturnType<typeof MeshtasticConfigSchema.safeParse>) {
  expect(result.success).toBe(true);
  if (!result.success) {
    throw new Error("expected config to be valid");
  }
  return result.data;
}

function expectInvalidConfig(result: ReturnType<typeof MeshtasticConfigSchema.safeParse>) {
  expect(result.success).toBe(false);
  if (result.success) {
    throw new Error("expected config to be invalid");
  }
  return result.error.issues;
}

describe("meshtastic config schema", () => {
  it("accepts basic config", () => {
    const config = expectValidConfig(
      MeshtasticConfigSchema.safeParse({
        host: "192.168.1.10",
        port: 4433,
        channels: [0],
      }),
    );

    expect(config.host).toBe("192.168.1.10");
    expect(config.port).toBe(4433);
    expect(config.transport).toBe("tcp");
    expect(config.channels).toEqual([0]);
  });

  it("defaults groupPolicy to disabled", () => {
    const config = expectValidConfig(
      MeshtasticConfigSchema.safeParse({
        host: "192.168.1.10",
      }),
    );
    expect(config.groupPolicy).toBe("disabled");
  });

  it("still accepts explicit allowlist groupPolicy", () => {
    const config = expectValidConfig(
      MeshtasticConfigSchema.safeParse({
        host: "192.168.1.10",
        groupPolicy: "allowlist",
      }),
    );
    expect(config.groupPolicy).toBe("allowlist");
  });

  it("accepts logInboundMessageContent opt-in", () => {
    const config = expectValidConfig(
      MeshtasticConfigSchema.safeParse({
        host: "192.168.1.10",
        logInboundMessageContent: true,
      }),
    );
    expect(config.logInboundMessageContent).toBe(true);
  });

  it('rejects dmPolicy="open" without allowFrom "*"', () => {
    const issues = expectInvalidConfig(
      MeshtasticConfigSchema.safeParse({
        dmPolicy: "open",
        allowFrom: ["!00000001"],
      }),
    );

    expect(issues[0]?.path.join(".")).toBe("allowFrom");
  });

  it('accepts dmPolicy="open" with allowFrom "*"', () => {
    const config = expectValidConfig(
      MeshtasticConfigSchema.safeParse({
        dmPolicy: "open",
        allowFrom: ["*"],
      }),
    );

    expect(config.dmPolicy).toBe("open");
  });

  it("accepts tcp and serial transport options", () => {
    const tcp = expectValidConfig(
      MeshtasticConfigSchema.safeParse({
        transport: "tcp",
        host: "127.0.0.1",
        port: 4403,
      }),
    );
    expect(tcp.transport).toBe("tcp");

    const serial = expectValidConfig(
      MeshtasticConfigSchema.safeParse({
        transport: "serial",
        serialPath: "/dev/ttyUSB0",
        baudRate: 115200,
      }),
    );
    expect(serial.transport).toBe("serial");
    expect(serial.serialPath).toBe("/dev/ttyUSB0");
  });

  it("accepts numeric allowFrom entries", () => {
    const parsed = MeshtasticConfigSchema.parse({
      dmPolicy: "allowlist",
      allowFrom: [12345, "!00000001"],
    });

    expect(parsed.allowFrom).toEqual([12345, "!00000001"]);
  });

  it("defaults pkiMismatch to unverified and accepts the drop policy (issue #7)", () => {
    const def = expectValidConfig(MeshtasticConfigSchema.safeParse({}));
    expect(def.pkiMismatch).toBe("unverified");
    const drop = expectValidConfig(MeshtasticConfigSchema.safeParse({ pkiMismatch: "drop" }));
    expect(drop.pkiMismatch).toBe("drop");
    expectInvalidConfig(MeshtasticConfigSchema.safeParse({ pkiMismatch: "verify-anyway" }));
  });

  it("validates pkiRepin / pkiManuallyVerified entries as node ids (issue #7)", () => {
    const ok = expectValidConfig(
      MeshtasticConfigSchema.safeParse({
        pkiRepin: ["!0a0b0c0d", "node:456", "789"],
        pkiManuallyVerified: ["!00000002"],
      }),
    );
    expect(ok.pkiRepin).toEqual(["!0a0b0c0d", "node:456", "789"]);
    // Wildcards, broadcast, zero, channel targets and junk are refused.
    expectInvalidConfig(MeshtasticConfigSchema.safeParse({ pkiRepin: ["*"] }));
    expectInvalidConfig(MeshtasticConfigSchema.safeParse({ pkiRepin: ["!ffffffff"] }));
    expectInvalidConfig(MeshtasticConfigSchema.safeParse({ pkiRepin: ["!00000000"] }));
    expectInvalidConfig(MeshtasticConfigSchema.safeParse({ pkiRepin: ["channel:0"] }));
    expectInvalidConfig(MeshtasticConfigSchema.safeParse({ pkiManuallyVerified: ["not-a-node"] }));
  });
});
