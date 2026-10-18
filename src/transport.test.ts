import { describe, expect, it } from "vitest";
import {
  defaultPortForTransport,
  formatMeshtasticEndpoint,
  normalizeMeshtasticTransport,
} from "./transport.js";

describe("meshtastic transport helpers", () => {
  it("normalizes transport names", () => {
    expect(normalizeMeshtasticTransport("http")).toBe("http");
    expect(normalizeMeshtasticTransport("HTTP")).toBe("http");
    expect(normalizeMeshtasticTransport("TCP")).toBe("tcp");
    expect(normalizeMeshtasticTransport("serial")).toBe("serial");
    expect(normalizeMeshtasticTransport(undefined)).toBe("tcp");
    expect(normalizeMeshtasticTransport("ble")).toBe("tcp");
  });

  it("picks default ports per transport", () => {
    expect(defaultPortForTransport("http")).toBe(4433);
    expect(defaultPortForTransport("tcp")).toBe(4403);
  });

  it("formats endpoints for status output", () => {
    expect(
      formatMeshtasticEndpoint({
        transport: "tcp",
        host: "127.0.0.1",
        port: 4403,
        tls: false,
      }),
    ).toBe("127.0.0.1:4403");
    expect(
      formatMeshtasticEndpoint({
        transport: "serial",
        host: "",
        port: 0,
        tls: false,
        serialPath: "/dev/ttyUSB0",
      }),
    ).toBe("/dev/ttyUSB0");
  });
});
