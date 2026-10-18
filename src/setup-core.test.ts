import { describe, expect, it } from "vitest";
import { meshtasticSetupAdapter, parseBaudRate, parsePort } from "./setup-core.js";
import type { CoreConfig } from "./types.js";

const ACCOUNT_ID = "default";

function applyInput(input: Record<string, unknown>, cfg: CoreConfig = {} as CoreConfig) {
  const next = meshtasticSetupAdapter.applyAccountConfig?.({
    cfg,
    accountId: ACCOUNT_ID,
    input,
    // biome-ignore lint/suspicious/noExplicitAny: minimal test context
  } as any) as CoreConfig;
  return next?.channels?.meshtastic;
}

describe("parsePort", () => {
  it("parses valid ports and falls back on junk", () => {
    expect(parsePort("4403", 4433)).toBe(4403);
    expect(parsePort("", 4433)).toBe(4433);
    expect(parsePort("abc", 4433)).toBe(4433);
    expect(parsePort("99999", 4433)).toBe(4433);
  });
});

describe("parseBaudRate", () => {
  it("accepts serial baud rates beyond the TCP port range", () => {
    expect(parseBaudRate("115200")).toBe(115_200);
    expect(parseBaudRate("460800")).toBe(460_800);
    expect(parseBaudRate("")).toBe(115_200);
    expect(parseBaudRate("123")).toBe(115_200);
    expect(parseBaudRate("9999999")).toBe(115_200);
  });
});

describe("meshtasticSetupAdapter.applyAccountConfig", () => {
  it("keeps the HTTP default port 4433 when no transport is given", () => {
    const section = applyInput({ host: "node.local", port: "" });
    expect(section?.host).toBe("node.local");
    expect(section?.port).toBe(4433);
  });

  it("defaults TCP transport to port 4403", () => {
    const section = applyInput({ transport: "tcp", host: "node.local" });
    expect(section?.transport).toBe("tcp");
    expect(section?.port).toBe(4403);
  });

  it("parses host:port suffix from --host", () => {
    const section = applyInput({ transport: "tcp", host: "node.local:4401" });
    expect(section?.host).toBe("node.local");
    expect(section?.port).toBe(4401);
  });

  it("explicit port wins over the suffix default chain", () => {
    const section = applyInput({ transport: "tcp", host: "node.local:4401", port: "4404" });
    expect(section?.host).toBe("node.local");
    expect(section?.port).toBe(4404);
  });

  it("serial input drops host/port and carries serialPath + baudRate", () => {
    const section = applyInput({
      transport: "serial",
      serialPath: "/dev/ttyUSB0",
      baudRate: "460800",
    });
    expect(section?.transport).toBe("serial");
    expect(section?.serialPath).toBe("/dev/ttyUSB0");
    expect(section?.baudRate).toBe(460_800);
    expect(section?.port).toBeUndefined();
  });

  it("serialPath alone implies serial transport", () => {
    const section = applyInput({ serialPath: "/dev/ttyUSB0" });
    expect(section?.transport).toBe("serial");
    expect(section?.serialPath).toBe("/dev/ttyUSB0");
  });

  it("accepts valid dmPolicy values and ignores invalid ones", () => {
    expect(applyInput({ host: "n", dmPolicy: "open" })?.dmPolicy).toBe("open");
    expect(applyInput({ host: "n", dmPolicy: "Pairing" })?.dmPolicy).toBe("pairing");
    expect(applyInput({ host: "n", dmPolicy: "bogus" })?.dmPolicy).toBeUndefined();
  });

  it("normalizes groupTransmit from booleans and strings", () => {
    expect(applyInput({ host: "n", groupTransmit: true })?.groupTransmit).toBe(true);
    expect(applyInput({ host: "n", groupTransmit: "true" })?.groupTransmit).toBe(true);
    expect(applyInput({ host: "n", groupTransmit: "off" })?.groupTransmit).toBe(false);
    expect(applyInput({ host: "n" })?.groupTransmit).toBeUndefined();
  });
});

describe("meshtasticSetupAdapter.validateInput", () => {
  it("accepts serialPath as an alternative to host", () => {
    const result = meshtasticSetupAdapter.validateInput?.({
      cfg: {} as CoreConfig,
      accountId: ACCOUNT_ID,
      input: { serialPath: "/dev/ttyUSB0" },
      // biome-ignore lint/suspicious/noExplicitAny: minimal test context
    } as any);
    expect(result).toBeFalsy();
  });

  it("still rejects input with neither host nor serialPath", () => {
    const result = meshtasticSetupAdapter.validateInput?.({
      cfg: {} as CoreConfig,
      accountId: ACCOUNT_ID,
      input: {},
      // biome-ignore lint/suspicious/noExplicitAny: minimal test context
    } as any);
    expect(String(result)).toMatch(/host|serialPath/);
  });
});
