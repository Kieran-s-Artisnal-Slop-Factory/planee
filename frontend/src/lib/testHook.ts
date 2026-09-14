/**
 * window.__planee — the harness's view of this device.
 *
 * Installed only under test mode (see testMode.ts) and imported dynamically,
 * so it is a separate chunk that a real user never downloads.
 *
 * The raw* helpers deliberately BYPASS repo.ts: repo's reads filter tombstones
 * and no read exposes server_seq, so a test built on them cannot see a
 * resurrected row, a missing tombstone, or a cursor that advanced past
 * something. Those are the bugs worth catching.
 */
import { getDB } from './db/db';
import { STORES } from './db/types';
import type { SyncFields } from './db/types';
import { patch, put, putReconciled, softDelete } from './db/repo';
import { exportData, importData, type ExportEnvelope, type ImportMode } from './db/export';
import { isTestMode } from './testMode';
import { getSyncStatus, resetLocalSyncState, syncNow, type SyncResult } from './sync';
import { drainOutbox, enqueue, type OutboxEntry } from './db/outbox';
import { dbAssets } from './assets';
import { base64ToBytes } from './assetRefs';

export interface TestHook {
  rawDump(store: string): Promise<SyncFields[]>;
  rawDumpAll(): Promise<Record<string, SyncFields[]>>;
  rawGet(store: string, id: string): Promise<SyncFields | undefined>;
  rawPut(store: string, row: SyncFields): Promise<void>;
  rawDelete(store: string, id: string): Promise<void>;
  repoPut(store: string, row: SyncFields): Promise<SyncFields>;
  repoPatch(store: string, id: string, changes: Record<string, unknown>): Promise<unknown>;
  repoReconcile(store: string, row: SyncFields, contentAt: string): Promise<SyncFields>;
  repoSoftDelete(store: string, id: string): Promise<void>;
  outbox(): Promise<OutboxEntry[]>;
  enqueue(store: string, id: string, updatedAt: string): Promise<void>;
  exportData(): Promise<ExportEnvelope>;
  importData(envelope: ExportEnvelope, mode?: ImportMode): Promise<unknown>;
  stores(): string[];
  [extra: string]: unknown;
}

export function installTestHook(): void {
  if (!isTestMode()) return;
  const api: TestHook = {
    // --- raw reads: tombstones and server_seq included, nothing filtered
    rawDump: async (store) => (await (await getDB()).getAll(store)) as SyncFields[],
    rawDumpAll: async () => {
      const db = await getDB();
      const out: Record<string, SyncFields[]> = {};
      // One transaction so the snapshot is internally consistent.
      const tx = db.transaction(Object.keys(STORES), 'readonly');
      for (const name of Object.keys(STORES)) {
        out[name] = (await tx.objectStore(name).getAll()) as SyncFields[];
      }
      await tx.done;
      return out;
    },
    rawGet: async (store, id) => (await (await getDB()).get(store, id)) as SyncFields | undefined,

    // --- raw writes: fixtures and deliberate corruption (sabotage tests)
    rawPut: async (store, row) => {
      await (await getDB()).put(store, row);
    },
    rawDelete: async (store, id) => {
      await (await getDB()).delete(store, id);
    },

    // --- writes through the REAL repo, so tests exercise shipped behaviour
    repoPut: (store, row) => put(store, row),
    repoPatch: (store, id, changes) => patch(store, id, changes as never),
    repoReconcile: (store, row, contentAt) => putReconciled(store, row, contentAt),
    repoSoftDelete: (store, id) => softDelete(store, id),

    outbox: () => drainOutbox(),
    // Queue a row written with rawPut — lets a test push state the normal
    // write path would never produce (deliberately corrupt rows, fixtures).
    enqueue: (store, id, updatedAt) => enqueue(store, id, updatedAt),
    exportData: () => exportData(),
    importData: (envelope, mode) => importData(envelope, mode),
    stores: () => Object.keys(STORES),
    /** Run one full sync and resolve with its result. Never fire-and-forget. */
    syncNow: (): Promise<SyncResult> => syncNow(),
    /** The pull cursor + server identity + last sync/error, verbatim. */
    getCursors: async () => {
      const db = await getDB();
      const read = async (key: string) =>
        ((await db.get('sync_meta', key)) as { value: unknown } | undefined)?.value ?? null;
      return {
        lastPullSeq: await read('lastPullSeq'),
        serverEpoch: await read('serverEpoch'),
        ...(await getSyncStatus()),
      };
    },
    setMeta: async (key: string, value: unknown) => {
      await (await getDB()).put('sync_meta', { key, value });
    },
    resetSyncState: (): Promise<void> => resetLocalSyncState(),
    /**
     * Store bytes through the app's own asset store (dbAssets().save — the
     * path a pasted image takes) and resolve with the markdown ref it returns.
     * A test can't import app modules into a production page, and synthesising
     * a paste into the WYSIWYG canvas tests Milkdown rather than planee.
     */
    saveAsset: (base64: string, name: string, mime: string): Promise<string> =>
      dbAssets().save(new Blob([base64ToBytes(base64) as BlobPart], { type: mime }), name),
  };
  (window as unknown as Record<string, unknown>)['__planee'] = api;
  window.dispatchEvent(new CustomEvent('planee-test-hook-ready'));
}
