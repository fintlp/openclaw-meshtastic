import { readFileSync } from "node:fs";
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

  it("defaults pkiMismatch to drop (2026.11.1, MCP07) and still accepts the legacy unverified policy", () => {
    const def = expectValidConfig(MeshtasticConfigSchema.safeParse({}));
    expect(def.pkiMismatch).toBe("drop");
    const legacy = expectValidConfig(MeshtasticConfigSchema.safeParse({ pkiMismatch: "unverified" }));
    expect(legacy.pkiMismatch).toBe("unverified");
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

  it("T22 identity gate config: dmIdentity/commandIdentity defaults and the key-bound manual form (MCP07)", () => {
    const def = expectValidConfig(MeshtasticConfigSchema.safeParse({}));
    expect(def.dmIdentity).toBe("known-keys");
    expect(def.commandIdentity).toBe("verified");
    expectInvalidConfig(MeshtasticConfigSchema.safeParse({ dmIdentity: "paranoid" }));
    expectInvalidConfig(MeshtasticConfigSchema.safeParse({ commandIdentity: "yolo" }));

    const key = Buffer.alloc(32, 0x11).toString("base64");
    const ok = expectValidConfig(
      MeshtasticConfigSchema.safeParse({
        pkiManuallyVerified: ["!00000002", `!0a0b0c0d=${key}`],
      }),
    );
    expect(ok.pkiManuallyVerified).toEqual(["!00000002", `!0a0b0c0d=${key}`]);

    // Wrong key length, non-base64, non-canonical padding, and bad ids are refused.
    expectInvalidConfig(
      MeshtasticConfigSchema.safeParse({
        pkiManuallyVerified: [`!00000002=${Buffer.alloc(16, 1).toString("base64")}`],
      }),
    );
    expectInvalidConfig(
      MeshtasticConfigSchema.safeParse({ pkiManuallyVerified: ["!00000002=!!!not-base64!!!"] }),
    );
    expectInvalidConfig(
      MeshtasticConfigSchema.safeParse({ pkiManuallyVerified: [`!00000002=${key.slice(0, -1)}A`] }),
    );
    expectInvalidConfig(
      MeshtasticConfigSchema.safeParse({ pkiManuallyVerified: [`!ffffffff=${key}`] }),
    );
    expectInvalidConfig(
      MeshtasticConfigSchema.safeParse({ pkiManuallyVerified: [`not-a-node=${key}`] }),
    );
  });

  it("pairingIdentity defaults to verified and rejects bogus values (B1)", () => {
    const def = expectValidConfig(MeshtasticConfigSchema.safeParse({}));
    expect(def.pairingIdentity).toBe("verified");
    const any = expectValidConfig(MeshtasticConfigSchema.safeParse({ pairingIdentity: "any" }));
    expect(any.pairingIdentity).toBe("any");
    expectInvalidConfig(MeshtasticConfigSchema.safeParse({ pairingIdentity: "open" }));
  });

  it("accepts deny-only sender keys at root/named accounts and the same node in different groups", () => {
    const config = expectValidConfig(
      MeshtasticConfigSchema.safeParse({
        groups: {
          "channel:0": {
            toolsBySender: {
              "*": { deny: ["exec"] },
              "id:!AABBCCDD": { deny: ["write"] },
              "channel:meshtastic:!11223344": { deny: ["read"] },
            },
          },
          "channel:1": {
            toolsBySender: {
              "channel:meshtastic:!aabbccdd": { deny: ["status"] },
            },
          },
        },
        accounts: {
          work: {
            groups: {
              "channel:0": {
                toolsBySender: { "id:!aabbccdd": { deny: ["exec"] } },
              },
            },
          },
        },
      }),
    );

    expect(config.groups?.["channel:0"]?.toolsBySender?.["id:!AABBCCDD"]).toEqual({
      deny: ["write"],
    });
  });

  it("rejects sender allow/alsoAllow/unknown fields with the deny-only migration at root and named accounts", () => {
    const rules = [
      { deny: ["exec"], allow: ["read"] },
      { deny: ["exec"], alsoAllow: ["read"] },
      { deny: ["exec"], unexpected: true },
    ];
    for (const rule of rules) {
      for (const scoped of [false, true]) {
        const group = { toolsBySender: { "id:!aabbccdd": rule } };
        const result = MeshtasticConfigSchema.safeParse(
          scoped
            ? { accounts: { work: { groups: { "channel:0": group } } } }
            : { groups: { "channel:0": group } },
        );
        const issues = expectInvalidConfig(result);
        expect(issues.map((issue) => issue.message).join("\n")).toContain(
          "toolsBySender is deny-only; move allowlists to groups.<id>.tools.allow or the dedicated agent",
        );
      }
    }
  });

  it("rejects bare, malformed, wrong-channel, short and reserved sender keys", () => {
    const keys = [
      "!aabbccdd",
      "id:!aabbccd",
      "id:!aabbccdd0",
      "channel:telegram:!aabbccdd",
      "channel:meshtastic:aabbccdd",
      "node:!aabbccdd",
      "id:!00000000",
      "channel:meshtastic:!FFFFFFFF",
    ];
    for (const key of keys) {
      const issues = expectInvalidConfig(
        MeshtasticConfigSchema.safeParse({
          groups: {
            "channel:0": { toolsBySender: { [key]: { deny: ["exec"] } } },
          },
        }),
      );
      expect(issues.map((issue) => issue.message).join("\n")).toContain(
        key === "!aabbccdd" ? 'migrate a bare "!xxxxxxxx" key to "id:!xxxxxxxx"' : "keys must be",
      );
    }
  });

  it("rejects duplicate canonical node keys within one root or named-account map", () => {
    const toolsBySender = {
      "id:!AaBbCcDd": { deny: ["exec"] },
      "channel:meshtastic:!aabbccdd": { deny: ["write"] },
    };
    for (const scoped of [false, true]) {
      const group = { toolsBySender };
      const issues = expectInvalidConfig(
        MeshtasticConfigSchema.safeParse(
          scoped
            ? { accounts: { work: { groups: { "channel:0": group } } } }
            : { groups: { "channel:0": group } },
        ),
      );
      expect(issues.map((issue) => issue.message).join("\n")).toContain(
        "duplicate toolsBySender rule for canonical node !aabbccdd",
      );
    }
  });

  it("requires at least one non-blank deny selector per sender rule", () => {
    for (const rule of [{}, { deny: [] }, { deny: [""] }, { deny: [" \t "] }]) {
      expectInvalidConfig(
        MeshtasticConfigSchema.safeParse({
          groups: {
            "channel:0": { toolsBySender: { "*": rule } },
          },
        }),
      );
    }
  });

  it("generated manifest carries the same deny-only key and rule validation for root and named accounts", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
    ) as any;
    const properties = manifest.channelConfigs.meshtastic.schema.properties;
    const root = properties.groups.additionalProperties.properties.toolsBySender;
    const named =
      properties.accounts.additionalProperties.properties.groups.additionalProperties.properties
        .toolsBySender;

    expect(named).toEqual(root);
    for (const schema of [root, named]) {
      expect(schema.propertyNames.pattern).toContain("channel:meshtastic:");
      expect(schema.propertyNames.pattern).toContain("[0-9a-fA-F]{8}");
      expect(schema.additionalProperties.additionalProperties).toBe(false);
      expect(schema.additionalProperties.required).toEqual(["deny"]);
      expect(schema.additionalProperties.properties).toEqual({
        deny: {
          minItems: 1,
          type: "array",
          items: { type: "string", minLength: 1, pattern: "\\S" },
        },
      });
      expect(schema.additionalProperties.properties.allow).toBeUndefined();
      expect(schema.additionalProperties.properties.alsoAllow).toBeUndefined();
    }
  });
})
