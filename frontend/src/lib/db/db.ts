/**
 * IndexedDB connection + versioned migrations.
 *
 * MIGRATIONS is an ordered list of upgrade functions, one per version, run in
 * sequence from the client's current version. Never edit an existing
 * migration once shipped — append a new one, and change
 * backend/sql/schema.sql in lockstep.
 */
import { openDB, type IDBPDatabase, type IDBPTransaction } from 'idb';
import { ENUM_SEEDS, ENUM_SEED_UPDATED_AT, STORES } from './types';
import { V3_DEFAULTS, V4_DEFAULTS, V5_DEFAULTS, backfillV3, backfillV4, backfillV5 } from './backfill';

export const DB_NAME = 'planee';

type UpgradeTx = IDBPTransaction<unknown, string[], 'versionchange'>;

/**
 * One schema step. May be async, but must await ONLY IndexedDB requests on
 * `tx`: the upgrade transaction auto-commits as soon as nothing is pending on
 * it, so awaiting anything else (fetch, a timer, another database) lets it
 * close under the migration and the next request throws.
 */
type Migration = (db: IDBPDatabase, tx: UpgradeTx) => void | Promise<void>;

/**
 * Write an enum store's declared values as rows. Deterministic on purpose: the
 * key is the id and updated_at is a constant, so every device (and the server,
 * via schema.sql) holds byte-identical rows and none of them ever needs to
 * sync. Re-runnable — `put` by id — so a later migration can call it again
 * after the value list changes.
 */
function seedEnum(
  store: { put(value: unknown): unknown },
  name: string
): void {
  (ENUM_SEEDS[name] ?? []).forEach((value, position) => {
    store.put({
      id: value.key,
      label: value.label,
      position,
      updated_at: ENUM_SEED_UPDATED_AT,
      deleted_at: null,
      server_seq: null,
    });
  });
}

const MIGRATIONS: Migration[] = [
  // v1 — create every object store and its indexes from the STORES map, and
  // seed the enum stores from ENUM_SEEDS.
  (db) => {
    for (const [name, def] of Object.entries(STORES)) {
      const store = db.createObjectStore(name, { keyPath: 'id' });
      for (const idx of def.indexes) {
        store.createIndex(idx.name, idx.name, { multiEntry: idx.multiEntry ?? false });
      }
      if (def.enum) seedEnum(store, name);
    }
  },
  // v2 — local-only sync bookkeeping. Deliberately NOT in STORES: neither
  // store is ever synced or included in a backup.
  //   sync_meta   — the pull cursor, the server epoch, last sync/error.
  //   sync_outbox — rows changed here that the server has not confirmed yet.
  //                 An explicit queue, not a timestamp watermark: see
  //                 db/outbox.ts for why the watermark version loses writes.
  (db) => {
    db.createObjectStore('sync_meta', { keyPath: 'key' });
    db.createObjectStore('sync_outbox', { keyPath: 'key' });
  },
  // v3 — project names, task titles/types, per-version status and board
  // position, version description/completion, per-field merge on the four data
  // stores, the synced asset store, and the lookup indexes. Server side: the
  // v2 migration in backend/db.go.
  //
  // Every structural change is GUARDED. v1 builds stores and indexes from the
  // CURRENT `STORES` map, so on a fresh install v1 has already created `asset`
  // and every index below, and an unguarded create throws ConstraintError.
  // The lists are spelled out rather than read from STORES so this step stays
  // what it was when it shipped.
  async (db, tx) => {
    if (!db.objectStoreNames.contains('asset')) {
      db.createObjectStore('asset', { keyPath: 'id' });
    }
    const indexes: [store: string, index: string][] = [
      ['version', 'project'],
      ['task', 'project'],
      ['version_task', 'version'],
      ['version_task', 'task'],
    ];
    for (const [store, index] of indexes) {
      const os = tx.objectStore(store);
      if (!os.indexNames.contains(index)) os.createIndex(index, index, { multiEntry: false });
    }

    // Backfill rows that predate the new fields, with the same values the
    // server's ALTER TABLE DEFAULTs give its copies of them — so both sides
    // agree without a push. Deliberately NOT through repo.ts: no updated_at
    // restamp (an upgrade is not an edit, and a fresh stamp would beat a real
    // newer edit on another device) and no outbox entry (nothing changed that
    // the server does not already have). Tombstones are upgraded too; they
    // still sync and back up.
    for (const store of Object.keys(V3_DEFAULTS)) {
      let cursor = await tx.objectStore(store).openCursor();
      while (cursor) {
        const upgraded = backfillV3(store, cursor.value as Record<string, unknown>);
        if (upgraded) await cursor.update(upgraded);
        cursor = await cursor.continue();
      }
    }
  },
  // v4 — preferences.recent_issues_count (how many recent issues Home lists).
  // Server side: the v3 migration in backend/db.go. No store or index changes,
  // only a row backfill under the same rules as v3: no restamp, no outbox
  // entry, tombstones included. Guarded like v3's structural steps: the store
  // exists on every install that reaches here (v1 or v3 created it), but a
  // missing store must not abort the whole upgrade.
  async (db, tx) => {
    for (const store of Object.keys(V4_DEFAULTS)) {
      if (!db.objectStoreNames.contains(store)) continue;
      let cursor = await tx.objectStore(store).openCursor();
      while (cursor) {
        const upgraded = backfillV4(store, cursor.value as Record<string, unknown>);
        if (upgraded) await cursor.update(upgraded);
        cursor = await cursor.continue();
      }
    }
  },
  // v5 — preferences.show_keybind_sheet (whether holding Ctrl shows the
  // shortcut cheat sheet). Server side: the v4 migration in backend/db.go.
  // A row backfill only, under exactly v4's rules.
  async (db, tx) => {
    for (const store of Object.keys(V5_DEFAULTS)) {
      if (!db.objectStoreNames.contains(store)) continue;
      let cursor = await tx.objectStore(store).openCursor();
      while (cursor) {
        const upgraded = backfillV5(store, cursor.value as Record<string, unknown>);
        if (upgraded) await cursor.update(upgraded);
        cursor = await cursor.continue();
      }
    }
  },
];

export const DB_VERSION = MIGRATIONS.length;

let dbPromise: Promise<IDBPDatabase> | null = null;

export function getDB(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      // Steps run strictly in order, each awaited, so an async step finishes
      // before the next one sees the stores. A failing step aborts the whole
      // upgrade: the database stays at its old version and openDB rejects
      // (AbortError), rather than committing a half-migrated schema under the
      // new number. (idb does not await this callback, so the error is
      // reported here and surfaced through the abort, not rethrown.)
      async upgrade(db, oldVersion, _newVersion, tx) {
        try {
          for (let v = oldVersion; v < MIGRATIONS.length; v++) {
            await MIGRATIONS[v]!(db, tx);
          }
        } catch (err) {
          console.error('[planee db] migration failed, aborting upgrade', err);
          try {
            tx.abort();
          } catch {
            // already finished or aborted
          }
        }
      },
    });
  }
  return dbPromise;
}
