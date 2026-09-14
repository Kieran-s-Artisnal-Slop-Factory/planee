# planee backend

Go sync server for the local-first frontend. SQLite storage (pure-Go driver,
no cgo), one binary.

## Run

```sh
go run .
```

Or run the whole app (backend + frontend on one origin) with the prebuilt
image, from the repo root:

```sh
docker compose up -d          # pulls ghcr.io/descent098/planee:latest
# …or build from source: docker compose -f docker-compose.build.yml up --build
```

Images are published to `ghcr.io/descent098/planee` by
`.github/workflows/docker.yaml`; see `DEPLOYMENT.md` at the repo root.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8228` | HTTP listen port |
| `DB_PATH` | `planee.db` | SQLite file location |
| `STATIC_DIR` | (unset) | Serve the built frontend from this directory |

## Endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /healthz` | Liveness probe |
| `POST /sync/push` | Accept client rows; last-write-wins on `updated_at`; stamps `server_seq` |
| `GET /sync/pull?since=<seq>` | Rows with `server_seq` above the cursor (tombstones included) |
| `GET /backup` | Download the SQLite file |
| `/` | Static frontend, when `STATIC_DIR` is set |

## Sync model

- Clients generate UUID ids and stamp `updated_at` (UTC ISO 8601) on every write.
- Push: the server keeps the newer row per id (string comparison on
  `updated_at`) and assigns `server_seq` from one global counter.
- Pull: clients send their high-water `server_seq` and receive everything newer.
- Deletes are soft (`deleted_at` tombstones) so they sync like any other write.
- Enum tables (`task_type`, `status_type`) are
  reference data: `sql/schema.sql` seeds them with the same ids every client
  seeds for itself, so they are absent from `tableOrder`/`tables` in
  `sync.go` — a push naming one is refused as unknown and a pull never
  carries one. Changing a value list means re-running the `INSERT OR IGNORE`
  seed against existing databases (and removing dropped rows by hand).

## Sync gotchas worth knowing

These are inherent to the last-write-wins + cursor design. The generated
client already handles the first three; the fourth is a product decision.

1. **Single-row (settings-style) tables must use a fixed id.** A row created
   with `withSyncFields()` gets a random UUID *per device*, so two devices make
   two non-merging rows and reads become nondeterministic. Use
   `getSingleton`/`putSingleton` from `frontend/src/lib/db/repo.ts` for any
   "one row for the whole account" table. (See the frontend README.)
2. **Switching sync servers resets local sync state.** `server_seq` values and
   the stored `lastPullSeq`/`serverEpoch` only mean anything relative to the
   server that issued them. `setSyncUrl()` calls `resetLocalSyncState()` when
   the URL changes: it drops both `sync_meta` keys, nulls every row's
   `server_seq`, and re-queues every local row, so the next sync re-pulls from
   scratch and re-pushes local data. Restoring a JSON backup in `replace` mode
   does the same. If you add another path that swaps the local dataset or
   server, call `resetLocalSyncState()` yourself — skipping either half is a
   silent permanent fork.
3. **Reactive values can't be stored directly.** IndexedDB structure-clones
   rows, and Svelte 5 `$state` proxies are unclonable (`DataCloneError`). The
   `put`/`bulkPut` helpers JSON round-trip rows (`toPlain`) so this never
   bites — keep new writes going through them rather than `getDB().put`.
4. **First connection to a server with existing data is a union-merge.** Point
   a device that already has local rows at a server that also has rows, and
   both datasets combine under last-write-wins (nothing is lost, but they
   mix). If you want to offer "keep this device / keep the server / merge"
   instead, add the `GET /sync/stats` (has-data probe) and `POST /sync/reset`
   (wipe server) endpoints to `sync.go` and drive them from onboarding —
   `resetLocalSyncState()` plus a server reset is the primitive you need.

## Evolving the schema

`sql/schema.sql` runs once on a fresh database (`PRAGMA user_version` guard).
When you change the schema, update **both** `sql/schema.sql` + the table
metadata in `sync.go`, and append a matching IndexedDB migration in
`frontend/src/lib/db/db.ts`. For an existing database, apply the change with
an `ALTER TABLE` migration of your own (or start from a fresh file and sync).
