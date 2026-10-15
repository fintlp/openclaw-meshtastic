# Changelog

All notable changes to `openclaw-meshtastic`.

This fork (`fintlp/openclaw-meshtastic`) is the maintained line; upstream
(`skrashevich/openclaw-meshtastic`) has been dormant since May 2026. Fixes
are offered upstream as PRs. Date-based versioning: `2026.M.P`.

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
