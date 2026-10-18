import { MeshDevice, Types } from "@meshtastic/core";
import { TransportHTTP } from "@meshtastic/transport-http";
import type { MeshtasticTransport } from "./transport.js";

export type MeshtasticDeviceHandle = {
  accountId: string;
  device: MeshDevice;
  myNodeNum: number | null;
  configure: () => Promise<void>;
};

const devices = new Map<string, MeshtasticDeviceHandle>();

type MeshtasticHttpTransportInternals = {
  url: string;
  receiveBatchRequests?: boolean;
  inflightReadController?: AbortController;
  fromDeviceController?: {
    enqueue: (output: { type: "packet"; data: Uint8Array }) => void;
  };
  emitStatus?: (next: Types.DeviceStatusEnum, reason?: string) => void;
};

export function buildMeshtasticTransportAddress(host: string, port: number): string {
  return `${host}:${port}`;
}

function toMeshtasticHttpTransportInternals(
  transport: Awaited<ReturnType<typeof TransportHTTP.create>>,
): MeshtasticHttpTransportInternals & { readFromRadio?: () => Promise<void> } {
  return transport as unknown as MeshtasticHttpTransportInternals & {
    readFromRadio?: () => Promise<void>;
  };
}

function installHttpTransportBackpressure(
  transport: Awaited<ReturnType<typeof TransportHTTP.create>>,
): void {
  const http = toMeshtasticHttpTransportInternals(transport);
  if (!http.url || typeof http.readFromRadio !== "function") {
    return;
  }

  http.receiveBatchRequests = true;
  http.inflightReadController?.abort();
  http.readFromRadio = async () => {
    const inflight = new AbortController();
    http.inflightReadController = inflight;
    const signal = AbortSignal.any([inflight.signal, AbortSignal.timeout(7_000)]);
    try {
      const response = await fetch(`${http.url}/api/v1/fromradio?all=true`, {
        method: "GET",
        headers: { Accept: "application/x-protobuf" },
        signal,
      });
      if (!response.ok) {
        throw new Error(`fromradio ${response.status} ${response.statusText}`);
      }
      http.emitStatus?.(Types.DeviceStatusEnum.DeviceConnected);
      const readBuffer = await response.arrayBuffer();
      if (readBuffer.byteLength > 0) {
        http.fromDeviceController?.enqueue({
          type: "packet",
          data: new Uint8Array(readBuffer),
        });
      }
    } finally {
      http.inflightReadController = undefined;
    }
  };
}

export async function createMeshtasticTransport(params: {
  transport: MeshtasticTransport;
  host: string;
  port: number;
  tls: boolean;
  serialPath: string;
  baudRate: number;
}): Promise<Types.Transport> {
  switch (params.transport) {
    case "tcp": {
      const { TransportNode } = await import("@meshtastic/transport-node");
      return await TransportNode.create(params.host, params.port);
    }
    case "serial": {
      if (!params.serialPath) {
        throw new Error("Meshtastic serial transport requires serialPath");
      }
      const { TransportNodeSerial } = await import("@meshtastic/transport-node-serial");
      return await TransportNodeSerial.create(params.serialPath, params.baudRate);
    }
    default: {
      const address = buildMeshtasticTransportAddress(params.host, params.port);
      const httpTransport = await TransportHTTP.create(address, params.tls);
      installHttpTransportBackpressure(httpTransport);
      return httpTransport;
    }
  }
}

export async function connectMeshtasticDevice(params: {
  accountId: string;
  transport: MeshtasticTransport;
  host: string;
  port: number;
  tls: boolean;
  serialPath: string;
  baudRate: number;
  autoConfigure?: boolean;
}): Promise<MeshtasticDeviceHandle> {
  const existing = devices.get(params.accountId);
  if (existing) {
    await disconnectMeshtasticDevice(params.accountId);
  }

  const transport = await createMeshtasticTransport(params);
  const device = new MeshDevice(transport);
  const handle: MeshtasticDeviceHandle = {
    accountId: params.accountId,
    device,
    myNodeNum: null,
    configure: async () => {
      if (params.transport === "http") {
        // HTTP transport starts receiving immediately; configure() waits up to ~60s for
        // routing ACKs that often never arrive over HTTP, which blocks inbound subscribe.
        void device.configure().catch(() => undefined);
      } else {
        await device.configure();
      }
      device.setHeartbeatInterval(30_000);
    },
  };

  device.events.onMyNodeInfo.subscribe((info: { myNodeNum?: number }) => {
    if (typeof info.myNodeNum === "number") {
      handle.myNodeNum = info.myNodeNum;
    }
  });

  devices.set(params.accountId, handle);

  if (params.autoConfigure !== false) {
    await handle.configure();
  }

  return handle;
}

const DISCONNECT_TIMEOUT_MS = 5_000;

export async function disconnectMeshtasticDevice(accountId: string): Promise<void> {
  const handle = devices.get(accountId);
  if (!handle) {
    return;
  }
  // Remove from map immediately so reconnect attempts don't deadlock on
  // the stale handle.
  devices.delete(accountId);
  try {
    await Promise.race([
      handle.device.disconnect(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`disconnect timeout (${DISCONNECT_TIMEOUT_MS}ms)`)),
          DISCONNECT_TIMEOUT_MS,
        ),
      ),
    ]);
  } catch (error) {
    // Swallow all errors – the handle is already removed from the map and
    // the underlying socket is almost certainly dead at this point.
    // Previously only "Invalid state" was caught, but timeout and stream
    // errors on already-destroyed sockets are equally benign.
    if (!(error instanceof Error) || !error.message.includes("Invalid state")) {
      // Non-fatal: device already gone from map.
    }
  }
}

export function getMeshtasticDevice(accountId: string): MeshtasticDeviceHandle | undefined {
  return devices.get(accountId);
}

/** Meshtastic channel indices for sendText — @meshtastic/core v2.6+ no longer exports ChannelNumber. */
export const MeshtasticChannel = {
  Primary: 0,
  Channel1: 1,
  Channel2: 2,
  Channel3: 3,
  Channel4: 4,
  Channel5: 5,
  Channel6: 6,
  Admin: 7,
} as const;

export type MeshtasticChannelIndex = (typeof MeshtasticChannel)[keyof typeof MeshtasticChannel];

export function resolveChannelNumber(channelIndex: number): MeshtasticChannelIndex {
  if (channelIndex >= 0 && channelIndex <= 7) {
    return channelIndex as MeshtasticChannelIndex;
  }
  return MeshtasticChannel.Primary;
}
