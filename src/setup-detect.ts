import { readdir } from "node:fs/promises";
import { DEFAULT_HTTP_PORT, DEFAULT_TCP_PORT, type MeshtasticTransport } from "./transport.js";

/**
 * Onboarding helpers: endpoint auto-detection, host:port parsing, and
 * human-actionable probe failure diagnosis. Everything here is pure or
 * read-only — nothing transmits, nothing writes config.
 */

const SERIAL_PORT_PATTERNS = [
  // macOS
  /^cu\.usbserial/i,
  /^cu\.usbmodem/i,
  /^cu\.SLAB_USBtoUART/i,
  /^cu\.wchusbserial/i,
  // Linux
  /^ttyUSB\d+$/,
  /^ttyACM\d+$/,
];

/** Best-effort listing of likely USB-serial device paths. Returns [] on any error. */
export async function listSerialPorts(): Promise<string[]> {
  try {
    const entries = await readdir("/dev");
    return entries
      .filter((entry) => SERIAL_PORT_PATTERNS.some((pattern) => pattern.test(entry)))
      .sort()
      .map((entry) => `/dev/${entry}`);
  } catch {
    return [];
  }
}

/**
 * Split "host:port" input. Only splits on the LAST colon and only when the
 * suffix is a valid port number — otherwise the whole string is the host.
 */
export function splitHostPort(raw: string): { host: string; port?: number } {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { host: "" };
  }
  const colonIndex = trimmed.lastIndexOf(":");
  if (colonIndex > 0 && colonIndex < trimmed.length - 1) {
    const hostPart = trimmed.slice(0, colonIndex).trim();
    const portPart = trimmed.slice(colonIndex + 1).trim();
    const port = Number.parseInt(portPart, 10);
    if (hostPart && /^\d+$/.test(portPart) && Number.isFinite(port) && port >= 1 && port <= 65535) {
      return { host: hostPart, port };
    }
  }
  return { host: trimmed };
}

export type ProbeDiagnosis = {
  /** One-line summary of what is most likely wrong. */
  summary: string;
  /** Concrete things to check or change, most likely first. */
  hints: string[];
  /** When the evidence points at a wrong transport/port combination. */
  suggestTransport?: MeshtasticTransport;
  suggestPort?: number;
};

/**
 * Translate a probe failure into operator-actionable guidance. The two
 * classic traps get dedicated handling: 4403-vs-4433 (TCP stream vs HTTP
 * API) and serial ports owned by another process.
 */
export function diagnoseProbeFailure(params: {
  transport: MeshtasticTransport;
  host: string;
  port: number;
  serialPath?: string;
  error?: string;
}): ProbeDiagnosis {
  const error = params.error ?? "";
  const target =
    params.transport === "serial"
      ? (params.serialPath ?? "(no serial path)")
      : `${params.host}:${params.port}`;

  if (/404\/405/.test(error)) {
    return {
      summary: `${target} speaks TCP protobuf, not HTTP — this is the classic 4403 ≠ 4433 trap.`,
      hints: [
        "Switch the transport to TCP (the node's native protobuf stream, port 4403).",
        "Or keep HTTP and point it at the node's web API port (default 4433) — it must be enabled in the node's network settings first.",
      ],
      suggestTransport: "tcp",
      suggestPort: DEFAULT_TCP_PORT,
    };
  }

  if (/ECONNREFUSED/i.test(error)) {
    return {
      summary: `Nothing is listening on ${target}.`,
      hints: [
        "Check the node is powered and on the same network (its IP is shown in the Meshtastic app).",
        params.transport === "tcp"
          ? "The TCP server (port 4403) is on by default in current firmware — verify it wasn't disabled in the node's network settings."
          : "The HTTP API (port 4433) is OFF by default — enable it in the node's network settings, or use TCP/4403 instead.",
        "Double-check the IP: DHCP leases change. Consider a reservation for the node.",
      ],
    };
  }

  if (/timed?\s*out|abort/i.test(error)) {
    return {
      summary: `${target} did not answer in time.`,
      hints: [
        "If the node sits on an IoT/guest VLAN, client isolation may be blocking you — test from the same VLAN.",
        "Check firewalls between the gateway and the node.",
        "Confirm the IP is reachable at all (ping it).",
      ],
    };
  }

  if (/ENOENT|no such file/i.test(error) && params.transport === "serial") {
    return {
      summary: `Serial device ${target} does not exist.`,
      hints: [
        "Use a USB data cable — charge-only cables connect power but not data (the #1 serial trap).",
        "Unplug and replug the node, then check the port list again.",
        "On Linux, CP210x/CH340 drivers create /dev/ttyUSB*; on macOS look for /dev/cu.usbserial-*.",
      ],
    };
  }

  if (/EBUSY|Resource temporarily unavailable|Permission denied|EACCES|cannot open/i.test(error)) {
    return {
      summary: `Serial port ${target} is busy or not accessible.`,
      hints: [
        "Only one process can own a serial port — stop any other Meshtastic app, serial2tcp bridge, or `meshtastic` CLI first.",
        "On Linux, add your user to the dialout group for permission errors.",
      ],
    };
  }

  if (/certificate|ssl|wrong version number/i.test(error)) {
    return {
      summary: `TLS handshake failed against ${target}.`,
      hints: [
        "The node's HTTP API speaks plain HTTP by default — disable HTTPS, or terminate TLS in front of it.",
      ],
      suggestPort: DEFAULT_HTTP_PORT,
    };
  }

  return {
    summary: `Could not reach the node at ${target}${error ? `: ${error}` : "."}`,
    hints: [
      "Verify the node is reachable from this machine (same network, correct IP/port).",
      "When in doubt: transport TCP, port 4403 — that is the node's native protocol and needs nothing enabled.",
    ],
  };
}
