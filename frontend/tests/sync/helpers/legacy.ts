/**
 * Fixtures for "an install that predates the current schema": a server
 * database as the v1 server build left it, and an IndexedDB as the v2 client
 * build left it.
 *
 * Both are FROZEN, like the migrations they exercise. They describe what old
 * builds actually wrote, so they must never follow the current schema — if the
 * schema changes again, add a new fixture for the new baseline instead.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { BACKEND_DIR } from './paths';

export type LegacyRows = Record<string, Record<string, unknown>[]>;

/**
 * The server's schema v1: backend/testdata/schema_v1.sql (the DDL exactly as
 * it first shipped, shared with backend/db_test.go) plus the v1 build's
 * sync_state table, which lived in db.go rather than schema.sql.
 */
const V1_SYNC_STATE_DDL = `
CREATE TABLE sync_state (
    id       INTEGER PRIMARY KEY CHECK (id = 1),
    last_seq INTEGER NOT NULL,
    epoch    TEXT NOT NULL
);
`;

function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? '1' : '0';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return "'" + text.replace(/'/g, "''") + "'";
}

/**
 * SQL that builds a v1 server database holding `rows` (column names exactly as
 * given — JSON-valued columns are stored as JSON text), with the sync counter
 * at `lastSeq` and identity `epoch`, at user_version 1. The current server
 * migrates it when it opens the file.
 */
export function v1ServerSql(rows: LegacyRows, sync: { epoch: string; lastSeq: number }): string {
  const ddl = readFileSync(join(BACKEND_DIR, 'testdata', 'schema_v1.sql'), 'utf8');
  const inserts: string[] = [];
  for (const [table, list] of Object.entries(rows)) {
    for (const row of list) {
      const cols = Object.keys(row);
      inserts.push(
        `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => sqlLiteral(row[c])).join(', ')});`
      );
    }
  }
  return [
    ddl,
    V1_SYNC_STATE_DDL,
    `INSERT INTO sync_state (id, last_seq, epoch) VALUES (1, ${sync.lastSeq}, ${sqlLiteral(sync.epoch)});`,
    ...inserts,
    'PRAGMA user_version = 1;',
  ].join('\n');
}

/**
 * Create the 'planee' IndexedDB at version 2, exactly as the v2 client build's
 * migrations left it, holding `rows` and the `meta` sync bookkeeping.
 *
 * Must run on the app's origin BEFORE any app page has opened the database
 * (navigate to a static file such as /favicon.svg first): the app would
 * otherwise create a fresh v3 database and this would fail to open at v2.
 *
 * Mirrors `git show 231a592:frontend/src/lib/db/db.ts`:
 *   v1 — one keyPath 'id' store per STORES entry (in declaration order, no
 *        indexes — every `indexes` list was empty), enum stores seeded
 *   v2 — sync_meta and sync_outbox, keyPath 'key'
 */
export async function createV2Database(
  page: Page,
  rows: LegacyRows,
  meta: Record<string, unknown>
): Promise<void> {
  await page.evaluate(
    async ({ rows, meta }) => {
      // Frozen v2 store list and enum seeds (types.ts STORES / ENUM_SEEDS at 231a592).
      const stores = ['project', 'version', 'task', 'version_task', 'task_type', 'preferences', 'status_type'];
      const enums: Record<string, [string, string][]> = {
        task_type: [
          ['bug', 'Bug'],
          ['feature', 'Feature'],
          ['exploration', 'Exploration'],
          ['cleanup', 'Cleanup'],
        ],
        status_type: [
          ['todo', 'TODO'],
          ['in_progress', 'In Progress'],
          ['done', 'Done'],
          ['wontfix', 'Wont Fix'],
          ['out_of_scope', 'Out of Scope'],
          ['bumped', 'Bumped'],
        ],
      };
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open('planee', 2);
        req.onupgradeneeded = (event) => {
          if (event.oldVersion !== 0) {
            reject(new Error('planee IndexedDB already existed at v' + event.oldVersion));
            return;
          }
          const upgrade = req.result;
          for (const name of stores) {
            const store = upgrade.createObjectStore(name, { keyPath: 'id' });
            (enums[name] ?? []).forEach(([key, label], position) => {
              store.put({
                id: key,
                label,
                position,
                updated_at: '1970-01-01T00:00:00.000Z',
                deleted_at: null,
                server_seq: null,
              });
            });
          }
          upgrade.createObjectStore('sync_meta', { keyPath: 'key' });
          upgrade.createObjectStore('sync_outbox', { keyPath: 'key' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction([...Object.keys(rows), 'sync_meta'], 'readwrite');
        for (const [store, list] of Object.entries(rows)) {
          for (const row of list) tx.objectStore(store).put(row);
        }
        for (const [key, value] of Object.entries(meta)) tx.objectStore('sync_meta').put({ key, value });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      // Close, or the app's open at v3 is blocked waiting for this connection.
      db.close();
    },
    { rows, meta }
  );
}

/** The 'planee' IndexedDB's version, stores and indexes, read without upgrading it. */
export async function describeDatabase(
  page: Page
): Promise<{ version: number; stores: Record<string, { keyPath: string; indexes: string[] }> }> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('planee');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const names = [...db.objectStoreNames];
    const stores: Record<string, { keyPath: string; indexes: string[] }> = {};
    if (names.length > 0) {
      const tx = db.transaction(names, 'readonly');
      for (const name of names) {
        const store = tx.objectStore(name);
        stores[name] = { keyPath: String(store.keyPath), indexes: [...store.indexNames].sort() };
      }
    }
    const version = db.version;
    db.close();
    return { version, stores };
  });
}
