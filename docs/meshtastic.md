---
summary: "Meshtastic mesh channel via official protobuf transports"
read_when:
  - You want OpenClaw on a Meshtastic LoRa mesh network
  - You are configuring HTTP, TCP, or serial access to a Meshtastic node
title: "Meshtastic"
---

**Status:** External plugin (install via `openclaw plugins install --link` or npm).

Meshtastic is a LoRa mesh networking platform. This plugin connects OpenClaw using the
official Meshtastic JavaScript stack (`@meshtastic/core` + transports), which speaks the
same **protobuf** protocol as the Python CLI and Android app — not a custom wire format.

## Install

### From git checkout (development)

```bash
git clone https://github.com/fintlp/openclaw-meshtastic.git
openclaw plugins install --link /path/to/openclaw-meshtastic
```

Add the plugin path to your config:

```json5
{
  plugins: {
    allow: ["meshtastic"],
    load: {
      paths: ["/path/to/openclaw-meshtastic"],
    },
    entries: {
      meshtastic: { enabled: true },
    },
  },
}
```

### From npm (when published)

```bash
openclaw plugins install openclaw-meshtastic
```

Restart the Gateway after installing or enabling plugins.

## GPL dependency note

This plugin depends on `@meshtastic/core` and official transport packages, which are
**GPL-3.0-only**. The plugin package isolates that dependency; review GPL obligations
before redistribution.

## Privacy and logging

Meshtastic DMs and channel traffic may contain sensitive information. The plugin writes
inbound **info** logs without message text by default (sender, target, message id, length).

Enable plaintext excerpts only when you need short-lived debugging and trust log access:

```json5
{
  channels: {
    meshtastic: {
      logInboundMessageContent: true,
    },
  },
}
```

## Transport modes

| `transport` | Package | Typical use |
| ----------- | ------- | ----------- |
| `tcp` (default) | `@meshtastic/transport-node` | Native protobuf TCP on port **4403** (firmware Wi‑Fi, or [go-meshtastic-serial2tcp](https://github.com/skrashevich/go-meshtastic-serial2tcp)) |
| `http` | `@meshtastic/transport-http` | Node firmware HTTP API on port **4433** |
| `serial` | `@meshtastic/transport-node-serial` | USB serial on the Gateway host (`/dev/ttyUSB0`, etc.) |

All modes use `@meshtastic/core` `MeshDevice` with the shared Meshtastic protobuf definitions.

### HTTP (`transport: "http"`)

Enable the HTTP API on your Meshtastic node (default port **4433**). Packets arrive pre-decrypted.

```json5
{
  channels: {
    meshtastic: {
      enabled: true,
      transport: "http",
      host: "192.168.1.10",
      port: 4433,
      tls: false,
    },
  },
}
```

### TCP (`transport: "tcp"`)

Use when the radio exposes Meshtastic's **native TCP protobuf** endpoint (port **4403**),
including bridges such as [go-meshtastic-serial2tcp](https://github.com/skrashevich/go-meshtastic-serial2tcp)
that forward a USB serial device to TCP.

Packets arrive encrypted; the plugin decrypts them client-side (see [Encryption](#encryption-tcp--serial)).

```json5
{
  channels: {
    meshtastic: {
      enabled: true,
      transport: "tcp",
      host: "192.168.1.20",
      port: 4403,
    },
  },
}
```

### Serial (`transport: "serial"`)

Connect the Gateway machine directly to the radio over USB serial.
Packets arrive encrypted; the plugin decrypts them client-side.

```json5
{
  channels: {
    meshtastic: {
      enabled: true,
      transport: "serial",
      serialPath: "/dev/ttyUSB0",
      baudRate: 115200,
    },
  },
}
```

## Encryption (TCP / serial)

The HTTP transport decrypts packets server-side on the Meshtastic node. TCP and serial
transports receive **encrypted** payloads (`payloadVariant.case === "encrypted"`) that
`@meshtastic/core` does not decrypt natively.

This plugin handles client-side decryption automatically for non-HTTP transports:

1. **PSK collection** — on connect, the plugin subscribes to `onChannelPacket` events and
   collects per-channel pre-shared keys from the device's channel settings. Single-byte PSK
   `0x01` maps to the standard Meshtastic default key; 16-byte and 32-byte PSKs are used as-is.
2. **Decryption** — when an encrypted `MeshPacket` arrives, the plugin decrypts the payload
   with AES-CTR (AES-128-CTR for 16-byte PSK, AES-256-CTR for 32-byte PSK) using the nonce
   layout from the Meshtastic protocol spec (`packetId` + `fromNode` + `channelIndex`, LE).
3. **Dispatch** — the decrypted payload is fed through the normal inbound message pipeline:
   DM policy, group policy, allowlist checks, and agent delivery all work identically to HTTP.

No extra configuration is needed; decryption is transparent once the channel PSKs are
received from the device.

## Environment variables (default account)

| Variable | Description |
| -------- | ----------- |
| `MESHTASTIC_TRANSPORT` | `http`, `tcp`, or `serial` |
| `MESHTASTIC_HOST` | Host for http/tcp (`host:port` suffix allowed) |
| `MESHTASTIC_PORT` | Override port |
| `MESHTASTIC_TLS` | `true` for HTTPS (http only) |
| `MESHTASTIC_SERIAL` | Serial device path (`transport=serial`) |

## Multi-agent setup

You can route Meshtastic messages to a dedicated agent with a different model, workspace,
or personality. This is useful for running a lightweight or task-specific agent on mesh
traffic while keeping the primary agent on Telegram/Discord/etc.

```json5
{
  agents: {
    list: [
      { id: "main", workspace: "~/.openclaw/workspace" },
      {
        id: "meshtastic",
        workspace: "~/.openclaw/workspace-meshtastic",
        model: { primary: "openrouter/deepseek/deepseek-v4-flash" },
        tools: { profile: "messaging" },
      },
    ],
  },
  bindings: [
    { agentId: "main", match: { channel: "telegram", accountId: "default" } },
    { agentId: "meshtastic", match: { channel: "meshtastic", accountId: "default" } },
  ],
}
```

Without a binding, Meshtastic traffic is handled by the default agent.

## Target grammar

| Target               | Send behavior               | Chat type |
| -------------------- | --------------------------- | --------- |
| `!12345678`          | DM to node id               | direct    |
| `node:305419896`     | DM by decimal node number   | direct    |
| `channel:0` / `ch:0` | Broadcast on mesh channel 0 | group     |
| `broadcast`          | Alias for primary channel   | group     |

OpenClaw `to` values and session ids use the same grammar with an optional `meshtastic:` prefix.

## Access control

### DM policies

- **pairing** (default): unknown senders receive a pairing code
- **allowlist**: only node ids in `allowFrom` can DM the bot
- **open**: any sender can DM (requires `allowFrom: ["*"]`)
- **disabled**: DMs are dropped

Allowlist entries accept `!hex` node ids or decimal `node:` / numeric forms.

### Group / broadcast policy

- **allowlist** (default): only keys in `groups` receive inbound broadcast traffic
- **open**: all configured mesh channels are accepted (mention rules may still apply)
- **disabled**: broadcast messages are dropped

Example group config:

```json5
{
  channels: {
    meshtastic: {
      groupPolicy: "allowlist",
      channels: [3],
      groups: {
        "channel:3": { requireMention: false },
      },
      allowFrom: ["!aabbccdd"],
      groupAllowFrom: ["!aabbccdd"],
    },
  },
}
```

## Reply-to

Inbound mesh text messages expose `packet.id`. Outbound replies can pass `replyId` to
`sendText` so clients show threaded replies when supported.

## Outbound chunking

Meshtastic mesh text has a practical size limit (~200 characters). OpenClaw splits long
agent replies into chunks (`textChunkLimit`, default 200). Chunk mode can be `length`
(default) or `newline` (split on paragraph boundaries).

## Probe and status

`openclaw channels status --probe` checks reachability for the configured transport:

- **http**: `/api/v1/toradio` OPTIONS + short `@meshtastic/transport-http` connect
- **tcp**: `@meshtastic/transport-node` connect to `host:4403`
- **serial**: `@meshtastic/transport-node-serial` open on `serialPath`

## Troubleshooting

### Probe fails / no inbound messages

1. Confirm `transport` matches how the device is exposed (HTTP vs TCP vs serial).
2. For **tcp**, verify port **4403** and that a serial2tcp bridge is running if used.
3. For **http**, confirm the node HTTP API is enabled and `tls` matches the node.
4. For **serial**, check device permissions and the correct `/dev/*` path.

### Encrypted packets not decrypting (TCP / serial)

If you see log lines like `no PSK for channel X` or `decrypt failed for packet Y`:

1. The plugin needs to receive channel settings from the device first. Allow a few seconds
   after connect for PSK collection.
2. Verify the channel PSK is configured on the Meshtastic device (non-empty, not a custom
   single-byte index other than `0x01`).
3. The default channel key (`AQ==` / `0x01`) is supported out of the box.

### HTTP vs TCP

- **HTTP** (`4433`): request/response API wrapping protobuf (`/api/v1/fromradio`, `/api/v1/toradio`). Packets arrive decrypted.
- **TCP** (`4403`): continuous protobuf stream — same as Meshtastic Python `TCPInterface`. Packets arrive encrypted; this plugin decrypts them.

This plugin supports both via official transports; you are not limited to a single HTTP wrapper.

## Configuration reference

| Key              | Type     | Default       | Description                            |
| ---------------- | -------- | ------------- | -------------------------------------- |
| `transport`      | string   | `"tcp"`       | `http`, `tcp`, or `serial`             |
| `host`           | string   | required*     | Host for http/tcp                      |
| `port`           | number   | transport dep.| 4433 (http) or 4403 (tcp)              |
| `tls`            | boolean  | `false`       | HTTPS for `transport=http` only        |
| `serialPath`     | string   | required*     | Device path for `transport=serial`     |
| `baudRate`       | number   | `115200`      | Serial baud rate (9600–921600)         |
| `enabled`        | boolean  | `true`        | Enable channel                         |
| `channels`       | number[] | `[0]`         | Mesh channel indices to listen (0-7)   |
| `dmPolicy`       | string   | `"pairing"`   | DM access policy                       |
| `allowFrom`      | array    | `[]`          | Allowed DM senders                     |
| `defaultTo`      | string   | —             | Default outbound target                |
| `groupPolicy`    | string   | `"allowlist"` | Broadcast access policy                |
| `groupAllowFrom` | array    | `[]`          | Allowed broadcast senders              |
| `groups`         | object   | `{}`          | Per-channel policy (`channel:0`, etc.) |
| `mentionPatterns`| array    | `[]`          | Regex patterns for mention detection   |
| `markdown`       | object   | —             | Markdown rendering options             |
| `historyLimit`   | integer  | —             | Group history limit                    |
| `dmHistoryLimit` | integer  | —             | DM history limit                       |
| `contextVisibility` | string | `"all"`      | `all`, `allowlist`, or `allowlist_quote` |
| `textChunkLimit` | number   | `200`         | Outbound chunk size                    |
| `chunkMode`      | string   | `"length"`    | `length` or `newline`                  |
| `blockStreaming` | boolean  | —             | Enable streaming block output          |
| `blockStreamingCoalesce` | object | —     | Streaming coalesce settings            |
| `responsePrefix` | string   | —             | Prefix for outbound messages           |
| `mediaMaxMb`     | number   | —             | Max media size in MB                   |
| `accounts`       | object   | —             | Multi-account configuration            |
| `defaultAccount` | string   | —             | Default account name                   |

\* `host` for http/tcp; `serialPath` for serial.

Multi-account scaffolding uses `channels.meshtastic.accounts` like other channels.
