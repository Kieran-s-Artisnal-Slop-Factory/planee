# planee frontend

Local-first Astro + Svelte 5 app. IndexedDB is the source of truth; the Go
backend (../backend) is a sync target, not a dependency — the app works fully
offline.

## Develop

```sh
npm install
npm run dev
```

Point the app at a running backend in Settings (e.g. `http://localhost:8228`),
or leave the sync URL empty when the backend serves this build same-origin.

## Build

```sh
npm run build   # static output in dist/
```

Serve `dist/` with the backend via `STATIC_DIR=../frontend/dist go run .`.

## Test

```sh
npx astro check                   # type-check the app
npx playwright install chromium   # once
npm test
```

## Writing data

All writes go through `src/lib/db/repo.ts`. These are not style preferences;
each one is a silent-data-loss bug when ignored.

- **`patch(store, id, { field })` is the default edit.** It re-reads the row
  from the store and changes only the fields you name. `put` writes the whole
  row, and whichever device wrote last wins the WHOLE row, so a
  write built from a stale snapshot silently reverts an edit that arrived from
  another device — and then pushes the reversion out as if it were deliberate. Reserve `put` for rows you just built with
  `withSyncFields()`.
- **Never hard-delete.** `softDelete` writes a tombstone; a row that just
  disappears cannot be told apart from one that was never there, so it comes
  back on the next restore or pull.
- **Single-row tables use `getSingleton`/`putSingleton`.** Creating a
  "settings" row with `withSyncFields()` mints a fresh UUID on every device,
  and reads like `(await all('settings'))[0]` then become a coin flip.
- **Don't write while rendering.** Anything that mutates data as a side effect
  of a read — dedup-on-read, "heal", lazily backfilling a field — restamps rows
  the user never touched and beats another device\u2019s real edit.
  If you cannot avoid it, use `putReconciled(store, row, contentAt)`, which
  preserves the content's real timestamp instead of stamping now, and bail while `isSyncing()`.
- **Pick survivors by `id` byte order** (`canonicalRow`), never
  `localeCompare` — locale-aware ordering makes two devices choose different
  winners and fold back and forth forever.

## Architecture notes

- `src/lib/db/types.ts` — entity interfaces + object-store map. Mirrors
  `backend/sql/schema.sql` 1:1; change both together. Enum tables (`task_type`, `status_type`)
  keep their values in the `<NAME>_VALUES` consts here; they are seeded by
  `db.ts`, read-only in the app, and never synced or backed up.
- `src/lib/db/db.ts` — IndexedDB migrations (append-only, never edit shipped ones).
- `src/lib/db/repo.ts` — the only sanctioned write path (see below).
- `src/lib/db/outbox.ts` — the push queue: which rows the server has not
  confirmed yet.
- `src/lib/sync.ts` — the push/pull loop.
- `src/lib/db/export.ts` — JSON backup export/import.
- `tests/sync/` — the two-device sync harness. Run it (`npm test`) before
  believing a sync change works.
- Pages are thin Astro wrappers mounting one Svelte 5 root component with
  `client:only="svelte"`; state is component-local runes (`$state`/`$derived`).

Versions are pinned to ranges proven together (Astro 7 / Svelte 5 / idb 8);
major upgrades may change generated-code assumptions.
