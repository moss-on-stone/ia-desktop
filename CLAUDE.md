# IA Desktop — project instructions

## After fixing anything: bump, commit, rebuild, RELEASE

Whenever a bug is fixed, an issue is resolved, or a change is verified working,
ALWAYS do all of the following, in order, without being asked:

1. **Bump** the version by 0.0.1 (patch) in `package.json` (`version`). The
   `USER_AGENT` is now **derived** from this version in
   `src/shared/constants.js`, so there is no second string to keep in sync (L7).
   Verify nothing else hardcodes the old version: `ggrep -rn "<old-version>"
   package.json src/`.
2. **Commit** the change (only after the test suite passes — `npm test`).
   End commit messages with the required Co-Authored-By trailer.
3. **Rebuild** the macOS installers locally so `dist/` reflects the new version:
   `npx electron-builder --mac`. Clean stale artifacts first (`rm -f
   dist/*.dmg dist/*.blockmap; rm -rf dist/mac dist/mac-arm64`) so old-version
   DMGs don't linger. This local `--mac` build is just a dev-time refresh of
   `dist/` for spot-checking the packaged app — it is NOT how releases ship.
4. **Release**: push `main`, then tag and push `v<version>` so the Release
   GitHub Action builds + publishes the installers (see below). **A version bump
   means a release** — every patch bump gets its matching `v*` tag; do not leave
   a bumped-but-unreleased version sitting on `main`. Concretely:
   ```bash
   git push origin main
   git tag v<version> && git push origin v<version>   # e.g. v0.1.31
   ```
   Then confirm the Action ran and the GitHub Release exists
   (`gh release list`). This is the ONE outward-facing step here, but it is part
   of the standard ritual — bumping without releasing is the bug this rule fixes.
   (If the user has explicitly said to hold the push/release for a later batch,
   honor that; otherwise release as part of the bump.)

> Note: bumping the version alone does NOT update `dist/` — the local installers
> must be rebuilt explicitly, or `dist/` keeps serving the old version.

> Note: the LOCAL `--mac` build is just for spot-checking; it does NOT publish a
> release. Only pushing the `v<version>` tag (step 4) ships the real installers.

> **Do NOT build `--win` locally.** Windows installers (and the official macOS
> ones) are produced by the **Release GitHub Action**, each on its NATIVE runner
> — no Wine / cross-compilation. See "Releases & installer builds" below. A
> local `electron-builder --win` on this Mac is not the supported path.

## Releases & installer builds (GitHub Actions)

Installers are built in CI, not by hand. Two workflows in `.github/workflows/`:

- **`release.yml`** — the canonical way to produce shippable installers. Triggers
  on a **`v*` tag push** (e.g. `v0.1.30`) or manual **`workflow_dispatch`**. It
  builds the **Windows `.exe`** on `windows-latest` and the **macOS `.dmg`s** on
  `macos-latest` (native runners), runs `npm test` as a guard first, and on a
  real tag push attaches the artifacts to a GitHub Release (`workflow_dispatch`
  builds the artifacts but does NOT publish a Release). Builds are **unsigned by
  default** (the macOS `.app` is ad-hoc signed via `build/adhoc-sign.js`); they
  become signed + notarized if the CI secrets `APPLE_API_KEY`/`APPLE_API_KEY_ID`/
  `APPLE_API_ISSUER` and `CSC_LINK`/`CSC_KEY_PASSWORD` are set (see README "Code
  signing & notarization"). The bundled "Read Me First" covers the unsigned
  OS warnings.
- **`ci.yml`** — runs the test suite + coverage on every push/PR to `main` across
  macOS/Windows/Linux × Node 18/20, plus a headless renderer self-test
  (`npm run selftest`) on macOS.

So the **release flow** is: bump + commit (steps 1–2 above) → push a `v<version>`
tag → the Release Action builds and publishes Windows + macOS installers. Don't
hand-build `--win`; tag instead (or trigger `release.yml` via `workflow_dispatch`
for installers without cutting a Release).

**Every version bump gets released** — pushing the `v<version>` tag is the normal
final step of the after-fix ritual (step 4 above), not a separate occasion to
wait for. A bumped version that never gets a tag is a mistake. The only time to
hold the tag is when the user has explicitly said to batch/defer the release; in
that case, release as soon as that hold is lifted. (A release publishes
installers publicly, so if anything is genuinely uncertain, confirm — but the
default for a clean, tested, bumped commit is: tag and release.)

## Red/green TDD (always)

This project uses strict red/green TDD for ALL coding, editing, fixing, and
enhancement (see the user's global CLAUDE.md). Write the test first, show it
fail (red), then implement until it passes (green). Never edit a test merely to
make it pass. For Electron-glue or UI logic that's awkward to unit-test,
extract the decision logic into a pure, importable module and test that.

- Test runner: `npm test` (Node's built-in `node --test`, no third-party deps).

## Verifying the UI yourself

Don't ask the user for screenshots — capture the real window yourself:

```bash
scripts/screenshot.sh [output.png]      # headless capture of the live window
```

It uses the app's `--screenshot=<path>` flag, which is gated behind `--dev`
(H3 — the file-write must never be reachable in a normal production launch), so
the wrapper passes `--dev` for you (see `docs/readme-screenshot.md`).
Capture the **packaged** app too when verifying a release (pass `--dev` so the
screenshot path is honored):
`"dist/mac-arm64/IA Desktop.app/Contents/MacOS/IA Desktop" --dev --screenshot=<path>`.

## archive.org compliance (non-negotiable — go above and beyond)

This app is a good citizen of archive.org. Treat the
[automated-access guidelines](https://archive.org/developers/bots.html) as a
floor, not a ceiling — when in doubt, do the more respectful thing. These rules
are binding on ALL future changes; never weaken them for convenience:

1. **Identify ourselves on EVERY request.** Every outbound call to archive.org
   MUST send the descriptive `User-Agent` from `src/shared/constants.js`
   (`IA-Desktop/<version> (+https://github.com/moss-on-stone/ia-desktop)` —
   tool, version, and a public identification/contact URL). Never issue a
   request that bypasses this header. **No personal contact info** in the UA
   (per the user's privacy rule) — the repo's issue tracker is the contact path.
2. **Honor throttling.** On `429`/`503`/`500`, retry with exponential backoff +
   jitter AND obey the server's `Retry-After` header when present (we never wait
   *less* than archive.org asked). Logic: `retryDelay`/`parseRetryAfter` in
   `src/main/download-queue.js`; `IAError.retryAfter` carries the header.
3. **Retry idempotent GETs, not writes.** `ia-client.request()` auto-retries
   GETs (search/metadata/scrape/tasks) via `withRetry`; POSTs (login, metadata
   writes, uploads) are NOT auto-retried.
4. **Stay gentle by default.** Downloads run **one at a time**
   (`DOWNLOAD_CONCURRENCY = 1` in `ipc-handlers.js`) with a user-configurable
   inter-item pause (`downloadDelaySec`). Don't raise concurrency or remove the
   delay without a deliberate, documented reason.
5. **Prefer bulk endpoints** for large listings (the scrape API), not thousands
   of individual calls.

When adding any new archive.org interaction, the checklist is: sends the UA?
honors 429/503 + Retry-After? idempotent-only retry? bounded concurrency?
covered by a test? If you can't tick all five, it's not done.

## Architecture notes

- Pure logic lives in testable modules: `src/main/ia-core.js`,
  `src/main/menu-template.js`, `src/renderer/ui-util.js`. Prefer adding logic
  there (with tests) over inlining it in Electron glue.
- Networked client: `src/main/ia-client.js` (no third-party deps; Node
  fetch/https only — keeps the install small).
- Security posture: contextIsolation on, nodeIntegration off, strict CSP in the
  renderer, all privileged work behind IPC. Preserve this.
