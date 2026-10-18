# Changelog

All notable changes to `openclaw-meshtastic`.

This fork (`fintlp/openclaw-meshtastic`) is the maintained line; upstream
(`skrashevich/openclaw-meshtastic`) has been dormant since May 2026. Fixes
are offered upstream as PRs. Date-based versioning: `2026.M.P`.

## Unreleased

**Fixes**

- **`transport: "http"` is now actually honored**: `normalizeMeshtasticTransport`
  silently rewrote `http` to `tcp` — an HTTP config became a TCP connection
  attempt (ECONNREFUSED on 4433, or protocol garbage). Upstream-lineage bug
  in identical form on skrashevich/main; the pre-existing normalizer test
  pinned TCP/serial/unknown but never the http case. Found by the ported
  probe test going red with a real connection attempt. Regression pin added.

**Features**

- **Bridge-compatibility port** (adapted from upstream's unmerged
  `cdx/conduct-plugin-audit-for-compatibility` branch, original authors
  Sergey Krashevich + copilot-swe-agent): HTTP probe falls back from
  `OPTIONS /api/v1/toradio` to `GET /api/v1/fromradio?all=false` on
  404/405 (serial2tcp-style bridges don't implement OPTIONS); strict
  reply-id parsing (digits only, safe positive integer); `fallback:<ts>`
  message id when a bridge returns no ACK and no queue id (sends
  previously all reported messageId `"0"`). New probe.test.ts, fallback-id
  send test.

**Docs**

- README overhaul mirroring the meshcore use-case-forward +
  compatibility-policy pass: use-case tour, the 4403-vs-4433 and
  TCP-ciphertext gotchas up front, honest group-transmit safety story (no
  code-level receive-only here), Compatibility & maintenance policy
  section (tracked SDK surface ~31 subpaths, deprecation precedent,
  stable-tracking rule, host floor ≥2026.5.26). Install instructions now
  point at the fork; package.json description use-case-led.

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
