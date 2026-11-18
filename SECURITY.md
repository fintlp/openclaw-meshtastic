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
  `requireMention: true` to require a mention. Both gates are enforced:
  a listed channel with no sender list admits **nobody** (fail-closed since
  2026.10.27). Releases up to 2026.10.25 were permissive here — a listed
  channel with no sender list anywhere admitted every sender on it (the
  `channelAllowlistedWithoutSenderFilter` → `open` fallback); that fallback
  is gone, pinned by tests.
  `groupTransmit: false` governs the OUTBOUND direction only — it does not stop
  inbound channel messages from triggering the agent.
- **Group tool restrictions remain additive (2026.11.2, MCP05 / #40):**
  `groups.<id>.toolsBySender` accepts deny-only rules and adds them to the
  group-wide `tools` baseline; wildcard and exact-group maps both apply. Sender
  allow/alsoAllow fields are rejected instead of replacing a group deny. Mesh
  group sender numbers are still claims, so security-critical denies belong in
  group-wide policy or on a dedicated least-privilege agent.
- **Protected groups keep their policy-bearing session scope (2026.11.2):**
  when group-wide or sender tool policy applies, `groupScope: "main"` is refused
  before durability intake or dispatch because it strips the group id the host
  needs for policy resolution. Use `per-group` globally or in the effective
  binding; protected replays terminate as `group-scope-main`.
- **Command suppression precedes mention evaluation (2026.11.2):** under the
  default verified command-identity gate, an allowlisted group sender cannot
  use a recognized slash command to bypass `requireMention`. Mentioned text is
  dispatched without command authority; verified DMs and the explicit legacy
  `commandIdentity: "policy"` mode retain their documented behavior.
- **Reserved broadcast addresses are refused unconditionally** (releases after
  2026.10.24): the send path refuses the reserved broadcast node number in
  every accepted form (`4294967295`, `node:4294967295`, `!ffffffff` any
  case, with or without the `meshtastic:` prefix) and the `^all` broadcast
  alias — regardless of `groupTransmit`. These reach every node in range
  with no channel scoping, so no config flag lifts the refusal; automated
  tests pin every form under both flag states.
- **Sender identity is enforced at intake, not merely graded** (releases after
  2026.10.35, issue #33 / ClawScan MCP07): one identity gate decides admission
  and command rights from the sender-identity grade, the keybook and config,
  and it runs before pairing, storage and dispatch on every inbound path
  (live, custom `onMessage` consumers, and durability replay). Defaults:
  a DM from a keybook-anchored number (pin or tombstone) must be
  `pki-verified` (`dmIdentity: "known-keys"`); commands run only from a
  `pki-verified` DM with key continuity (`commandIdentity: "verified"`, group
  traffic never commands); key mismatches are dropped (`pkiMismatch: "drop"`);
  mesh entries in `commands.ownerAllowFrom` always require PKI continuity and
  never apply to group traffic; key-bound `pkiManuallyVerified` entries
  (`!id=<base64 32-byte key>`) are enforced in every mode. A refusal sends
  nothing — no reply, no pairing code, no airtime. Residual risk: a
  never-anchored number can still be impersonated under `known-keys` (but
  with no commands and no known-contact session) — `dmIdentity: "strict"`
  closes that gap, and the grade itself still trusts the attached radio and
  first-seen pinning unless a contact is key-bound.
- **Cautious access defaults:** `dmPolicy: "pairing"` (every new contact needs
  your approval) and `groupPolicy: "disabled"` (channel traffic never triggers
  the agent until you opt in).
- **Per-session outbound flood containment:** `sessionSendRateLimit` runs at the cancellation-capable `message_sending` boundary before durable/provider delivery and the radio adapter. Defaults are 8 estimated DM packets plus 768 UTF-8 payload bytes per trusted channel+account+canonical session per 10 minutes, and 1 group packet per session. Packet estimates share the production UTF-8 chunker/config. Accepted payloads are charged synchronously; excess returns `cancel: true` with retry context and is never queued. Missing session keys remain account-only, and disabling this layer never disables the independent account DM/group budgets or the `groupTransmit`/reserved-broadcast refusals. Session state is in memory and resets on restart.
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
