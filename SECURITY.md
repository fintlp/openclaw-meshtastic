# Security Policy

## Supported versions

This plugin uses date-based versioning (`2026.M.P`), and security fixes ship
on the latest release line. Only the newest release (the `latest` tag on
ClawHub) receives fixes — older releases are not patched individually. Please
upgrade before reporting issues against old versions.

| Version | Supported |
| --- | --- |
| Latest release | ✅ |
| Older releases | ❌ |

## Reporting a vulnerability

Please report vulnerabilities **privately** via GitHub's private vulnerability
reporting:

- This repository → **Security** tab → **Advisories** → **Report a vulnerability**
- Direct link: <https://github.com/fintlp/openclaw-meshtastic/security/advisories/new>

Please **do not open a public issue** for a vulnerability.

Helpful details to include:

- The plugin version you tested, and the OpenClaw host version.
- Steps to reproduce, or a proof of concept.
- The impact you see — in particular, what an attacker could make the agent
  or the node *do*.
- Whether triggering the issue requires radio access (being in LoRa range) or
  can be done remotely through the host.

What to expect:

- **Acknowledgment within 72 hours.**
- An assessment and a fix plan after triage. We practice coordinated
  disclosure: we agree on a public-advisory date with you once a fix is
  available, and we credit reporters in the advisory (unless you prefer
  otherwise).

If private reporting is unavailable for some reason, open a public issue that
says only that you would like a private contact — no technical details.

## Scope

In scope:

- This plugin's code: the outbound send path (including the group-transmit
  guard), inbound message handling, client-side decryption, pairing and
  allowlist enforcement, group policy, and config validation.
- The release metadata and publish flow described in
  [docs/PUBLISHING.md](docs/PUBLISHING.md).

Out of scope:

- **OpenClaw core / the Gateway host** — please report to the OpenClaw project.
- **Radio firmware and the Meshtastic protocol itself** — for protocol issues,
  the [Meshtastic project](https://github.com/meshtastic) is the right place.
- **Third-party dependencies** (for example `@meshtastic/core`) — please
  report those upstream. We still want to hear about them when they affect
  this plugin.

## Security design

This plugin can, in principle, transmit — so the guardrails are structural
rather than instructional:

- **Group transmission is default-deny, in code.** On `main` (and in releases
  after 2026.10.21), the outbound send path refuses every channel- or
  broadcast-addressed message unless you explicitly set
  `channels.meshtastic.groupTransmit: true`. Automated tests pin both the
  refusal and the opt-in. On v2026.10.21 and earlier, channel transmission is
  possible whenever group policy allows it — upgrade, or keep
  `groupPolicy: "allowlist"` with an empty allowlist.
- **Inbound group traffic is default-deny** (releases after 2026.10.25):
  `groupPolicy: "disabled"` by default — channel messages never trigger an agent
  session until you opt in. Opting in is explicit and two-part: `"allowlist"`
  with the channels you list (`channels` / `groups` keys), **plus**
  `groupAllowFrom` (or a per-group `allowFrom`) to name the senders and
  `requireMention: true` to require a mention. `"allowlist"` gates channels,
  not senders: on releases up to 2026.10.25, a listed channel with no sender
  list anywhere admitted every sender on it (the plugin's
  `channelAllowlistedWithoutSenderFilter` → `open` fallback; pinned by a test).
  `groupTransmit: false` governs the OUTBOUND direction only — it does not stop
  inbound channel messages from triggering the agent.
- **Reserved broadcast addresses are refused unconditionally** (releases after
  2026.10.24): the send path refuses the reserved broadcast node number in
  every accepted form (`4294967295`, `node:4294967295`, `!ffffffff` any
  case, with or without the `meshtastic:` prefix) and the `^all` broadcast
  alias — regardless of `groupTransmit`. These reach every node in range
  with no channel scoping, so no config flag lifts the refusal; automated
  tests pin every form under both flag states.
- **Cautious access defaults:** `dmPolicy: "pairing"` (every new contact needs
  your approval) and `groupPolicy: "disabled"` (channel traffic never triggers
  the agent until you opt in).
- **Metadata-only logging by default:** inbound message bodies are not logged
  unless `logInboundMessageContent: true` is set deliberately.

See the README's "Safety by default" section for the full story and the
airtime rationale.

Hardening pointers:

- Leave `groupTransmit` unset (or `false`) unless you have a specific reason
  for the agent to speak on a channel.
- Keep `dmPolicy: "pairing"` (or an explicit `allowFrom` list).
- Give your agent a standing instruction to never speak on mesh channels
  unprompted — belt and suspenders on top of the code guard.
- Advertise only a GPS position you are comfortable sharing with every node in
  range.
