/**
 * CRUD helpers over IndexedDB — the ONLY sanctioned write path.
 *
 * Rules these helpers enforce, each of which is a data-loss bug when broken:
 *
 *  1. Reads filter tombstones; deletes are soft, so deletions propagate.
 *  2. Writes stamp updated_at (the conflict-resolution field) and queue the
 *     row for sync. A write that bypasses this is a change that never leaves
 *     this device.
 *  3. `patch` re-reads the row FRESH before changing it. Writing a row built
 *     from a UI snapshot silently reverts anything that changed underneath —
 *     a pulled edit, another tab, an async handler that started earlier.
 *  4. `putReconciled` never stamps `now`. Dedup/heal/fold passes re-save
 *     existing content; stamping a fresh timestamp on unchanged content makes
 *     it beat a genuinely newer edit elsewhere, and resurrects rows another
 *     device just deleted.
 *
 * Every write ends with requestSync(): a debounced "sync soon". Without it the
 * only automatic sync is on page load, so a change made here stays invisible to
 * other devices for minutes — the most-reported local-first symptom — and every
 * conflict window stays open far longer than it needs to.
 */
import { getDB } from './db';
import { enqueueIn, OUTBOX_STORE } from './outbox';
import { STORES } from './types';
import type { StoreName, SyncFields } from './types';
import { requestSync } from '../sync';

export const newId = (): string => crypto.randomUUID();
export const nowIso = (): string => new Date().toISOString();

/**
 * Enum stores are read-only in the app: their rows come from ENUM_SEEDS in
 * db.ts, identical on every device, and are never synced or backed up. A write
 * here would exist on this device only — and be silently dropped by the next
 * migration that re-seeds. Fail loudly instead.
 */
function assertWritable(store: StoreName): void {
  if (STORES[store]?.enum) {
    throw new Error(
      `${store} is an enum store: its values are fixed in the schema (types.ts ENUM_SEEDS), not editable data`
    );
  }
}

/**
 * Rows must survive IndexedDB's structured clone, but Svelte 5 `$state`
 * values are Proxies, which structured clone REJECTS with DataCloneError — so
 * a component passing reactive state into a row (e.g. an array of selected
 * ids, or a whole row read back from a `$state` list) makes `put` reject,
 * silently in fire-and-forget handlers. Rows are JSON-shaped by design (they
 * sync as JSON), so a JSON round-trip both strips reactivity and guarantees
 * clonability. Cheap relative to the IndexedDB write it precedes.
 */
function toPlain<T>(row: T): T {
  return JSON.parse(JSON.stringify(row)) as T;
}

/** Attach generated id + sync fields to a new entity. */
export function withSyncFields<T extends object>(fields: T): T & SyncFields {
  return {
    id: newId(),
    updated_at: nowIso(),
    deleted_at: null,
    server_seq: null,
    ...fields,
  };
}

/**
 * Stamp `at` against the named fields on a field-merged store, preserving
 * every other field's existing stamp. No-op on ordinary stores.
 */
function stampFields<T extends SyncFields>(
  store: StoreName,
  row: T,
  changed: Iterable<string>,
  at: string
): T {
  if (!STORES[store]?.fieldMerge) return row;
  const stamps: Record<string, string> = { ...(row.field_updated_at ?? {}) };
  for (const field of changed) {
    if (field === 'id' || field === 'server_seq' || field === 'field_updated_at') continue;
    stamps[field] = at;
  }
  return { ...row, field_updated_at: stamps };
}

export async function all<T extends SyncFields>(store: StoreName): Promise<T[]> {
  const rows = (await (await getDB()).getAll(store)) as T[];
  return rows.filter((r) => !r.deleted_at);
}

export async function get<T extends SyncFields>(
  store: StoreName,
  id: string
): Promise<T | undefined> {
  const row = (await (await getDB()).get(store, id)) as T | undefined;
  return row && !row.deleted_at ? row : undefined;
}

export async function byIndex<T extends SyncFields>(
  store: StoreName,
  index: string,
  value: IDBValidKey
): Promise<T[]> {
  const rows = (await (await getDB()).getAllFromIndex(store, index, value)) as T[];
  return rows.filter((r) => !r.deleted_at);
}

/**
 * Insert or replace a whole row, stamping updated_at. Returns the stamped row.
 *
 * Prefer `patch` for edits to an EXISTING row: `put` writes every field, so
 * the object you pass had better be current. Reserve `put` for rows you just
 * built (withSyncFields) or read moments ago in the same handler.
 */
export async function put<T extends SyncFields>(store: StoreName, row: T): Promise<T> {
  assertWritable(store);
  const at = nowIso();
  const stamped = toPlain(stampFields(store, { ...row, updated_at: at }, Object.keys(row), at));
  const db = await getDB();
  const tx = db.transaction([store, OUTBOX_STORE], 'readwrite');
  tx.objectStore(store).put(stamped);
  enqueueIn(tx, store, stamped.id, at);
  await tx.done;
  requestSync();
  return stamped;
}

/**
 * Change specific fields of an existing row.
 *
 * THIS IS THE DEFAULT EDIT PATH. It re-reads the row from the store first, so
 * the write is built from what is actually stored right now, not from whatever
 * the component was rendering when the user clicked. A whole-row write built
 * from a stale snapshot reverts every field that changed in between — most
 * often an edit that just arrived from another device, which is then pushed
 * back out as if it were a deliberate change.
 *
 * On field-merged stores only the named fields get a fresh per-field stamp, so
 * a concurrent edit to a DIFFERENT field on another device survives.
 *
 * Returns undefined when the row is gone or tombstoned (edit a deleted row and
 * nothing happens rather than resurrecting it).
 */
export async function patch<T extends SyncFields>(
  store: StoreName,
  id: string,
  changes: Partial<Omit<T, keyof SyncFields>>
): Promise<T | undefined> {
  assertWritable(store);
  const db = await getDB();
  const tx = db.transaction([store, OUTBOX_STORE], 'readwrite');
  const current = (await tx.objectStore(store).get(id)) as T | undefined;
  if (!current || current.deleted_at) {
    await tx.done;
    return undefined;
  }
  const at = nowIso();
  const next = toPlain(
    stampFields(store, { ...current, ...changes, updated_at: at } as T, Object.keys(changes), at)
  );
  tx.objectStore(store).put(next);
  enqueueIn(tx, store, id, at);
  await tx.done;
  requestSync();
  return next;
}

export async function bulkPut<T extends SyncFields>(store: StoreName, rows: T[]): Promise<T[]> {
  assertWritable(store);
  const db = await getDB();
  const at = nowIso();
  const stamped = rows.map((r) => toPlain(stampFields(store, { ...r, updated_at: at }, Object.keys(r), at)));
  const tx = db.transaction([store, OUTBOX_STORE], 'readwrite');
  for (const row of stamped) {
    tx.objectStore(store).put(row);
    enqueueIn(tx, store, row.id, at);
  }
  await tx.done;
  requestSync();
  return stamped;
}

/**
 * Re-save a row whose CONTENT you did not author: duplicate folds, healers,
 * migrations, anything that recomputes a row from rows that already exist.
 *
 * It preserves the content's real updated_at instead of stamping now. Stamping
 * now on unchanged content is one of the widest silent-data-loss channels
 * there is: the restamped row then beats another device's genuinely newer edit
 * under last-write-wins, and beats a tombstone another device just wrote — so
 * a "harmless" cleanup pass reverts real edits and resurrects deleted rows.
 *
 * Pass the maximum updated_at of every row that fed the result as `contentAt`.
 * The row is still queued for sync, because its timestamp alone would not tell
 * the server anything changed.
 */
export async function putReconciled<T extends SyncFields>(
  store: StoreName,
  row: T,
  contentAt: string
): Promise<T> {
  assertWritable(store);
  const preserved = toPlain({ ...row, updated_at: contentAt });
  const db = await getDB();
  const tx = db.transaction([store, OUTBOX_STORE], 'readwrite');
  tx.objectStore(store).put(preserved);
  enqueueIn(tx, store, preserved.id, contentAt);
  await tx.done;
  requestSync();
  return preserved;
}

/**
 * Deterministic winner when two devices independently created rows that should
 * have been one (the classic "logical singleton with a random id" duplicate).
 *
 * Byte order on the id, NOT localeCompare: locale-aware comparison orders
 * strings differently under different locales, so two devices pick DIFFERENT
 * survivors, each tombstones the other's, and the fold ping-pongs forever.
 */
export function canonicalRow<T extends SyncFields>(rows: T[]): T | undefined {
  return [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
}

/**
 * Fixed id for single-row ("settings-style") tables. Do NOT create such rows
 * with withSyncFields(): that mints a random UUID per device, so every device
 * creates its own copy — after sync the table holds one row per device and
 * reads like `(await all('user_settings'))[0]` become nondeterministic.
 * Writing under one fixed id makes every device converge on the same row.
 */
export const SINGLETON_ID = 'singleton';

/** Read the one row of a single-row table (undefined until first write). */
export async function getSingleton<T extends SyncFields>(
  store: StoreName
): Promise<T | undefined> {
  return get<T>(store, SINGLETON_ID);
}

/**
 * Upsert the one row of a single-row table under the fixed id. Preserves the
 * existing row's server_seq (so sync bookkeeping survives) and clears any
 * tombstone — writing settings revives the row.
 *
 * Only the fields you pass are written, and on a field-merged store only those
 * fields are re-stamped: changing the theme on one device and the reminder time
 * on another no longer costs you one of the two.
 */
export async function putSingleton<T extends object>(
  store: StoreName,
  fields: T
): Promise<T & SyncFields> {
  assertWritable(store);
  const db = await getDB();
  const at = nowIso();
  const tx = db.transaction([store, OUTBOX_STORE], 'readwrite');
  const existing = (await tx.objectStore(store).get(SINGLETON_ID)) as SyncFields | undefined;
  const row = toPlain(
    stampFields(
      store,
      {
        ...(existing ?? {}),
        ...fields,
        id: SINGLETON_ID,
        updated_at: at,
        deleted_at: null,
        server_seq: existing?.server_seq ?? null,
      } as T & SyncFields,
      Object.keys(fields),
      at
    )
  );
  tx.objectStore(store).put(row);
  enqueueIn(tx, store, SINGLETON_ID, at);
  await tx.done;
  requestSync();
  return row;
}

export async function softDelete(store: StoreName, id: string): Promise<void> {
  assertWritable(store);
  const db = await getDB();
  const at = nowIso();
  const tx = db.transaction([store, OUTBOX_STORE], 'readwrite');
  const row = (await tx.objectStore(store).get(id)) as SyncFields | undefined;
  if (!row || row.deleted_at) {
    await tx.done;
    return;
  }
  tx.objectStore(store).put(
    stampFields(store, { ...row, deleted_at: at, updated_at: at }, ['deleted_at'], at)
  );
  enqueueIn(tx, store, id, at);
  await tx.done;
  requestSync();
}

export async function softDeleteMany(store: StoreName, ids: string[]): Promise<void> {
  assertWritable(store);
  const db = await getDB();
  const at = nowIso();
  const tx = db.transaction([store, OUTBOX_STORE], 'readwrite');
  for (const id of ids) {
    const row = (await tx.objectStore(store).get(id)) as SyncFields | undefined;
    if (row && !row.deleted_at) {
      tx.objectStore(store).put(
        stampFields(store, { ...row, deleted_at: at, updated_at: at }, ['deleted_at'], at)
      );
      enqueueIn(tx, store, id, at);
    }
  }
  await tx.done;
  requestSync();
}
