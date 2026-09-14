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

export const DB_NAME = 'planee';

type Migration = (
  db: IDBPDatabase,
  tx: IDBPTransaction<unknown, string[], 'versionchange'>
) => void;

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
];

export const DB_VERSION = MIGRATIONS.length;

let dbPromise: Promise<IDBPDatabase> | null = null;

export function getDB(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion, _newVersion, tx) {
        for (let v = oldVersion; v < MIGRATIONS.length; v++) {
          MIGRATIONS[v]!(db, tx);
        }
      },
    });
  }
  return dbPromise;
}
