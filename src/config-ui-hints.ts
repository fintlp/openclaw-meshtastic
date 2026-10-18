import type { ChannelConfigUiHint } from "openclaw/plugin-sdk/core";

export const meshtasticChannelConfigUiHints = {
  "": {
    label: "Meshtastic",
    help: "Meshtastic mesh channel via official protobuf transports: HTTP API (4433), native TCP (4403, e.g. go-meshtastic-serial2tcp), or USB serial.",
  },
  transport: {
    label: "Meshtastic Transport",
    help: 'Connection mode: "http" (node HTTP API), "tcp" (protobuf stream, port 4403), or "serial" (local USB).',
  },
  host: {
    label: "Meshtastic Host",
    help: "Hostname or IP for http/tcp. Optional port suffix (host:4433 or host:4403) is supported.",
  },
  port: {
    label: "Meshtastic Port",
    help: "Port for the selected transport (default 4433 for http, 4403 for tcp). Ignored when host includes a port.",
  },
  tls: {
    label: "Meshtastic TLS",
    help: "Use HTTPS for transport=http only (default false).",
  },
  serialPath: {
    label: "Meshtastic Serial Path",
    help: 'Device path for transport=serial (e.g. /dev/ttyUSB0 or /dev/cu.usbserial-0001).',
  },
  baudRate: {
    label: "Meshtastic Baud Rate",
    help: "Serial baud rate for transport=serial (default 115200).",
  },
  channels: {
    label: "Meshtastic Mesh Channels",
    help: "Mesh channel indices (0-7) to listen for broadcast messages.",
  },
  dmPolicy: {
    label: "Meshtastic DM Policy",
    help: 'Direct message access control ("pairing" recommended). "open" requires channels.meshtastic.allowFrom=["*"].',
  },
  groupPolicy: {
    label: "Meshtastic Group Policy",
    help: 'Broadcast channel access control. "allowlist" requires channels.meshtastic.groups keys such as "channel:0".',
  },
  groupTransmit: {
    label: "Meshtastic Group Transmit",
    help: "Default false: the send path refuses every channel/broadcast message (LoRa airtime rule). Set true to opt in to group transmission.",
  },
  textChunkLimit: {
    label: "Meshtastic Text Chunk Limit",
    help: "Maximum characters per outbound mesh text message (default ~200). Long replies are split into chunks.",
  },
  logInboundMessageContent: {
    label: "Log Inbound Message Content",
    help: "When true, Gateway logs include up to 80 characters of inbound mesh text. Default is false (metadata only: sender, target, message id, length).",
  },
} satisfies Record<string, ChannelConfigUiHint>;
