# Changelog

All notable changes to planee are documented here, newest first. The
current version lives in [VERSION](VERSION); the bump procedure is described in
the README under "Versioning & releases".

Keep adding to the topmost heading while it says `(unreleased)`. Once it ships,
replace `(unreleased)` with the release date and start a new heading above it.

# 0.1.0 (unreleased)

## Features

- **Schema change** (server migration v2, IndexedDB v3). Existing rows are backfilled with identical defaults on the server and every client, so nothing is re-pushed.
  - Projects gain `name` and lose the free-text `version`.
  - Versions gain a markdown `description` and a `completed` flag.
  - Tasks gain `title` and `task_type` (default `feature`). Priority is now 1 Urgent to 4 Low, and new tasks default to 4.
  - Version–task links gain `status` (default `todo`) and `position`, so each version tracks its own board state.
  - A new synced `asset` table stores images and drawings as base64.
- Project, version, task and version–task edits now merge per field across devices. For example, moving a card on one device and editing its title on another keeps both changes.
- The backend migrates existing databases on startup, one transaction per step, and refuses a database created by a newer build.
- IndexedDB indexes on `version.project`, `task.project`, `version_task.version` and `version_task.task`.
- New Assets page lists synced images and drawings with a preview, size and used/unused badge. You can upload files (up to 5 MB each) and delete them, with a confirmation when an asset is still referenced.
- The Project, Version, Task and Version task pages edit the new fields: project names, version descriptions and completion, task titles, task types (defaulting to your preferred type), named priorities, and per-version status and board position.
- Kanban board component ported from retoken:
  - drag and drop with mouse, touch and keyboard
  - optimistic updates with retry/undo
  - search and a card dialog
  - host slots for card badges, the dialog body and dialog actions, configurable editor fields, and a `readonly` mode
- Markdown editing ported from retoken:
  - rich-text (Milkdown) and Source (CodeMirror) modes with a live preview
  - GFM, footnotes, KaTeX math, Shiki code highlighting, mermaid diagrams (with a diagram workbench), and Excalidraw drawings that reopen for editing
- `MarkdownField` shows rendered markdown with Edit / Save / Cancel (Ctrl+S / Esc) and warns before overwriting a change made on another device while you were editing.
- Pasted images and drawings are stored in the synced `asset` table as `assets/<uuid>.<ext>` (5 MB limit). Images this device doesn't have show a placeholder.
- The Excalidraw fonts (Excalifont, Nunito, Cascadia) are self-hosted and precached, so drawings render offline and nothing loads from esm.sh.
- GitHub Pages deploy of the frontend at https://kieranwood.ca/planee (`.github/workflows/pages.yaml`). That build defaults to offline mode (`PUBLIC_DEFAULT_SYNC_MODE=offline`); a sync server can still be set in Settings.
- Settings warns when an https page is given an `http://` sync URL, and explains when this copy of the app runs only in the browser.

## Bug Fixes

- A new row on a per-field-merge table no longer ends up with different `field_updated_at` stamps on the device that created it than on the server and other devices. The server now stores one stamp per column on insert, and the client no longer stamps `updated_at`.
- Importing a backup made before the schema change backfills the new fields instead of producing projects with no name.
- Creating a version inline from the Task form, or a task from the Version form, no longer creates it with no project. The Version task form's inline creation picks up the project too.
- Edits to rows that existed before the schema upgrade no longer overwrite a newer change to a different field made on another device. Fields with no per-field stamp now keep their real date instead of being re-dated to the time of the edit.
- Saving an edit form only writes the fields you changed, so it can't overwrite another device's edit to the others.
- Restoring deleted preferences now wins over the delete on other devices.
- Rendered markdown is sanitised. Raw HTML, event handlers, `javascript:` links and non-image `data:` URLs are removed, and mermaid runs in strict mode. Retoken's renderer passed raw HTML straight into the page.
- Kanban: reordering a card within a column no longer overwrites a status that column also accepts (e.g. `wontfix` in Done), and saving a card's other fields no longer changes its status.
- Pressing Escape inside the drawing canvas no longer closes the dialog and discards the drawing.

## Other

- The offline bundle for the editor is trimmed from 422 to 230 files: Shiki and CodeMirror use a language shortlist, KaTeX ships woff2 only, and Excalidraw is English-only. The service worker's warm crawl now only follows relative paths that name `.js`/`.css`/`.woff2` files, so strings in bundled libraries that merely look like paths no longer cost 404 fetches. `src/lib/sw.test.ts` checks that the precached font list matches the files on disk.
- `getSyncMode()` falls back to a build-time default when no mode is saved (unit tested). DEPLOYMENT.md gains a GitHub Pages section.
- `npm run check` now runs `svelte-check` as well as `astro check`, since `astro check` never type-checked `.svelte` files. Fixed the one error that surfaced: `HomeApp`'s initial sync status was missing `pending`.
- Migration tests: a frozen v1 fixture database migrates to the same tables, columns and foreign keys as a fresh one, apart from one documented difference (`task.priority`'s default). Also added push/pull type round-trip tests for booleans, floats and integers.
- The sync harness mirrors the new schema and now round-trips columns that reference enum tables instead of skipping them.
- Sync harness: new cases for concurrent per-field edits, exact float positions, a 1 MB asset, and a real upgrade of an old device and an old server holding the same data. A thirteenth sabotage case covers a whole-row write that clobbers a concurrent edit. New `backend/cmd/sqlexec` tool builds old-schema server databases for tests.
- Unit tests for the asset reference and CRUD form helpers.
- Documented how to add a backend migration (`backend/README.md`), and updated the schema lockstep lists in the README and TODO.
- Dependency audit: frontend and backend dependencies were already at their latest compatible versions (0 npm vulnerabilities). TypeScript stays on 6.x because TypeScript 7's native compiler doesn't expose the API `astro check` needs, and `@astrojs/check`/`@astrojs/svelte` only accept TypeScript ≤ 6. `modernc.org/sqlite` v1.58.0 is current and its pinned `modernc.org/libc` matches.
- Docker runtime image moved from Alpine 3.20 (end of life) to Alpine 3.24.
- New `Sync tests` GitHub Actions workflow runs backend `go vet`/`go test` and the frontend type check, unit tests and two-device sync harness on PRs, pushes to `master`, and nightly.
- Added Vitest unit tests (`npm run test:unit`) and a backend `db_test.go` smoke test. `npm test` now runs unit then sync tests.
- The `@emnapi/*` / `@napi-rs/wasm-runtime` packages are pinned as root dev dependencies with overrides, guarded by `src/lib/lockfile.test.ts`. Regenerating `package-lock.json` on Windows otherwise silently drops them and breaks `npm ci` on Linux.
- The "field nulled on the wire" sabotage case no longer skips when `project` has no nullable column; it targets any table that has one, so all 12 trust-gate faults actually run.
- Project generated with [local-sync-template](https://github.com/Descent098/local-sync-template) on 2026-09-14 — data model created (`project`, `version`, `task`, `version_task`, `task_type`, `preferences`, `status_type`).
