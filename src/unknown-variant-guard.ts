import type { MeshDevice } from "@meshtastic/core";

type DebugLogger = {
  debug?: (line: string) => void;
};

type HandleMeshPacket = MeshDevice["handleMeshPacket"];
type MeshPacketParam = Parameters<HandleMeshPacket>[0];

const UNHANDLED_VARIANT_RE = /^Unhandled case /;

/**
 * Extract the Data portnum from a decoded mesh packet, when present.
 * Returns undefined for encrypted packets and malformed shapes.
 */
function extractPortnum(meshPacket: MeshPacketParam): number | undefined {
  const variant = (meshPacket as { payloadVariant?: { case?: string; value?: unknown } })
    ?.payloadVariant;
  if (variant?.case !== "decoded") {
    return undefined;
  }
  const portnum = (variant.value as { portnum?: unknown } | undefined)?.portnum;
  return typeof portnum === "number" ? portnum : undefined;
}

/**
 * Downgrade @meshtastic/core 2.6.7's unknown-packet throw to a DEBUG line
 * (issue #25).
 *
 * MeshDevice.handleDecodedPacket throws `Unhandled case <portnum>` on any
 * portnum missing from its dispatch switch (and handleMeshPacket does the
 * same for an unrecognized payloadVariant). Portnum 36 — NODE_STATUS_APP,
 * added to the upstream meshtastic protobufs after the 2.6.7 enum was
 * generated and broadcast by firmware 2.7.x nodes — hits that default. The
 * library's decodePacket stream sink catches the throw but re-logs it as an
 * ERROR ("Unable to handle mesh packet") through the stream path on every
 * such packet, even though the packet is simply airtime this client cannot
 * use.
 *
 * The guard wraps the device instance's handleMeshPacket at the plugin
 * boundary: the known unknown-variant throw is logged at DEBUG (with the
 * portnum where extractable) and swallowed; every other error propagates
 * unchanged so real failures still surface. onMeshPacket has already been
 * dispatched before the library throws, so the plugin's receive pipeline
 * is unaffected.
 */
export function installUnknownVariantGuard(
  device: MeshDevice,
  logger: DebugLogger,
  accountId: string,
): void {
  // Test doubles and partial device shapes may not carry the method; there
  // is nothing to guard in that case.
  if (typeof device.handleMeshPacket !== "function") {
    return;
  }
  const original: HandleMeshPacket = device.handleMeshPacket.bind(device);
  device.handleMeshPacket = (meshPacket: MeshPacketParam): void => {
    try {
      original(meshPacket);
    } catch (err) {
      if (err instanceof Error && UNHANDLED_VARIANT_RE.test(err.message)) {
        const portnum = extractPortnum(meshPacket);
        const id = (meshPacket as { id?: unknown })?.id;
        logger.debug?.(
          `[${accountId}] skipping unsupported mesh packet` +
            ` id=${typeof id === "number" ? id : "unknown"}` +
            ` (${err.message}${portnum !== undefined ? `, portnum ${portnum}` : ""})`,
        );
        return;
      }
      throw err;
    }
  };
}
