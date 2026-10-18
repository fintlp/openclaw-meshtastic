export const MESHTASTIC_TRANSPORTS = ["http", "tcp", "serial"] as const;

export type MeshtasticTransport = (typeof MESHTASTIC_TRANSPORTS)[number];

export const DEFAULT_HTTP_PORT = 4433;
export const DEFAULT_TCP_PORT = 4403;
export const DEFAULT_SERIAL_BAUD = 115_200;

export function normalizeMeshtasticTransport(raw?: string): MeshtasticTransport {
  const value = raw?.trim().toLowerCase();
  if (value === "http" || value === "tcp" || value === "serial") {
    return value;
  }
  return "tcp";
}

export function defaultPortForTransport(transport: MeshtasticTransport): number {
  return transport === "tcp" ? DEFAULT_TCP_PORT : DEFAULT_HTTP_PORT;
}

export function formatMeshtasticEndpoint(params: {
  transport: MeshtasticTransport;
  host: string;
  port: number;
  tls: boolean;
  serialPath?: string;
}): string {
  if (params.transport === "serial") {
    return params.serialPath ?? "";
  }
  if (params.transport === "tcp") {
    return `${params.host}:${params.port}`;
  }
  return `${params.tls ? "https" : "http"}://${params.host}:${params.port}`;
}
