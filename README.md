# openclaw-meshtastic

**An AI agent on your Meshtastic mesh.** This plugin connects your [OpenClaw](https://docs.openclaw.ai) gateway to a Meshtastic node over the **official protobuf stack** and puts your agent on the radio: reachable by direct message from any node in range, fully local — no MQTT, no cloud, no internet anywhere in the loop.

> **Maintained line:** this is the actively maintained fork (`fintlp/openclaw-meshtastic`). Upstream (`skrashevich/openclaw-meshtastic`) has been dormant since May 2026. Fixes are offered upstream as PRs; releases ship here. See the compatibility & maintenance policy below.

## What you can do with it

- **Off-grid messaging assistant.** Your agent — the same one that knows your notes, your calendar, your home automation — answering DMs from a €25 LoRa handheld with zero internet in the path. Mesh in, answers out.
- **Emergency / backup channel.** When the internet dies, the mesh doesn't. A node on your LAN keeps your agent reachable when everything else is dark.
- **Unattended-site monitor.** Put a node somewhere remote — attic, shed, mountain hut with a solar panel — and ask it how it's doing. Meshtastic's telemetry (battery, voltage, channel utilization) rides the same mesh as the chat.
- **Field-expedition comms hub.** A gateway at base camp, handhelds in the field. Everyone DMs the hub; the hub answers — weather, schedules, "where is everybody."
- **Mesh-community bot.** A pairing-gated assistant on your local mesh. New contacts get a pairing challenge, you approve the ones you know, and the defaults keep it from ever becoming airtime spam.

Meshtastic is the largest LoRa mesh ecosystem there is — cheap hardware, phone apps for every platform, an enormous community. This plugin deliberately talks to your node the way the official apps do (protobuf over TCP/HTTP/serial), not through MQTT or any broker. Your messages never leave your LAN except over the radio itself.

## From a node on your LAN to your first DM in ~15 minutes

1. **Get a node on your network.** Any Meshtastic device with WiFi (a Heltec V3, a T-Beam, a LilyGo) running current firmware. No WiFi on the board? A USB-serial node works too, directly or through a [serial2tcp bridge](https://github.com/skrashevich/go-meshtastic-serial2tcp).
2. **Install the plugin** and point it at the node — TCP port 4403 is the default and the right choice for most setups (see the gotcha below).
3. **Send yourself a DM** from a second device — a handheld, or the phone app paired to another node. Watch your agent answer. Over LoRa.

Two gotchas cost real evenings, so they live at the top:

- **4403 ≠ 4433.** TCP (protobuf stream) is port **4403**; HTTP (the node's web API) is port **4433** — and the HTTP API must be explicitly enabled in the node's network settings. Picking "http" and pointing at 4403 (or vice versa) fails in ways that look like everything *except* a wrong port. When in doubt: `transport: "tcp"`, port 4403.
- **TCP payloads arrive encrypted** and `@meshtastic/core` does not decrypt them. This plugin does — automatically, per-channel PSKs, no configuration. It just works, but only *because* the plugin handles it; a raw TCP client will show you ciphertext and confusion.

Five minutes of [docs/meshtastic.md](docs/meshtastic.md) saves the evening.

## What it does, in one breath

- **Direct messages (DMs):** full two-way chat, with pairing/allowlist/open access control.
- **Mesh broadcast channels:** per-channel group policy (allowlist by default) — the agent *can* reply on a channel when you deliberately configure it to. More on that choice below.
- **Three official transports:** TCP (4403, default), HTTP (node API), USB serial.
- **Client-side AES-CTR decryption** for TCP/serial — encrypted mesh traffic works out of the box.
- **Reply-to threading, outbound chunking, multi-account, multi-agent binding.**

## Safety by default: an agent with a transmitter

Connecting an AI agent to a LoRa mesh is different from connecting it to a chat app. There is no network perimeter on the radio: anyone with an inexpensive board can DM your node. And everything transmitted on a channel is heard by every node in range — there is no edit button and no delete button on the airwaves.

The defaults here are cautious: **`dmPolicy: "pairing"`** (every new contact needs your explicit approval) and **`groupPolicy: "allowlist"`** (only senders you list can trigger anything from a channel). Unlike its MeshCore sibling plugin — which is receive-only on groups *in code* — this plugin **can** transmit to a channel when your configuration allows a group reply through. That is a deliberate feature (Meshtastic channels are how fleets coordinate), and it comes with a standing request: LoRa airtime is a shared commons. An agent that chats on a public channel degrades the mesh for everyone in range. Keep group replies off unless you have a reason, and give your agent a standing instruction to never speak on mesh channels unprompted.

If your node advertises a GPS position, that position is broadcast to every node in range — publish one you are comfortable sharing with strangers.

## Privacy and logging

Inbound mesh traffic can include personal or operational content. By default this plugin logs **metadata only** (account, DM vs group, sender id, target, message id, text length) — not message bodies.

To include up to 80 characters of inbound text in Gateway logs (debugging only), set:

```json5
{
  channels: {
    meshtastic: {
      logInboundMessageContent: true,
    },
  },
}
```

Review who can read Gateway logs and how long they are retained before enabling this. OpenClaw verbose logging (`shouldLogVerbose`) does not change this behavior.

## Install

From ClawHub (recommended):

```bash
openclaw plugins install clawhub:@fintlp/openclaw-meshtastic
```

Then point it at your node (TCP is the default transport):

```bash
openclaw channels add meshtastic --host <node-ip>
```

Restart the Gateway after installing or enabling the plugin. Prefer a
config file? See the quick setup below. From a git checkout (development):

```bash
git clone https://github.com/fintlp/openclaw-meshtastic.git
openclaw plugins install --link /path/to/openclaw-meshtastic
```

## Quick setup

### 1. Enable the plugin

```json5
{
  plugins: {
    allow: ["meshtastic"],
    entries: {
      meshtastic: { enabled: true },
    },
  },
}
```

For local development, add the plugin path:

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

### 2. Configure the channel

#### TCP (protobuf stream — recommended)

```json5
{
  channels: {
    meshtastic: {
      enabled: true,
      transport: "tcp",
      host: "192.168.1.10",
      port: 4403,
      dmPolicy: "pairing",
      groupPolicy: "allowlist",
      channels: [0],
      groups: {
        "channel:0": { requireMention: false },
      },
    },
  },
}
```

#### HTTP (node API — remember to enable the API on the node)

```json5
{
  channels: {
    meshtastic: {
      enabled: true,
      transport: "http",
      host: "192.168.1.10",
      port: 4433,
      dmPolicy: "pairing",
      groupPolicy: "allowlist",
      channels: [0],
      groups: {
        "channel:0": { requireMention: false },
      },
    },
  },
}
```

#### Serial (USB)

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

### 3. Optional: dedicate an agent to mesh traffic

To route Meshtastic messages to a separate agent (different model, workspace, or personality):

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

Without a binding, Meshtastic traffic goes to the default agent.

### 4. Environment variables (default account)

- `MESHTASTIC_TRANSPORT` — `http`, `tcp`, or `serial`
- `MESHTASTIC_HOST` — host for http/tcp (`host:port` allowed)
- `MESHTASTIC_PORT` — override port
- `MESHTASTIC_TLS` — `true` for HTTPS (http only)
- `MESHTASTIC_SERIAL` — serial device path

See [docs/meshtastic.md](./docs/meshtastic.md) for the full configuration reference.

## Encryption (TCP / serial)

The HTTP transport decrypts packets server-side on the Meshtastic node. TCP and serial transports receive **encrypted** payloads (`payloadVariant.case === "encrypted"`) that `@meshtastic/core` does not decrypt natively.

This plugin handles client-side decryption automatically for non-HTTP transports:

1. On connect, the plugin collects per-channel PSKs from the device's channel settings via `onChannelPacket`.
2. When an encrypted `MeshPacket` arrives, it is decrypted with AES-CTR (128 or 256 bit, depending on PSK length) using the nonce layout from the Meshtastic protocol spec.
3. The decrypted payload is dispatched through the normal inbound message pipeline — DM policy, group policy, allowlist checks, and agent delivery all work as with HTTP.

No extra configuration is needed; decryption is transparent.

## Documentation

- [docs/meshtastic.md](docs/meshtastic.md) — full configuration reference.
- [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) — verified host/plugin/transport matrix, known interop quirks.
- [docs/PUBLISHING.md](docs/PUBLISHING.md) — the ClawHub release run-book.
- [CHANGELOG.md](CHANGELOG.md) — release history, mechanism-level entries.
- [Issues](https://github.com/fintlp/openclaw-meshtastic/issues) — roadmap and known state live here.

**Sibling:** running MeshCore hardware instead of Meshtastic? Same agent, other mesh — [openclaw-meshcore](https://github.com/fintlp/openclaw-meshcore) (`openclaw plugins install clawhub:@fintlp/openclaw-meshcore`).

## Compatibility & maintenance policy

OpenClaw core ships often, and its plugin SDK evolves with it. This plugin is maintained against that reality under an explicit policy, so you can rely on it long-term:

- **Tracked surface.** The plugin builds exclusively against the public `openclaw/plugin-sdk/*` subpath exports — no deep imports into OpenClaw internals. The exact set is auditable at any time:
  ```bash
  grep -rhoE "openclaw/plugin-sdk[a-z/-]*" src/ *.ts | sort -u
  ```
  Today it spans ~31 subpaths covering the channel lifecycle (inbound, outbound, pairing, setup, status), account & config contracts, routing, and runtime helpers.
- **Deprecation & removal response.** When OpenClaw retires an SDK surface we use, we migrate off it and record the migration in the [changelog](CHANGELOG.md). Precedent: OpenClaw 2026.10.1 removed the `channel-lifecycle` / `channel-message` / `outbound-runtime` compat aliases — the plugin migrated to `channel-outbound` in **v2026.10.11**, the same day the breakage class was identified.
- **Stable-tracking releases.** Plugin releases track OpenClaw **stable**. SDK surfaces that exist only in beta releases are adopted only after they reach stable (rule recorded 2026-10-18 against the Async inbound-envelope APIs in 2026.10.10-beta.1). We don't run beta hosts on the production path, and we don't ship plugin releases that require them.
- **Host support window.** The declared floor is **OpenClaw ≥ 2026.5.26** (`peerDependencies`). When the floor moves, it follows the oldest stable still inside its compatibility window, ships in a minor release, and gets a changelog callout — never silently in a patch.
- **Reliability fixes ride the release line.** Example: a mid-session transport drop used to leave the channel dark indefinitely (the monitor never rejected its lifecycle promise) — fixed and pinned by lifecycle tests in **v2026.10.18**.
- **Where you see breakage first.** Verified host/plugin/transport combinations live in [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md); known incompatibilities are filed on the [issues page](https://github.com/fintlp/openclaw-meshtastic/issues); fixes land here first and are offered upstream as PRs.

## Development

```bash
npm install
npm test
npm run typecheck
npm run build
```

After changing `src/config-schema.ts` or `src/config-ui-hints.ts`, regenerate manifest metadata:

```bash
npm run sync-manifest
```

## License boundary

Plugin scaffolding: MIT. This plugin depends on `@meshtastic/core` and official transport
packages, which are **GPL-3.0-only**. Review GPL obligations before redistribution.
