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
- **Board**, showing one project's version (on Home, see below):
  - Opens on the project's current version: the oldest one not marked complete. Other open versions, a collapsible "Completed versions" list and "+ New version" sit alongside it.
  - Columns are TODO, In Progress and Done. Won't fix, Out of scope and Bumped count as done and appear in Done with a resolution badge.
  - Version notes are markdown.
  - "Mark complete" offers to bump any open tasks to the next version, or to complete anyway. Completed versions are read-only until reopened.
  - An "Unscheduled" drawer lists tasks not in any version.
  - A sync pill shows pending changes and has "Sync now".
- Cards show the task type, resolution and subtask progress (e.g. 2/3). The card dialog edits the description and subtasks as markdown, changes type and resolution, and bumps the task to the next version, creating that version if needed.
- Project, version and task descriptions, and task subtasks, are markdown everywhere. Tables show them rendered and trimmed to a few lines. In edit forms each field has its own editor with Save/Cancel.
- The template showcase banner on Home is gone.
- Open pages refresh live after local edits, edits in other tabs (BroadcastChannel), and syncs that pulled changes.
- **Home is the board.** `/` shows your recently added, updated and viewed issues across all projects above the board. "Recent issues on Home" in Preferences sets how many (default 6, 0 hides them) and syncs; which issues you viewed is kept per device. Moving a card to another column counts as an update; reordering doesn't. The Tables section and Home's project creation are gone, and `/board/` redirects to `/` keeping its query.
- Opening an issue from Home, the command palette, or a link like `/?project=…&version=…&task=…` opens its card dialog on the board in the version it's being worked on. Unscheduled tasks open in the task editor (`/task/?edit=<id>`).
- Floating **+** button on every page: New Task, New Version, New Project. Task and version forms prefill the board's current project and version. New Project can also create version 0.1.0.
- **Ctrl/Cmd+K command palette** creates tasks, versions and projects, jumps to recent or matching tasks, projects and versions, and opens the overview pages. It works while typing in editors.
- The navbar now shows only Home, Preferences and Settings; the overview pages (Project, Version, Task, Version task, Assets) are in the command palette.
- **Schema change** (server migration v3, IndexedDB v4): `preferences.recent_issues_count`, backfilled to 6 on existing servers, devices and old backups without re-pushing.
- **Markdown editor replaced by notey's**:
  - A Formula tool: a visual MathLive editor with a matrix picker and an "on its own line" option.
  - Formulas in the rich-text canvas are edited in place by double-clicking.
  - Tool keys: Formula Alt+F, Diagram Alt+M, Draw Alt+E, Footnotes Alt+0. They're shown on the toolbar and can be rebound per device in Settings, but not onto a key the app already uses.
  - While an editor is open, the command palette offers "Insert a formula / diagram / drawing / footnote".
- The command palette shows each create action's keybind.
- **Keyboard shortcuts everywhere**:
  - Ctrl+Enter opens the + menu.
  - Ctrl+N (or Alt+N) opens New Task, and Ctrl+Shift+P (or Alt+Shift+P) opens New Project. Browsers keep Ctrl+N (and Firefox keeps Ctrl+Shift+P) in a normal tab; they work when planee is installed as an app.
  - Ctrl+Shift+V opens New Version, except in a text field, where it still pastes as plain text.
- **Board shortcuts**:
  - Ctrl+1/2/3 open New Task set to TODO / In Progress / Done. The form gains a "Starts in" status.
  - Ctrl+Shift+1/2/3 focus the first card in that column.
  - Ctrl+4 opens the project picker.
  - Ctrl+Shift+C starts "Mark complete", and Ctrl+Shift+E edits the version.
- **Cards can take keyboard focus.** Tab/PageDown and Shift+Tab/PageUp move between cards, continuing into the next column. Ctrl+↑/↓ reorder a card and Ctrl+←/→ move it between columns, going through the same path and sync as a drag. Ctrl+E or Enter opens the card.
- New **Edit version** dialog and board button: change a version's number (with a warning on duplicates) and its notes.
- **Hold Ctrl** for about half a second to see key badges on the controls and a cheat sheet for the page. Each item shows the fallback key unless the app is installed.
- "Show the shortcut cheat sheet when holding Ctrl" in Preferences (on by default, synced) hides the cheat sheet but keeps the key badges. Open pages pick up the change without a reload, including from another device.
- **Schema change** (server migration v4, IndexedDB v5): `preferences.show_keybind_sheet`, backfilled to on for existing servers, devices and old backups without re-pushing.

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
- The service worker no longer freezes page loads for about 30 seconds after it first installs. Activation used to wait for the whole paced offline crawl; the crawl now runs in the background.
- Onboarding on the GitHub Pages / offline-default build now requires a server URL before choosing "Sync with a server". An empty URL there pointed sync at the static host, so every sync failed.
- Prices like "$5 and $10" are no longer rendered as maths, in the editor or the preview.
- Escape in a formula, diagram, footnote or drawing dialog no longer closes the card or create dialog around it.
- Citing a selected sentence as a footnote keeps the sentence. Toggling or saving footnotes no longer drops the last fraction of a second of typing.
- A card dialog with a long description, a drawing or an open editor grew past the bottom of the screen, hiding Save and Close. It is now capped at the screen height and its body scrolls.
- **Security:** formulas can't set styles, ids, links or data attributes on the page. MathLive's `style`, `cssId`, `href`, `htmlData` and friends, and unsafe colour, font and box values, are stripped before typesetting, and the output is filtered again.
- Ctrl+S and Escape in a markdown field inside the board's card dialog were ignored, because the field treated any enclosing dialog as one of the editor's own sub-dialogs.
- Preferences saves only the fields you changed, so an edit to another preference on a different device is kept.
- Pressing Escape in a markdown editor inside the card dialog and answering "No" to "Discard your changes?" no longer closes the dialog and throws away the text you chose to keep.

## Other

- Math renders with MathLive everywhere (preview, table cells and editor), using fonts shipped with the app in `public/math/` and precached for offline use (`npm run copy:math-assets` refreshes them). KaTeX, `rehype-katex` and the KaTeX font PostCSS step are removed. The offline crawl is now 276 fetches, under its cap of 324.
- New shared keyboard modules: `lib/ui/keys.ts` (chord parsing, matching and display), `lib/ui/keymap.ts` (every app keybind as data), `lib/ui/keybinds.ts` (one capture-phase dispatcher with scope, typing and modal gating), and `lib/board/keyboard.ts`. Keyboard card moves share a commit path with pointer and grip drops.
- The sync harness can build into other folders (`PLANEE_DIST_DIR`, `PLANEE_BIN_DIR`), so parallel runs don't collide. New specs: `editor-ui.spec.ts` and `keybinds-ui.spec.ts`, plus a card-dialog height regression test.
- The Project, Version and Task overview pages share new create-form components (`components/forms/`) with the + button, and refresh live when rows change. Tasks created from a form go to the top of TODO in the versions they're scheduled in.
- UI tests now use Home (`/`) and the + button and check that `/board/` redirects with its query. A new `navigation-ui.spec.ts` covers the slim navbar, the + button's create dialogs, the command palette (including Ctrl+K inside editors), `?task=` deep links, the recent-issues strip and its synced count, and Ctrl+S/Escape inside the card dialog.
- KanbanBoard gains `openCardId`, `onDialogOpen` and `onDialogClose`. The board logic moved from `BoardApp` into `components/board/Board.svelte`. New helpers: `lib/ui/{recent,links,commands,palette,recentIssues}.ts`, all unit-tested.
- The offline bundle for the editor is trimmed from 422 to 230 files: Shiki and CodeMirror use a language shortlist, KaTeX ships woff2 only, and Excalidraw is English-only. The service worker's warm crawl now only follows relative paths that name `.js`/`.css` files, so strings in bundled libraries that merely look like paths no longer cost 404 fetches. `src/lib/sw.test.ts` checks that the precached font list matches the files on disk.
- The service worker's warm-crawl cap is sized from the real build: 259 fetches, cap 324. The new `tests/sync/sw-crawl.spec.ts` replays the crawl against the production build, using the patterns read from `sw.js`, and fails if an asset becomes unreachable, the crawl requests missing paths, or the bundle outgrows the cap. The Excalidraw fonts are now seeded into the crawl.
- New real-UI sync tests (`board-ui.spec.ts`, `markdown-ui.spec.ts`), run against two devices and checked on all four legs: the composer, pointer drags, a concurrent drag and rename, the live change feed, resolutions kept when reordering in Done, bump, completing and reopening a version (read-only while complete), unscheduled tasks, delete tombstones, Source-tab editing that renders sanitised on a second device, the overwrite warning, and a synced image. A fourteenth sabotage case (a stale whole-card snapshot over a drag) proves these checks can fail. The test hook gains `saveAsset` (test mode only).
- New internal modules: `lib/db/changes.ts` (change feed), `lib/versions.ts` (version ordering, e.g. `0.9.0 < 0.10.0`, and next-number suggestions), and `lib/board/adapter.ts` + `actions.ts` (pure, unit-tested board logic executed through `repo.ts`).
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
