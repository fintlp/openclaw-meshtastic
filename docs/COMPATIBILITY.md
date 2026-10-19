# Compatibility

Verified combinations, with the date and evidence class. "Verified" = exercised live against real hardware; "expected" = follows from the protocol but untested by us.

The maintenance policy behind this matrix — tracked SDK surface, deprecation response, stable-tracking releases, host-floor bumps — lives in the [README](../README.md#compatibility--maintenance-policy).

## Plugin ↔ OpenClaw

| OpenClaw | Plugin | Status |
|---|---|---|
| 2026.10.5 | 2026.10.24 | ✅ verified (2026-10-20: 87/87 tests, typecheck, dist build; registered + connected on the production host after the 2026-10-20 restart) |
| 2026.10.1 | 2026.10.18 | ✅ verified (2026-10-18, production TCP channel, live inbound + outbound) |
| 2026.10.1 | 2026.10.19 | ✅ verified (2026-10-18, same install, test suite 45/45 + typecheck) |
| 2026.10.1 | 2026.10.15 | ✅ verified (2026-10-15 → 10-18, production TCP channel) |

Floor: OpenClaw ≥ 2026.10.1 (`peerDependencies`, install manifest; moved from ≥ 2026.5.26 in v2026.10.24 — the `runPassiveAccountLifecycle` replacement API does not exist on 2026.5.26). The floor moves only in a minor release with a changelog callout.

## Transports

| Transport | Status | Notes |
|---|---|---|
| TCP (port 4403) | ✅ verified daily | Production path. Client-side AES-CTR decryption of mesh packets works out of the box. |
| HTTP (port 4433, node API) | 🟡 expected | **Broken before v2026.10.19**: `normalizeMeshtasticTransport` silently rewrote `http` → `tcp`, so no HTTP config ever reached the HTTP path. Fixed in 2026.10.19; the probe and fallback logic are test-covered, but we have not run a production HTTP node yet. Requires the node's HTTP API enabled in firmware settings. |
| USB serial | 🟡 expected | Code path shared with TCP after connect; untested by us. serial2tcp bridges benefit from the v2026.10.19 probe fallback (OPTIONS → GET on 404/405). |

## Node firmware

| Device | Firmware | Status | Notes |
|---|---|---|---|
| ESP32-class node (WiFi) | Meshtastic firmware, current stable line | ✅ verified as the gateway's node | Daily production over TCP 4403: DM two-way, channel traffic, decryption. Exact board/firmware version not pinned here — see gateway logs. |
| Remote handhelds/other nodes | Meshtastic firmware | ✅ verified as peers | Inbound channel + DM traffic observed in production. |

## Known interop quirks

- **Mid-session TCP drop (before 2026.10.18):** the monitor never rejected its lifecycle promise, so the gateway health-monitor stayed blind and the channel went dark indefinitely. Fixed and lifecycle-test-pinned in 2026.10.18.
- **HTTP transport selection (before 2026.10.19):** silently became TCP — see Transports above.
- **Port confusion 4403 vs 4433:** TCP is the protobuf stream, HTTP is the node web API (and must be enabled on the node). The plugin cannot detect a swapped port; symptoms look like anything except a wrong port.
- **TCP ciphertext:** `@meshtastic/core` does not decrypt TCP/serial payloads; this plugin does it client-side. A raw TCP client without that layer shows ciphertext — expected, not a bug.
- **Outbound `target` shape:** v2026.10.18 mapped the send result `target` to the structured SDK shape (`{ kind, id }`) — required for clean operation against the OpenClaw 2026.10.1 SDK types.
