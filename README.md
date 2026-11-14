# openclaw-meshtastic

**An AI agent on your Meshtastic mesh.** This plugin connects your [OpenClaw](https://docs.openclaw.ai) gateway to a Meshtastic node over the **official protobuf stack** and puts your agent on the radio: reachable by direct message from any node in range, fully local — no MQTT, no cloud, no internet anywhere in the loop.

> **Maintained line:** this is the actively maintained fork (`fintlp/openclaw-meshtastic`). Upstream (`skrashevich/openclaw-meshtastic`) has been dormant since May 2026. Fixes are offered upstream as PRs; releases ship here. See the compatibility & maintenance policy below.

## What you can do with it

- **Off-grid messaging assistant.** Your agent — the same one that knows your notes, your calendar, your home automation — answering DMs from a €25 LoRa handheld with zero internet in the path. Mesh in, answers out.
- **Emergency / backup channel.** When the internet dies, the mesh doesn't. A node on your LAN keeps your agent reachable when everything else is dark.
- **Unattended-site monitor.** Put a node somewhere remote — attic, shed, mountain hut with a solar panel — and ask it how it's doing. Meshtastic's telemetry (battery, voltage, channel utilization) rides the same mesh as the chat.
- **Field-expedition comms hub.** A gateway at base camp, handhelds in the field. Everyone DMs the hub; the hub answers — weather, schedules, "where is everybody."
- **Node map on demand.** Ask "show me the mesh" on WhatsApp or Telegram and get a link that opens a map of every node your radio knows, with role and last heard. Zero airtime: the plugin keeps a node book file, your agent turns it into a geojson.io link (docs/meshtastic.md, "Node book").
- **Mesh-community bot.** A pairing-gated assistant on your local mesh. New contacts get a pairing challenge, you approve the ones you know, and the defaults keep it from ever becoming airtime spam.

Meshtastic is the largest LoRa mesh ecosystem there is — cheap hardware, phone apps for every platform, an enormous community. This plugin deliberately talks to your node the way the official apps do (protobuf over TCP/HTTP/serial), not through MQTT or any broker. Your messages never leave your LAN except over the radio itself.

## From a node on your LAN to your first DM in ~3 minutes

1. **Get a node on your network.** Any Meshtastic device with WiFi (a Heltec V3, a T-Beam, a LilyGo) running current firmware. No WiFi on the board? A USB-serial node works too, directly or through a [serial2tcp bridge](https://github.com/skrashevich/go-meshtastic-serial2tcp).
2. **Install the plugin and run the guided setup:**

   ```bash
   openclaw plugins install clawhub:@fintlp/openclaw-meshtastic
   openclaw onboard   # choose Meshtastic
   ```

   The wizard asks how the gateway reaches your node (TCP 4403 / HTTP 4433 / USB serial), **probes the connection before writing anything** (with targeted fixes for the classic traps — see below), reads the node's identity (ID, name, LoRa region) off the radio, and walks you through access policy with the safe defaults pre-selected.
3. **Send yourself a DM** from a second device — a handheld, or the phone app paired to another node. Watch your agent answer. Over LoRa.

Prefer one-liners? Fully non-interactive:

```bash
openclaw channels add meshtastic --transport tcp --host 192.168.1.10
# flags: --transport tcp|http|serial --host h[:port] --tls --serial-path /dev/cu.usbserial-0001
#        --baud-rate 115200 --dm-policy pairing|allowlist|open|disabled --group-transmit
```

Two gotchas cost real evenings, so the wizard defuses them in-flow (and they live at the top here too):

- **4403 ≠ 4433.** TCP (protobuf stream) is port **4403**; HTTP (the node's web API) is port **4433** — and the HTTP API must be explicitly enabled in the node's network settings. Picking "http" and pointing at 4403 (or vice versa) fails in ways that look like everything *except* a wrong port. The wizard's probe detects exactly this and offers to switch. When in doubt: `transport: "tcp"`, port 4403.
- **TCP payloads arrive encrypted** and `@meshtastic/core` does not decrypt them. This plugin does — automatically, per-channel PSKs, no configuration. It just works, but only *because* the plugin handles it; a raw TCP client will show you ciphertext and confusion.

Five minutes of [docs/meshtastic.md](docs/meshtastic.md) saves the evening.

## What it does, in one breath

- **Direct messages (DMs):** full two-way chat, with pairing/allowlist/open access control.
- **Mesh broadcast channels:** per-channel group policy (allowlist by default) — plus a code-level guard: channel replies stay **refused in the send path** until you set `groupTransmit: true`. More on that choice below.
- **Three official transports:** TCP (4403, default), HTTP (node API), USB serial.
- **Client-side AES-CTR decryption** for TCP/serial — encrypted mesh traffic works out of the box.
- **Reply-to threading, multi-account, multi-agent binding.**
- **Byte-accurate outbound chunking.** Long replies are split to a UTF-8 **byte** budget (`textChunkLimit`, default 200 bytes) and capped at the 221-byte radio payload limit — larger configured values are clamped with a one-time log note. Whitespace boundaries are preferred and hard splits happen only at grapheme clusters, so combined characters (emoji sequences, flags, niqqud, tashkeel, decomposed accents) never break across parts. This guarantee covers the plugin's own split; if the OpenClaw host pre-chunks a long reply before handing it to the plugin, upstream cuts are outside the plugin's control.

## Safety by default: an agent with a transmitter

Connecting an AI agent to a LoRa mesh is different from connecting it to a chat app. There is no network perimeter on the radio: anyone with an inexpensive board can DM your node. And everything transmitted on a channel is heard by every node in range — there is no edit button and no delete button on the airwaves.

The guardrails here are layered, and the important one is structural:

1. **In the code.** The send path refuses every channel- or broadcast-addressed message by default — no matter what any agent session asks for — and automated tests pin the refusal. The reserved broadcast address itself (node number `4294967295` / `!ffffffff`, or the `^all` alias) is refused **unconditionally** — no config flag, `groupTransmit` included, ever sends to it. Meshtastic channels are how fleets coordinate, so for channel traffic there is exactly one way through: an explicit **`groupTransmit: true`** in `channels.meshtastic`. Removing the refusal would take a deliberate code change; enabling channel transmission takes a deliberate config change.
2. **In the defaults.** **`dmPolicy: "pairing"`** (every new contact needs your explicit approval) and **`groupPolicy: "disabled"`** (channel traffic never triggers the agent unless you opt in). Both stay in force even with `groupTransmit` on. The two directions are separate: **`groupTransmit: false` stops your agent from transmitting on channels — it does not stop inbound channel messages from triggering the agent.** Inbound channel traffic is governed by `groupPolicy`: `"disabled"` (the default) drops it, `"open"` admits it, and `"allowlist"` admits only the channels you list. Note that `"allowlist"` gates **channels and senders in two separate steps** — a listed channel with no `groupAllowFrom` (and no per-group `allowFrom`) admits **nobody** (fail-closed); pair the channel list with explicit senders and `requireMention: true` (see [Receiving from a channel](#receiving-from-a-channel-opt-in-explicit)).
3. **In your agent's instructions (recommended).** Give your agent a standing rule to never speak on mesh channels unprompted — belt and suspenders on top of layer 1.

Why so strict? LoRa airtime is a shared commons. An agent that chats on a public channel degrades the mesh for everyone in range. Keep `groupTransmit` off unless you have a reason.

A second structural rail caps total output: the **flood guard** budgets outbound airtime packets per rolling window — 20 per 10 minutes for DMs, and a stricter 3 per 10 minutes for group channels — and refuses with a retry hint when the budget is exhausted, before the first frame goes on air. A message is always sent whole or refused whole, never partially aired. Tune via `sendRateLimit` (`maxSends`, `groupMaxSends`, `windowMs`, `enabled`).

If your node advertises a GPS position, that position is broadcast to every node in range — publish one you are comfortable sharing with strangers.

### Sender identity: what you can and cannot trust

Meshtastic encrypts channel traffic with AES-CTR and a shared channel PSK. **AES-CTR authenticates neither the sender nor the ciphertext**, and this plugin's TCP/serial receive path decrypts exactly that way (see [Encryption (TCP / serial)](#encryption-tcp--serial)). Since firmware 2.5, direct messages can instead be encrypted per-node (PKI): the radio AEAD-decrypts them with the sender key pinned in its own node database and stamps the packet `pki_encrypted` plus the sender's public key. Every inbound message carries a structured **sender-identity grade** — shown to the agent as channel context next to the sender id, never as part of the message text, so a sender cannot forge the annotation by typing it. The three grades:

- **`psk-grade` — a claim, not proof.** The packet was channel-PSK decrypted (by this plugin on TCP/serial, or by the node/library stack on HTTP) or arrived in cleartext. Anyone holding the channel PSK can transmit a packet carrying any `from` number — and on the factory-default PSK (`AQ==`) channel, that means anyone in range. Treat channel sender identity, and DMs on a PSK channel, as convenience-grade. Always.
- **`pki-verified` — the attached radio's cryptographic claim, with continuity.** The radio's firmware AEAD-decrypted the packet with the per-node key its node DB pins for the sender number, **and** this plugin's keybook has continuity for that key: the first-seen key is pinned, and every later sighting must match it. **Read the trust root before relying on this grade:** it certifies the *attached radio's claim* about the packet, not physical reality — a compromised gateway-side radio (or hostile firmware flashed onto it) can set `pki_encrypted` and write arbitrary key bytes into any packet, undetectable from here, and the grade inherits the TOFU windows listed below. The attached radio belongs to your physical trust perimeter: protect and inventory it accordingly.
- **`mismatch` — never verified.** The packet's PKI provenance conflicts with the pinned key (or carries no key material at all). A mismatch surfaces three ways: the agent-visible annotation (with key fingerprints — full keys are never logged), a distinct Gateway log line, and a structured record in the keybook. Since 2026.11.1 a mismatch is **refused by default** at the identity gate (see below); `channels.meshtastic.pkiMismatch: "unverified"` restores the old admit-marked behaviour, and only takes effect with `dmIdentity: "off"`. A mismatching sender is never admitted as `pki-verified` under any setting, and tier-3-class actions must fail closed on a mismatch regardless.

**TOFU limits (read these before trusting `pki-verified`):**

- **First-contact race.** The first key learned for a node number owns the pin — whoever's advert is heard first. Pinning is the defense against *later* spoofing: firmware ≥ 2.7.6 drops whole adverts whose key mismatches the stored one, and this plugin does the same — except the plugin also *tells* you (the radio drops silently, with only a local log line its serial/TCP client never sees).
- **Eviction re-learn.** A radio's node DB is finite and evicts old nodes; re-learning after an eviction is a fresh first-contact *on the radio*. The plugin keybook is independent and persistent (`state/meshtastic-keys.json`, named accounts `state/meshtastic-keys.<accountId>.json`, mode `0600`): it survives gateway restarts and radio-side evictions alike, so your continuity does not reset when the radio's does. The keybook's own 2000-pin cap is also reachable over the air by a flood of forged adverts — so evicted pins leave a **tombstone**: the same key returning restores continuity, a *different* key under that number is `mismatch` until you re-pin, and a fresh first-seen pin is never granted after an eviction. Pins you mark `pkiManuallyVerified` are never evicted while the store holds any evictable pin — if it is saturated entirely with verified pins, new keys are simply not pinned (a distinct log line says so) and grade as first contact, rather than any verified anchor being dropped. That list is your defense against pin-flood eviction for high-value contacts.
- **The 2.8+ number binding is weak.** Firmware 2.8 derives node numbers as `crc32(public_key)`. That stops *lazy* spoofing — a random key under a taken number fails self-consistency — but crc32 is a linear checksum, and a deliberate attacker can grind a keypair whose crc32 matches a victim's number. The plugin runs the same check and flags an inconsistency as an anomaly detail on the annotation; it never treats the binding as proof of anything.
- **Key distribution is advert-based.** Keys arrive inside NodeInfo adverts (`User.public_key`) and as provenance on decrypted PKI packets. Whoever floods first wins an unpinned number; pin discipline and, for high-value contacts, out-of-band verification are the counters.

**Legitimate key rotation (re-pin).** Factory resets, replaced radios, and re-imported private keys (firmware 2.8.2+) all look exactly like an attack: a new key under an old number. Once you have confirmed the rotation out-of-band — and removed the stale node from the radio's own node DB so the radio re-learns (it pins first-seen too) — list the node in `channels.meshtastic.pkiRepin` and restart or reload the channel: the stored pin is cleared at start (with a log line) and the node's next observed key re-pins. Without the re-pin the node stays `mismatch` forever — **it never auto-heals**. The re-pin is idempotent: once the node's new key has been learned, further restarts and reconnects leave the pin alone (a persisted marker skips it). Remove the entry when you are done — removing it clears the marker, so a later re-addition re-arms a second rotation. Keys you have confirmed out-of-band can be recorded in `pkiManuallyVerified`: they are surfaced on the pin and in the node book, and those pins are **exempt from eviction**, which is the only in-product defense against pin-flood eviction today.

**What the identity gate enforces (since 2026.11.1).** One decision point (`src/identity-gate.ts`) turns the grade into admission and command rights, and it runs at *every* inbound entry point — live dispatch, a custom `onMessage` consumer, and the durability replay — **before** pairing, storage or dispatch. A refusal sends nothing (no reply, no pairing code, no airtime) and logs one throttled line per sender (fingerprints only, never bodies or keys). The gate only ever removes rights; it never admits a sender your access policy would deny.

| Rule (first match wins) | Default | What it refuses | What stays open |
| --- | --- | --- | --- |
| A message without an identity annotation counts as `psk-grade` | always | — | fail closed, never open |
| Owner ids (mesh entries in `commands.ownerAllowFrom`) | always | group messages from owner ids; owner DMs that are not `pki-verified` with continuity | owner authority over the mesh needs PKI continuity, in every mode |
| `pkiManuallyVerified` entries | always | id form: DMs that are not `pki-verified` with continuity and the verified mark; key form (`!id=<base64 32-byte key>`): any DM whose pin is not a byte-exact match | group traffic from listed ids follows the normal group rules |
| `mismatch` grade | `pkiMismatch: "drop"` | the message | `"unverified"` admits it marked — only takes effect with `dmIdentity: "off"` |
| `dmIdentity: "strict"` | opt-in | every DM that is not `pki-verified` | nodes on firmware before 2.5 can no longer DM you |
| `dmIdentity: "known-keys"` | default | DMs from a number with a pin **or tombstone** that are not `pki-verified` | numbers the gateway has never seen a key for (see residual risk) |
| Command authority | `commandIdentity: "verified"` | commands from anything but a `pki-verified` DM with continuity — group traffic never carries commands | the text still reaches the agent as plain text |

**Residual risk, stated plainly.** Under `known-keys`, a number the gateway has never seen a key for can still be impersonated by anyone holding the channel PSK — but that sender gets no commands and never reaches a known contact's session. `strict` closes the gap at the cost of pre-2.5 nodes. The `pki-verified` grade itself still trusts the attached radio and first-seen pinning (TOFU), unless the contact is key-bound in `pkiManuallyVerified`.

**Recommended deployment.** Gateway radio firmware **2.7.15 or newer** (CVE-2025-53627); `transport: tcp` or serial (HTTP carries no PKI provenance); a dedicated, least-privilege agent for mesh traffic via `bindings`; `session.dmScope: per-channel-peer` so mesh DMs never share your main session; key-bound `pkiManuallyVerified` entries for high-value contacts. Never list mesh nodes in `commands.ownerAllowFrom` unless they are key-bound — the gate refuses owner claims over group traffic and demands PKI continuity either way, but the cleanest owner surface is no mesh owner at all.

More consequences:

- **PKI packets this node cannot decrypt are refused, never garbled.** A `pki_encrypted` packet that arrives still-encrypted on the TCP/serial path (relayed, or not addressed to this node) is **dropped with a distinct log line** — never mis-decrypted with the channel key (AES-CTR cannot throw on a wrong key, so without the check it would garble into fake text carrying a real sender header). In-plugin PKI decryption for packets addressed to the gateway node is phase 2, tracked as [#7](https://github.com/fintlp/openclaw-meshtastic/issues/7). The HTTP transport hands decryption to the node/library stack (its trust properties are the node's; PKI provenance there is not verified against live firmware — the grade degrades to `psk-grade` on that path, so apply the same policy discipline either way).
- **Allowlists are policy, not identity.** `dmPolicy`, `groupAllowFrom` and friends gate *which sender numbers may reach the agent*. Since 2026.11.1 the identity gate (above) is the structural counter: a forged `psk-grade` sender can no longer inherit a pinned contact's session, command rights, or owner authority. For anything with physical or financial consequence — door locks, alarms, purchases — require out-of-band confirmation, no matter how certain the sender looks. `pki-verified` raises the bar; it does not remove it.
- **The real perimeter is blast radius.** Run mesh traffic on a dedicated, least-privilege agent (see [Optional: dedicate an agent](#3-optional-dedicate-an-agent-to-mesh-traffic)), keep `groupTransmit` off, and treat every mesh-originated instruction as unverified until proven otherwise.

## Inbound durability (on by default)

**Why this exists.** A mesh message that reaches your gateway but dies in a restart is gone — the sender's radio got no NAK, they think you read it, you never see it. That used to happen on every OpenClaw update, every config reload, every crash at the wrong second. Durability (issue #8) closes that gap: **frames admitted for an agent turn are logged before dispatch and replayed after a restart — at-least-once between the radio and the agent.**

**Use cases it covers:**

- **Updates and restarts mid-conversation.** A DM arrives, the gateway restarts for an update seconds later — after boot, undispatched messages are replayed to the agent in log order.
- **Crash recovery.** Frames received but not yet dispatched are re-delivered on the next start instead of vanishing. A turn that was running when the process died counts as an attempt and is retried (bounded — see below), so a crash loop cannot replay forever.
- **Sender retries.** Nodes retransmit when an acknowledgement is lost, and a reconnecting gateway re-hears frames. Persistent dedupe (sender node number + packet id, sliding 24 h window) collapses those re-deliveries into one turn, so a flaky link does not produce duplicate answers.

**The honest limits (read these before relying on it):**

- **At-least-once, not exactly-once.** A restart while the agent is mid-turn can produce a *duplicate* reply when the event replays. On a shared medium, that is the right trade — a duplicated answer beats a lost question.
- **A queued follow-up is only as durable as the host process.** When the peer's session is busy, the host accepts the message into its in-memory follow-up queue (`deferredToActiveRun`) and the plugin marks it delivered — the queue belongs to the host from that point. A host crash before the drain loses that one follow-up; no plugin can close that gap.
- **Replays are not fresh turns.** Anything older than `maxReplayAgeMs` (default **1 hour**) is dead-lettered as stale instead of replayed — a day-old "open the garage" must not fire on Tuesday's reboot. Replayed turns are tagged for the agent with their original receive time.

**What it does not cover** (honest scope): while the gateway is disconnected from the node, nothing is *received* — a gateway that is down for hours loses messages at the radio layer, before this feature ever sees them.

**Setup: none.** It is on by default and needs no configuration. The event log lives at `state/meshtastic-durability-<accountId>.sqlite` (SQLite WAL, no native dependency — requires Node ≥ 22.13; older runtimes fall back to pre-durability behavior with one log line). Opt out with `durability.enabled: false` — and delete the `.sqlite` file and its `-wal`/`-shm` sidecars if you do not want the kept copy. Health and replay activity are reported in the Gateway log (`durability replay: N event(s) claimed`, dead-letter and prune lines).

How it works, briefly: admitted frames are appended to the log and claimed with a lease *before* dispatch; the attempt counts at claim, so a dead process is a counted attempt, and a running turn keeps its lease renewed. On startup, every in-flight row owned by another process is reclaimed, stale rows are dead-lettered, and the pending backlog replays in id order (abort- and disconnect-aware, time-capped, after all listeners are registered). Dispatch failures release the claim and retry next start; `maxDispatchAttempts` (3) dead-letters with a log line. Pruning removes only completed rows — never pending work — at startup and hourly, on a 30-day / 50 000-event budget, looping until under budget. Admission drops and pairing challenges stay out of the store (the runtime log is their record); admitted channel traffic (`groupPolicy` open/allowlist) is logged like DMs. Fields: `enabled`, `retentionDays`, `maxEvents`, `pruneBatch`, `maxReplayAgeMs`, `maxDispatchAttempts`, `leaseMs`, `dbPath`.

**Exposure note.** The log keeps message bodies only while work is pending; dispatched and dead rows are blanked, leaving dedupe keys and metadata. Pending bodies share the exposure class of the host session store. Wire encryption is unchanged; the log holds no keys.

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

Separately from logging: the **inbound durability store** (on by default, see above) keeps a local SQLite copy of each *admitted, not yet answered* message body at rest until the turn completes — then blanks it. If storing pending message text at rest is not acceptable on your host, set `durability.enabled: false` and delete the `state/meshtastic-durability-*.sqlite*` files.

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
      groupPolicy: "disabled",
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
      groupPolicy: "disabled",
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

#### Receiving from a channel (opt-in, explicit)

`groupPolicy` is `"disabled"` by default — channel traffic never triggers the agent. Listening is a deliberate opt-in, and because `"allowlist"` admits **channels, not senders**, name the senders you mean:

```json5
{
  channels: {
    meshtastic: {
      groupPolicy: "allowlist",
      channels: [0],
      groupAllowFrom: ["!aabbccdd"],           // only these nodes can trigger the agent
      groups: {
        "channel:0": { requireMention: true },  // and only when they mention it
      },
    },
  },
}
```

Both gates are required: a listed channel with no `groupAllowFrom` (and no per-group `allowFrom`) admits nobody — sender lists are mandatory in `"allowlist"` mode (fail-closed). `requireMention: true` narrows it further to messages that mention the agent. Replies on the channel stay refused unless you also set `groupTransmit: true`.

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

Note what AES-CTR does **not** give you: authenticity. A decrypted packet's `from` field is an unverified claim — see [Sender identity](#sender-identity-what-you-can-and-cannot-trust).

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
- **Deprecation & removal response.** When OpenClaw retires an SDK surface we use, we migrate off it and record the migration in the [changelog](CHANGELOG.md). Precedent: OpenClaw 2026.10.1 removed the `channel-lifecycle` / `channel-message` / `outbound-runtime` compat aliases — the plugin migrated to `channel-outbound` in **v2026.10.11**, the same day the breakage class was identified. OpenClaw 2026.10.5 removed the `runStoppablePassiveMonitor` helper from `extension-shared` — the plugin migrated to `runPassiveAccountLifecycle` (`channel-outbound`) in **v2026.10.24**, the same day.
- **Stable-tracking releases.** Plugin releases track OpenClaw **stable**. SDK surfaces that exist only in beta releases are adopted only after they reach stable (rule recorded 2026-10-18 against the Async inbound-envelope APIs in 2026.10.10-beta.1). We don't run beta hosts on the production path, and we don't ship plugin releases that require them.
- **Host support window.** The declared floor is **OpenClaw ≥ 2026.10.5** (`peerDependencies` and the install manifest). Raised from ≥ 2026.5.26 to ≥ 2026.10.1 in v2026.10.24 (the replacement lifecycle API does not exist on 2026.5.26), and from ≥ 2026.10.1 to ≥ 2026.10.5 in **v2026.10.28**: that release migrated the inbound envelope to the Async session-envelope APIs (`resolveInboundSessionEnvelopeContextAsync` / `createChannelInboundEnvelopeBuilderAsync`), which exist only from 2026.10.5 — the sync predecessors retire 2026-12-31 and are removed in the first January 2027 stable. When the floor moves, it follows the oldest stable still inside its compatibility window, ships in a minor release, and gets a changelog callout — never silently in a patch.
- **Load-path installs.** If the plugin runs from a git checkout or rsync'd copy under `~/.openclaw/plugins/`, its `node_modules/openclaw` must resolve to the host install via the **stable global link** (`~/Library/pnpm/global/5/node_modules/openclaw` on a pnpm-global setup) — never a real copy and never the versioned `.pnpm/openclaw@x.y.z` directory, which host upgrades delete (a deleted versioned dir took this plugin and MeshCore down once). Registry installs manage this themselves.
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

The suite includes a self-maintaining **SDK surface guard** (`src/sdk-surface.test.ts`): it scans the shipped sources and fails if any `openclaw/plugin-sdk/*` import is missing from the installed host package. Before upgrading a gateway host, run it against the target release from a repo checkout:

```bash
npm i -D openclaw@<target> && npx vitest run sdk-surface
```

## License boundary

Plugin scaffolding: MIT. This plugin depends on `@meshtastic/core` and official transport
packages, which are **GPL-3.0-only**. Review GPL obligations before redistribution.
