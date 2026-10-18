import { MeshDevice } from "@meshtastic/core";
import { createMeshtasticTransport } from "./device-client.js";
import type { MeshtasticTransport } from "./transport.js";

/**
 * One-shot, read-only node identity read for the onboarding wizard.
 * Connects, waits for the node's own info + LoRa config, disconnects.
 * Never sends anything beyond the standard configure handshake the
 * official apps also perform.
 */

/** meshtastic.Config.LoRaConfig.RegionCode, mirrored for display (verified against @meshtastic/core 2.6.7). */
const REGION_NAMES: Record<number, string> = {
  0: "UNSET",
  1: "US",
  2: "EU_433",
  3: "EU_868",
  4: "CN",
  5: "JP",
  6: "ANZ",
  7: "KR",
  8: "TW",
  9: "RU",
  10: "IN",
  11: "NZ_865",
  12: "TH",
  13: "LORA_24",
  14: "UA_433",
  15: "UA_868",
  16: "MY_433",
  17: "MY_919",
  18: "SG_923",
  19: "PH_433",
  20: "PH_868",
  21: "PH_915",
  22: "ANZ_433",
};

export type MeshtasticNodeIdentity = {
  nodeNum?: number;
  /** Canonical Meshtastic user id, e.g. "!a1b2c3d4". */
  nodeId?: string;
  longName?: string;
  shortName?: string;
  regionCode?: number;
  /** Display name of the LoRa region, e.g. "EU_868". "UNSET" means the node cannot transmit. */
  region?: string;
  firmwareVersion?: string;
};

export function formatMeshtasticNodeId(nodeNum: number): string {
  return `!${(nodeNum >>> 0).toString(16).padStart(8, "0")}`;
}

export async function readMeshtasticNodeIdentity(params: {
  transport: MeshtasticTransport;
  host: string;
  port: number;
  tls: boolean;
  serialPath: string;
  baudRate: number;
  timeoutMs?: number;
}): Promise<MeshtasticNodeIdentity | null> {
  const timeoutMs = params.timeoutMs ?? 12_000;
  const identity: MeshtasticNodeIdentity = {};

  const transport = await createMeshtasticTransport({
    transport: params.transport,
    host: params.host,
    port: params.port,
    tls: params.tls,
    serialPath: params.serialPath,
    baudRate: params.baudRate,
  });
  const device = new MeshDevice(transport);

  // Duck-typed subscriptions, same pattern as device-client.ts — the
  // @meshtastic/core protobuf types are not directly importable here.
  device.events.onMyNodeInfo.subscribe((info: { myNodeNum?: number }) => {
    if (typeof info.myNodeNum === "number") {
      identity.nodeNum = info.myNodeNum;
      identity.nodeId = formatMeshtasticNodeId(info.myNodeNum);
    }
  });
  // onConfigPacket dispatches the full Config message; the concrete variant
  // hangs off config.payloadVariant = { case: "lora", value: LoRaConfig }.
  device.events.onConfigPacket.subscribe(
    (config: { payloadVariant?: { case?: string; value?: { region?: number } } }) => {
      const variant = config?.payloadVariant;
      if (variant?.case === "lora" && typeof variant.value?.region === "number") {
        identity.regionCode = variant.value.region;
        identity.region = REGION_NAMES[variant.value.region] ?? `UNKNOWN(${variant.value.region})`;
      }
    },
  );
  device.events.onNodeInfoPacket.subscribe(
    (info: { num?: number; user?: { longName?: string; shortName?: string } }) => {
      if (typeof info.num === "number" && info.num === identity.nodeNum) {
        identity.longName = info.user?.longName || identity.longName;
        identity.shortName = info.user?.shortName || identity.shortName;
      }
    },
  );
  device.events.onDeviceMetadataPacket.subscribe(
    (meta: { data?: { firmwareVersion?: string } }) => {
      if (meta?.data?.firmwareVersion) {
        identity.firmwareVersion = meta.data.firmwareVersion;
      }
    },
  );

  try {
    // configure() triggers the node-info dump that feeds the events above.
    // Over HTTP it can hang on routing ACKs that never arrive — mirror the
    // device-client pattern and never let it block the read.
    void device.configure().catch(() => undefined);

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (identity.nodeNum !== undefined && identity.regionCode !== undefined) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } finally {
    // disconnect() can hang when the node already closed the socket — race it.
    await Promise.race([
      device.disconnect().catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 3_000)),
    ]);
  }

  return identity.nodeNum !== undefined || identity.regionCode !== undefined ? identity : null;
}
