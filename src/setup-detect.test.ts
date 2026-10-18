import { describe, expect, it } from "vitest";
import { diagnoseProbeFailure, splitHostPort } from "./setup-detect.js";

describe("splitHostPort", () => {
  it("returns plain hosts untouched", () => {
    expect(splitHostPort("node.local")).toEqual({ host: "node.local" });
    expect(splitHostPort("192.168.1.225")).toEqual({ host: "192.168.1.225" });
  });

  it("splits host:port on the last colon when the suffix is numeric", () => {
    expect(splitHostPort("node.local:4403")).toEqual({ host: "node.local", port: 4403 });
    expect(splitHostPort(" 192.168.1.225:4433 ")).toEqual({ host: "192.168.1.225", port: 4433 });
  });

  it("treats non-numeric suffixes as part of the host", () => {
    expect(splitHostPort("weird:abc")).toEqual({ host: "weird:abc" });
    expect(splitHostPort("node:")).toEqual({ host: "node:" });
  });

  it("rejects out-of-range ports as host text", () => {
    expect(splitHostPort("node:0")).toEqual({ host: "node:0" });
    expect(splitHostPort("node:99999")).toEqual({ host: "node:99999" });
  });

  it("handles empty input", () => {
    expect(splitHostPort("")).toEqual({ host: "" });
    expect(splitHostPort("   ")).toEqual({ host: "" });
  });
});

describe("diagnoseProbeFailure", () => {
  it("maps the HTTP 404/405 probe result to the 4403≠4433 trap with a TCP suggestion", () => {
    const diagnosis = diagnoseProbeFailure({
      transport: "http",
      host: "192.168.1.225",
      port: 4403,
      error: "All HTTP probe endpoints returned 404/405",
    });
    expect(diagnosis.summary).toMatch(/4403/);
    expect(diagnosis.suggestTransport).toBe("tcp");
    expect(diagnosis.suggestPort).toBe(4403);
  });

  it("explains ECONNREFUSED as nothing-listening", () => {
    const diagnosis = diagnoseProbeFailure({
      transport: "tcp",
      host: "192.168.1.99",
      port: 4403,
      error: "connect ECONNREFUSED 192.168.1.99:4403",
    });
    expect(diagnosis.summary).toMatch(/Nothing is listening/);
    expect(diagnosis.hints.join(" ")).toMatch(/4403/);
  });

  it("calls out HTTP-API-disabled on refused HTTP connections", () => {
    const diagnosis = diagnoseProbeFailure({
      transport: "http",
      host: "node.local",
      port: 4433,
      error: "connect ECONNREFUSED node.local:4433",
    });
    expect(diagnosis.hints.join(" ")).toMatch(/HTTP API \(port 4433\) is OFF by default/i);
  });

  it("maps timeouts to network path problems", () => {
    const diagnosis = diagnoseProbeFailure({
      transport: "tcp",
      host: "node.local",
      port: 4403,
      error: "This operation was aborted",
    });
    expect(diagnosis.summary).toMatch(/did not answer in time/);
    expect(diagnosis.hints.join(" ")).toMatch(/VLAN|isolation/i);
  });

  it("maps serial ENOENT to cable/port guidance", () => {
    const diagnosis = diagnoseProbeFailure({
      transport: "serial",
      host: "",
      port: 0,
      serialPath: "/dev/cu.usbserial-0001",
      error: "ENOENT: no such file or directory",
    });
    expect(diagnosis.summary).toMatch(/does not exist/);
    expect(diagnosis.hints.join(" ")).toMatch(/data cable/i);
  });

  it("maps serial busy to the single-owner rule", () => {
    const diagnosis = diagnoseProbeFailure({
      transport: "serial",
      host: "",
      port: 0,
      serialPath: "/dev/ttyUSB0",
      error: "Error: Resource temporarily unavailable Cannot lock port",
    });
    expect(diagnosis.summary).toMatch(/busy|not accessible/i);
    expect(diagnosis.hints.join(" ")).toMatch(/Only one process/i);
  });

  it("maps TLS failures to the plain-HTTP default", () => {
    const diagnosis = diagnoseProbeFailure({
      transport: "http",
      host: "node.local",
      port: 4433,
      error: "wrong version number (SSL routines)",
    });
    expect(diagnosis.summary).toMatch(/TLS handshake failed/);
    expect(diagnosis.suggestPort).toBe(4433);
  });

  it("falls back to generic guidance for unknown errors", () => {
    const diagnosis = diagnoseProbeFailure({
      transport: "tcp",
      host: "node.local",
      port: 4403,
      error: "something entirely unexpected",
    });
    expect(diagnosis.summary).toMatch(/Could not reach/);
    expect(diagnosis.hints.join(" ")).toMatch(/4403/);
  });
});
