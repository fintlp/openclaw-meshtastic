# Changelog

All notable changes to `openclaw-meshtastic`.

This fork (`fintlp/openclaw-meshtastic`) is the maintained line; upstream
(`skrashevich/openclaw-meshtastic`) has been dormant since May 2026. Fixes
are offered upstream as PRs. Date-based versioning: `2026.M.P`.

## 2026.10.23 — 2026-10-19

Guided onboarding: the setup wizard now proves the connection before it
writes anything, and reads the node's own identity back as evidence.

Features

- Probe-before-write onboarding wizard. `openclaw onboard` (or re-running channel setup) now walks transport selection (TCP 4403 recommended / HTTP 4433 / USB serial with auto-detected ports), parses `host:port` suffixes, then PROBES the candidate connection before any config is written. Failures get targeted diagnoses instead of a bare error: the classic 4403-vs-4433 mixup is detected from the probe signature and offered as a one-click transport switch; refused connections, VLAN-isolation timeouts, serial ports busy (single-owner rule) or missing (charge-only USB cable), and TLS mismatches each get their specific fix. Retry in place, or save-anyway for later troubleshooting.
- Node identity readback. After a successful probe the wizard reads the node's identity off the radio — node ID, long/short name, LoRa region, firmware version — and warns when the region is UNSET (the node cannot transmit until a region is chosen in the Meshtastic app). Verified end-to-end against live hardware: probe answered in 12 ms, the full identity read in about a second.
- The airtime rule is now a setup screen. Group transmit is presented as an explicit, informed opt-in during onboarding (default stays refused in the send path), and group entries created during setup default to mention-gated (`requireMention: true`) so a listening agent only speaks when addressed.
- Non-interactive setup flags. `openclaw channels add meshtastic` now accepts `--transport tcp|http|serial`, `--serial-path`, `--baud-rate`, `--dm-policy`, and `--group-transmit` alongside the existing `--host` (which now also parses `host:port`) and `--tls`. Ports default per transport (4403 TCP, 4433 HTTP) and are written explicitly.

Tooling-tests

- 85/85 tests (was 69). New suites pin host:port parsing, per-transport port defaults, every probe-diagnosis mapping, baud-rate parsing, and non-interactive input normalization (dmPolicy enum, groupTransmit boolean strings).

Docs

- README quickstart reworked around the three-minute wizard path; the 4403≠4433 gotcha now notes the wizard detects it in-flow.
- New companion skill on ClawHub (`@fintlp/meshtastic-connect`): the verified onboarding path plus the trap guide, for agents asked "make my OpenClaw speak Meshtastic".
- Example host IPs in docs and wizard placeholders are generic (192.168.1.10/.20), not any operator's node.

## 2026.10.22 — 2026-10-18

Airtime protection, a group-transmit guard, and a responsible-disclosure policy.

Features

- Outbound flood guard. The send path now budgets airtime packets per rolling window (defaults: 20 per 10 minutes for DMs, a stricter 3 per 10 minutes for group channels) and refuses a message with a retry hint when the budget is exhausted — before the first frame is transmitted, never partially aired. Tune via channels.meshtastic.sendRateLimit (maxSends / groupMaxSends / windowMs / enabled false to disable).
- Group-transmit code guard (default-deny). The outbound send path now refuses every channel- or broadcast-addressed message unless channels.meshtastic.groupTransmit is set to true explicitly. Previously, group replies would transmit whenever group policy allowed them. DMs are unaffected. Tests pin both the refusal and the opt-in, and the README safety section now documents the guard. If you rely on channel replies, set groupTransmit to true when upgrading.

Docs

- SECURITY.md: responsible-disclosure policy (private reporting via GitHub Security Advisories, scope, response expectations).

## 2026.10.21 — 2026-10-18

Installability pass. Same-day follow-up to v2026.10.20; the changelog
date is the true ship date.

Docs / install metadata

- README Install section now leads with the ClawHub one-liner
  (openclaw plugins install clawhub:@fintlp/openclaw-meshtastic) and the
  channels add quickstart; the git-checkout path is marked development.
- package.json gains keywords (openclaw, meshtastic, lora, mesh, radio,
  off-grid and friends) and a homepage link for registry and search
  surfaces.
- install.defaultChoice flipped from npm to clawhub: the package is not
  published on npm, so an npm-preferred install path would fail. The
  documented install command was already the ClawHub one; now the
  metadata agrees. No code changes in this release.

## 2026.10.20 — 2026-10-18

Catalog icon. Same-day follow-up to v2026.10.19; the changelog date is
the true ship date.

Docs / catalog

- ClawHub catalog icon added: the OpenClaw lobster family style (dark
  navy field, coral creature, teal signal) with a mesh-network triangle
  above the head as the Meshtastic detail. Hand-authored SVG kept in the
  repo at assets/icon.svg (outside the package files list) for future
  edits; the shipped raster is assets/icon.png, 512x512, 25 KB. No code
  changes in this release.

## 2026.10.19 — 2026-10-18

First ClawHub release, published as @fintlp/openclaw-meshtastic. Same-day
follow-up to v2026.10.18; the changelog date is the true ship date.

Fixes

- HTTP transport is now actually selectable: normalizeMeshtasticTransport
  silently rewrote http to tcp, so an HTTP config became a TCP connection
  attempt (ECONNREFUSED on 4433, or protocol garbage against a TCP
  listener). Upstream-lineage bug, present in identical form on
  skrashevich/main; the pre-existing normalizer test pinned TCP, serial
  and unknown values but never the http case. Found by the ported probe
  test going red with a real connection attempt. Regression pin added.

Features

- Bridge-compatibility port, adapted from upstream's unmerged
  cdx/conduct-plugin-audit-for-compatibility branch (original authors
  Sergey Krashevich and copilot-swe-agent): the HTTP probe falls back
  from OPTIONS /api/v1/toradio to GET /api/v1/fromradio?all=false on
  404/405, because serial2tcp-style bridges do not implement OPTIONS;
  reply-id parsing is now strict (digits only, safe positive integer);
  sends report a fallback:<timestamp> message id when a bridge returns
  no ACK and no queue id (every send previously reported messageId 0).
  New probe test file, fallback-id send test. Suite 45/45.

Docs

- README overhaul mirroring the meshcore use-case-forward and
  compatibility-policy pass: use-case tour, the 4403-vs-4433 and
  TCP-ciphertext gotchas up front, an honest group-transmit safety story
  (this plugin can reply on channels when policy allows — no code-level
  receive-only), and a Compatibility and maintenance policy section:
  tracked SDK surface (~31 subpaths), deprecation precedent, stable-
  tracking rule, host floor >= 2026.5.26. Install instructions now point
  at this fork; package description is use-case-led.
- New docs/COMPATIBILITY.md (verified host/plugin/transport matrix) and
  docs/PUBLISHING.md (the ClawHub release run-book, written during this
  debut).

Release mechanics

- Package scoped to @fintlp/openclaw-meshtastic (publish owner), with
  runtimeExtensions/runtimeSetupEntry declared, install npmSpec and
  clawhubSpec mirrored, minHostVersion aligned to >= 2026.5.26, and the
  manifest display name added.

## 2026.10.18 — 2026-10-18

**Fixes**

- **Monitor promise now rejects on a mid-session device disconnect**
  (port of fintlp/openclaw-meshcore#4): the `onDeviceStatus` disconnect
  detector ran cleanup but never rejected the returned lifecycle promise —
  the `settled` check inside the promise executor only runs once at
  construction, so a drop after startup left the promise pending forever
  and the gateway health-monitor blind: channel dark indefinitely, no
  restart. The disconnect path now rejects the lifecycle; abort still
  resolves cleanly. New `monitor.lifecycle.test.ts` pins mid-session
  reject, no-reject-on-connect-event, no resolve-after-reject on late
  abort, and the disconnect-during-startup path.
- **Outbound send result `target` mapped to the structured SDK shape**
  (`{ kind: "conversation", id }`): the openclaw 2026.10.1 SDK types
  `OutboundDeliveryResult.target` as a structured object, not a string —
  `tsc --noEmit` failed on the `sendText` wiring. Same mapping meshcore
  already carries.

## 2026.10.15 — 2026-10-15

**Fixes**

- **Connect + inbound message log lines now reach gateway.log** (#1): the
  "connected to Meshtastic (tcp)" line and both inbound message lines were
  wired to the plugin child logger, which never reaches gateway.log at the
  default level — the connect-line count across months of gateway logs was
  zero. All three sites now route via `console.log`; inbound-text
  redaction is untouched.
- **Dual-zod-instance contamination in the test baseline**: the plugin's
  top-level zod 4.4.3 misread the openclaw SDK's nested zod 4.6.5 schema
  internals, failing all 6 config-schema tests ("expected nonoptional").
  Aligned to the house standard (openclaw 2026.10.1 + zod 4.6.5) → single
  instance. Check `npm ls zod` after any openclaw devDep bump.

**Tooling / tests**

- openclaw devDependency 2026.9.8 → 2026.10.1; zod 4.4.3 → 4.6.5.
- Regression pins for all three log-route sites: the test harness captures
  every event subscriber and fires synthetic packets through both inbound
  paths (plain + encrypted with mocked crypto), with per-site red checks
  plus a no-dual-log assertion. Suite 38/38.

**Repo hygiene**

- This CHANGELOG; issues enabled on the fork; `repository.url` now points
  at the fork.

## 2026.10.11 — 2026-10-11

**Fixes**

- **Migrated off openclaw 2026.10.1 removed compat aliases**: imports of
  `channel-lifecycle` / `channel-message` / `outbound-runtime` moved to
  `channel-outbound`; without this the plugin fails to load on openclaw
  ≥ 2026.10.1. openclaw devDependency 2026.5.26 → 2026.9.8 (2026.5.26
  predates `channel-outbound`).

## 2026.6.14 — 2026-06-14

(Carried in the 2026.10.11 release; version was not bumped at the time.)

- **Migrated to the OpenClaw 2026.6.5+ adapter pattern**:
  `runChannelInboundEvent()` adapter-based inbound API replaces the
  deprecated `core.channel.turn.runAssembled()`.

## 2026.5.30 — 2026-05-29

(Upstream lineage, kept for continuity.)

- Inbound message text redacted from gateway logs by default.
- Monitor rejects pending commands on disconnect; disconnect timeout.
- TCP decrypt startup race fixed.

## Initial feature set — 2026-05 (upstream lineage)

- Meshtastic protobuf transports: HTTP, TCP, serial; TCP as default.
- AES-CTR decryption for TCP/serial transport.
- Package renamed `openclaw-meshtastic`; docs use anonymised node-id/IP
  placeholders.
