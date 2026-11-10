import { describe, expect, it } from "vitest";
import { MeshDevice, Types } from "@meshtastic/core";
import { installUnknownVariantGuard } from "./unknown-variant-guard.js";

/**
 * Issue #25: a decoded mesh packet with a portnum the bundled
 * @meshtastic/core 2.6.7 does not know (portnum 36, NODE_STATUS_APP — added
 * to the upstream protobufs after the 2.6.7 enum was generated) makes the
 * library throw `Unhandled case 36` out of handleMeshPacket. The guard must
 * downgrade that to a DEBUG line without disturbing the dispatch pipeline.
 */

function makeDevice(): MeshDevice {
  const transport = {
    toDevice: new WritableStream({ write() {} }),
    fromDevice: new ReadableStream({ start() {} }),
    disconnect: () => Promise.resolve(),
  } as unknown as Types.Transport;
  return new MeshDevice(transport);
}

function makeLogger(): { lines: string[]; debug: (line: string) => void } {
  const lines: string[] = [];
  return { lines, debug: (line: string) => lines.push(line) };
}

const decodedPacket = {
  id: 4242,
  from: 111,
  to: 4294967295,
  channel: 0,
  rxTime: 1730000000,
  payloadVariant: {
    case: "decoded",
    value: { portnum: 36, payload: new Uint8Array([1, 2, 3]) },
  },
} as unknown as Parameters<MeshDevice["handleMeshPacket"]>[0];

describe("installUnknownVariantGuard (issue #25)", () => {
  it("swallows the library's unknown-portnum throw and logs at DEBUG with the portnum", () => {
    const device = makeDevice();
    const logger = makeLogger();
    installUnknownVariantGuard(device, logger, "testacct");

    expect(() => device.handleMeshPacket(decodedPacket)).not.toThrow();
    expect(logger.lines).toHaveLength(1);
    expect(logger.lines[0]).toContain("[testacct]");
    expect(logger.lines[0]).toContain("Unhandled case 36");
    expect(logger.lines[0]).toContain("portnum 36");
    expect(logger.lines[0]).toContain("id=4242");
  });

  it("keeps the onMeshPacket dispatch pipeline intact for the skipped packet", () => {
    const device = makeDevice();
    const logger = makeLogger();
    installUnknownVariantGuard(device, logger, "testacct");

    let dispatched = 0;
    device.events.onMeshPacket.subscribe(() => {
      dispatched += 1;
    });
    device.handleMeshPacket(decodedPacket);
    expect(dispatched).toBe(1);
  });

  it("passes known packets through untouched (text message still dispatches)", () => {
    const device = makeDevice();
    const logger = makeLogger();
    installUnknownVariantGuard(device, logger, "testacct");

    const texts: string[] = [];
    device.events.onMessagePacket.subscribe((packet: { data: string }) => {
      texts.push(packet.data);
    });

    const textPacket = {
      ...decodedPacket,
      payloadVariant: {
        case: "decoded",
        value: { portnum: 1, payload: new TextEncoder().encode("hello mesh") },
      },
    } as unknown as Parameters<MeshDevice["handleMeshPacket"]>[0];

    expect(() => device.handleMeshPacket(textPacket)).not.toThrow();
    expect(texts).toEqual(["hello mesh"]);
    expect(logger.lines).toHaveLength(0);
  });

  it("downgrades an unrecognized payloadVariant the same way", () => {
    const device = makeDevice();
    const logger = makeLogger();
    installUnknownVariantGuard(device, logger, "testacct");

    const futurePacket = {
      ...decodedPacket,
      payloadVariant: { case: "futureVariant", value: new Uint8Array([9]) },
    } as unknown as Parameters<MeshDevice["handleMeshPacket"]>[0];

    expect(() => device.handleMeshPacket(futurePacket)).not.toThrow();
    expect(logger.lines).toHaveLength(1);
    expect(logger.lines[0]).toContain("Unhandled case futureVariant");
    expect(logger.lines[0]).not.toContain("portnum");
  });

  it("rethrows errors that are not the unknown-variant throw", () => {
    const device = makeDevice();
    const original = () => {
      throw new Error("socket exploded");
    };
    device.handleMeshPacket = original as MeshDevice["handleMeshPacket"];
    const logger = makeLogger();
    installUnknownVariantGuard(device, logger, "testacct");

    expect(() => device.handleMeshPacket(decodedPacket)).toThrow("socket exploded");
    expect(logger.lines).toHaveLength(0);
  });
});
