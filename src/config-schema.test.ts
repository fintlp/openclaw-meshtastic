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
});
