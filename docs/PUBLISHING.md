# Publishing to ClawHub

How this plugin is released to the ClawHub registry, written down on the day
of the fork's debut release (2026-10-18, `@fintlp/openclaw-meshtastic@2026.10.19`).
The contract below is the same one the meshcore sibling learned by rejection;
read it before the first publish attempt of any release — the registry's
inspector validates the packed artifact, not your intentions.

## Prerequisites

- The `clawhub` CLI on the publishing machine (`pnpm add -g clawhub`).
- A ClawHub account whose handle matches the package scope (ours: `@fintlp`),
  authenticated via `clawhub login` (device flow; `--no-browser` on headless
  boxes). Verify with `clawhub whoami`.

## The metadata contract (all required)

1. **Scope = owner.** Package name must be `@fintlp/openclaw-meshtastic`,
  mirrored in `openclaw.install.npmSpec` AND `openclaw.install.clawhubSpec`.
2. **Manifest display name.** Root `"name"` in `openclaw.plugin.json`
  (`scripts/sync-manifest.ts` preserves it; it only rewrites `channelConfigs`).
3. **Runtime entrypoints.** `openclaw.extensions`/`setupEntry` point at the
  TypeScript sources for dev, but `files` ships only `dist/**`. The built
  twins must be declared: `openclaw.runtimeExtensions: ["./dist/index.js"]`
  and `openclaw.runtimeSetupEntry: "./dist/setup-entry.js"`. Missing → publish
  blocked `package-entrypoint-missing`.
4. **Compat fields present:** `openclaw.compat.pluginApi`,
  `openclaw.build.openclawVersion`.
5. The `channel-env-vars` deprecation warning is INTENTIONAL while
  `minHostVersion` still needs the legacy field. Do not clean it up.

## Flow

```bash
git commit + push everything        # publish packages github:<owner>/<repo>@main
# version bump covers package.json AND npm-shrinkwrap.json
# (top-level name/version + packages[""].name/version — the shrinkwrap ships)
npm run sync-manifest && npm run build && npm test && npm run typecheck
clawhub package validate .          # expect PASS + only the intentional warning
clawhub package publish . --dry-run # verify payload files + source commit
clawhub package publish . --changelog "$(awk '/^## <VERSION>/{f=1;next} /^## /{f=0} f' CHANGELOG.md)"
```

- `--changelog` is the ONLY per-release text on the registry versions page —
  no retroactive edit exists. The versions page renders it as RAW markdown:
  asterisks and backticks display literally. Keep each release's CHANGELOG
  section plain enough to read with markup shown (emphasis by wording, code
  refs without backticks).
- After `git tag -a v<ver> -m …` + `git push --follow-tags`, cut the GitHub
  release with the same awk-extracted section as the body, then verify the
  body actually landed (`gh release view v<ver> --json body`).
- A blocked attempt triggers a ~46 s rate-limit reset — wait it out, never
  retry in a loop. Inspector reports land in `reports/` (gitignored).
- New releases stay off public install surfaces until automated security
  scans finish (registry review window — normal). Check with
  `clawhub package inspect @fintlp/openclaw-meshtastic`.

## Release rules (issue #62; verified 2026-11-18)

`dist/` is gitignored and `prepack` rebuilds it, the README ships in the package, and `clawhub package publish` reads the GitHub source on `main`. So:

1. **Tag the exact tested commit.** Never "tag HEAD" — take the SHA that was live-tested and tag that explicitly.
2. **Build in a clean worktree whose folder is named `openclaw-meshtastic`.** The bundler derives an identifier from the folder name. Verified: the same commit built in a folder called `other-name` differs from the `openclaw-meshtastic` build in exactly one file, `dist/index.js` (`openclaw_meshtastic_default` vs `other_name_default`). That is cosmetic, but it breaks a byte-exact comparison.
3. **Compare the built `dist/` with the code that was live-tested** (`diff -r`) before publishing. Expect zero differences.
4. **Publish before later docs changes reach `main`.** Docs-only commits landing between the tested commit and the publish ship in the package (the README is part of it) and make the published artifact differ from the tested one.

## After publish

- **Trust `provenance-invalid` is expected.** `openclaw plugins inspect` reports it for community-channel ClawHub plugins. Per the host code read on 2026.11.3 (`resolvePluginTrust`), only packages from the official catalog on the `official` channel are `trusted-official`; a community plugin cannot reach that state, and it does not clear when the scan passes. The signal to watch is the scan status: `clawhub package moderation-status @fintlp/openclaw-meshtastic`.

- The installed checkout on the gateway host
  (`~/.openclaw/plugins/openclaw-meshtastic`, remote name `fork`) syncs to the
  tag: `git fetch fork --tags && git checkout v<ver> && npm ci && npm run build`.
- **Docs-only releases: no gateway restart** — the running plugin reports the
  old version string until its next natural restart, behavior identical.
  Releases carrying code that changes OUR production path (TCP) get an
  owner-approved restart; code paths we don't run can ride the next natural
  restart.
- The catalog page's compatibility banner is computed registry-side at
  publish time; proving the current state needs a browser reload by a human
  (the banner is client-rendered; fetches of the page show README only).
