# Changelog

All notable changes to planee are documented here, newest first. The
current version lives in [VERSION](VERSION); the bump procedure is described in
the README under "Versioning & releases".

Keep adding to the topmost heading while it says `(unreleased)`. Once it ships,
replace `(unreleased)` with the release date and start a new heading above it.

# 0.1.0 (unreleased)

## Features

## Bug Fixes

## Other

- Dependency audit: frontend and backend dependencies were already at their latest compatible versions (0 npm vulnerabilities). TypeScript stays on 6.x because TypeScript 7's native compiler doesn't expose the API `astro check` needs, and `@astrojs/check`/`@astrojs/svelte` only accept TypeScript ≤ 6. `modernc.org/sqlite` v1.58.0 is current and its pinned `modernc.org/libc` matches.
- Docker runtime image moved from Alpine 3.20 (end of life) to Alpine 3.24.
- New `Sync tests` GitHub Actions workflow runs backend `go vet`/`go test` and the frontend type check, unit tests and two-device sync harness on PRs, pushes to `master`, and nightly.
- Added Vitest unit tests (`npm run test:unit`) and a backend `db_test.go` smoke test. `npm test` now runs unit then sync tests.
- The `@emnapi/*` / `@napi-rs/wasm-runtime` packages are pinned as root dev dependencies with overrides, guarded by `src/lib/lockfile.test.ts`. Regenerating `package-lock.json` on Windows otherwise silently drops them and breaks `npm ci` on Linux.
- The "field nulled on the wire" sabotage case no longer skips when `project` has no nullable column; it targets any table that has one, so all 12 trust-gate faults actually run.
- Project generated with [local-sync-template](https://github.com/Descent098/local-sync-template) on 2026-09-14 — data model created (`project`, `version`, `task`, `version_task`, `task_type`, `preferences`, `status_type`).
