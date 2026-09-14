/**
 * The push queue: which rows this device has changed and the server has not
 * confirmed yet.
 *
 * WHY THIS EXISTS. The obvious alternative — "push every row whose updated_at
 * is newer than the last push" — is a timestamp watermark, and watermarks lose
 * data in ways that are invisible until someone loses a day of edits:
 *
 *  - a row written DURING a push lands at/below the watermark the push then
 *    stores, and is never pushed again;
 *  - rows pulled from another device re-enter the "dirty" scan and get pushed
 *    straight back, wasting bandwidth and widening every conflict window;
 *  - a clock that jumps backwards strands every edit made before it jumped.
 *
 * An explicit queue has none of those failure modes: an entry is removed only
 * when the server confirms THAT EXACT VERSION of the row (matched on
 * updated_at), so a write racing a push simply stays queued.
 */
import { getDB } from './db';
import { SYNCED_STORES } from './types';
import type { SyncFields } from './types';

export const OUTBOX_STORE = 'sync_outbox';

export interface OutboxEntry {
  key: string; // "<store>:<id>"
  store: string;
  id: string;
  /** The row's updated_at when it was queued — the version this entry covers. */
  updated_at: string;
  queued_at: string;
  /** Set when the server refused this exact version (see markRejected). */
  error?: string;
  error_at?: string;
}

export const outboxKey = (store: string, id: string): string => store + ':' + id;

function entryFor(store: string, id: string, updatedAt: string): OutboxEntry {
  return {
    key: outboxKey(store, id),
    store,
    id,
    updated_at: updatedAt,
    queued_at: new Date().toISOString(),
  };
}

/**
 * Queue a locally-changed row inside the SAME transaction that writes it, so
 * the row and the "remember to send this" note commit together. A queue write
 * that could fail on its own would let a row change with nothing recording it.
 *
 * Synchronous on purpose: awaiting a non-IndexedDB promise mid-transaction lets
 * the browser auto-commit it out from under the caller.
 */
export function enqueueIn(
  tx: { objectStore(name: string): { put(value: unknown): unknown } },
  store: string,
  id: string,
  updatedAt: string
): void {
  tx.objectStore(OUTBOX_STORE).put(entryFor(store, id, updatedAt));
}

/**
 * Queue a locally-changed row on its own. Called by EVERY write in repo.ts —
 * if you add a write path that bypasses repo.ts, queue it here yourself or the
 * change will never leave this device.
 */
export async function enqueue(store: string, id: string, updatedAt: string): Promise<void> {
  await (await getDB()).put(OUTBOX_STORE, entryFor(store, id, updatedAt));
}

/** Every queued entry, oldest first. The push sends exactly these rows. */
export async function drainOutbox(): Promise<OutboxEntry[]> {
  const rows = (await (await getDB()).getAll(OUTBOX_STORE)) as OutboxEntry[];
  return rows.sort((a, b) => (a.queued_at < b.queued_at ? -1 : a.queued_at > b.queued_at ? 1 : 0));
}

/**
 * Drop an entry ONLY if the row still holds the version we pushed. A write
 * that landed while the request was in flight leaves the entry queued, which
 * is exactly what we want — otherwise that edit is lost forever.
 */
export async function confirmPushed(store: string, id: string, pushedUpdatedAt: string): Promise<void> {
  const db = await getDB();
  const entry = (await db.get(OUTBOX_STORE, outboxKey(store, id))) as OutboxEntry | undefined;
  if (!entry) return;
  if (entry.updated_at !== pushedUpdatedAt) return; // superseded mid-flight; keep it queued
  await db.delete(OUTBOX_STORE, entry.key);
}

/**
 * Record that the server refused to store this row (a constraint violation, a
 * missing required field, a corrupt value). The entry stays queued but is
 * skipped until the row changes again, so one poison row cannot make every
 * later push fail — the historical failure mode where a single bad row halts
 * ALL sync, in both directions, forever.
 */
export async function markRejected(store: string, id: string, reason: string): Promise<void> {
  const db = await getDB();
  const entry = (await db.get(OUTBOX_STORE, outboxKey(store, id))) as OutboxEntry | undefined;
  if (!entry) return;
  await db.put(OUTBOX_STORE, { ...entry, error: reason, error_at: entry.updated_at });
}

/** Entries the server has already refused at this exact version. */
export function isPoisoned(entry: OutboxEntry): boolean {
  return entry.error != null && entry.error_at === entry.updated_at;
}

/** Queue every row in every store — used after a restore or a server change. */
export async function enqueueEverything(): Promise<number> {
  const db = await getDB();
  const tx = db.transaction([...SYNCED_STORES, OUTBOX_STORE], 'readwrite');
  const outbox = tx.objectStore(OUTBOX_STORE);
  let queued = 0;
  for (const store of SYNCED_STORES) {
    const rows = (await tx.objectStore(store).getAll()) as SyncFields[];
    for (const row of rows) {
      outbox.put({
        key: outboxKey(store, row.id),
        store,
        id: row.id,
        updated_at: row.updated_at,
        queued_at: new Date().toISOString(),
      });
      queued++;
    }
  }
  await tx.done;
  return queued;
}

export async function clearOutbox(): Promise<void> {
  await (await getDB()).clear(OUTBOX_STORE);
}
