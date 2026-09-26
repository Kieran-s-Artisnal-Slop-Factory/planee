/**
 * Client sync loop.
 *
 * PUSH — send exactly the rows queued in the outbox (db/outbox.ts). The server
 * applies last-write-wins, returns the server_seq it assigned to each accepted
 * row, the authoritative row for every row it REJECTED under LWW, and a list
 * of rows it could not store at all. An entry leaves the queue only when the
 * server confirms the exact version we sent.
 *
 * PULL — request rows above our cursor and apply them under LWW. Everything in
 * one pull is applied before the cursor moves, so an interrupted pull re-fetches
 * rather than skipping rows.
 *
 * TIE-BREAKING — the server accepts a pushed row only if it is STRICTLY newer
 * than the row it holds, and the client applies an incoming row when it is
 * newer OR EQUAL. Both sides therefore resolve an exact-millisecond tie the
 * same way: onto the server's incumbent. (Opposite tie rules on the two sides
 * is a permanent-divergence bug, not a cosmetic one — the losing device never
 * re-pulls the winner because its cursor is already past that row.)
 *
 * The server base URL defaults to same-origin (the Go backend serves the built
 * frontend in production) and can be overridden in Settings for a separately
 * hosted frontend or development.
 */
import type { IDBPTransaction } from 'idb';
import { getDB } from './db/db';
import { FIELD_MERGED_STORES, SYNCED_STORES } from './db/types';
import type { SyncFields } from './db/types';
import { isTestMode } from './testMode';
import {
  clearOutbox,
  confirmPushed,
  drainOutbox,
  enqueue,
  enqueueEverything,
  isPoisoned,
  markRejected,
} from './db/outbox';

const SYNC_URL_KEY = 'planee-sync-url';
const AUTO_SYNC_AT_KEY = 'planee-last-auto-sync';
const SESSION_SYNC_KEY = 'planee-session-synced';
const AUTO_SYNC_INTERVAL_MS = 15 * 60 * 1000;

/** Fired on window whenever a sync attempt finishes (detail: SyncResult). */
export const SYNC_EVENT = 'planee-sync';

/**
 * Tables reconciled per FIELD rather than per row: two devices editing
 * different fields of the same row both keep their edit. Comes from the
 * schema — see the table's "Concurrent edits" setting in the builder.
 */
const FIELD_MERGED = new Set<string>(FIELD_MERGED_STORES);

/**
 * Stores this loop is allowed to move. An enum store is in STORES but not
 * here: its rows are seeded identically on every device and the server, so a
 * push would be refused as an unknown table and a pull can never carry one.
 */
const SYNCED = new Set<string>(SYNCED_STORES);

export interface SyncResult {
  ok: boolean;
  pushed: number;
  pulled: number;
  /** Rows the server refused to store (bad shape / constraint violation). */
  rejected: number;
  /** Rows we pushed that lost last-write-wins and were adopted back. */
  conflicts: number;
  error?: string;
}

export function getSyncUrl(): string {
  // No configured URL means same-origin. The base the app was built with is the
  // correct same-origin prefix: '' at the root (the Go backend serving its own
  // frontend), '/planee' on GitHub Pages, and '/<user>/planee' behind a
  // path-multiplexing gateway that mounts many copies on one origin. BASE_URL
  // always ends in '/', which the leading-slash paths at every call site supply.
  return localStorage.getItem(SYNC_URL_KEY) ?? import.meta.env.BASE_URL.replace(/\/+$/, '');
}

const SYNC_MODE_KEY = 'planee-sync-mode';

export type SyncMode = 'offline' | 'sync';

/**
 * Pure sync-mode decision, split out so it is unit-testable without a browser.
 *
 * - An explicit choice saved in Settings (`stored`) always wins, in both
 *   directions — a Pages visitor who configures a server can turn sync on.
 * - Otherwise the build decides: `PUBLIC_DEFAULT_SYNC_MODE=offline` (the GitHub
 *   Pages build) starts offline, because same-origin there is a static host
 *   with no /sync endpoints. Any other value, or none, means 'sync' — an empty
 *   URL then syncs same-origin, which is correct when the Go backend serves
 *   the frontend.
 */
export function resolveSyncMode(stored: string | null, buildDefault: string | undefined): SyncMode {
  if (stored === 'offline' || stored === 'sync') return stored;
  return buildDefault === 'offline' ? 'offline' : 'sync';
}

/** True when this build was made to start offline (the GitHub Pages build). */
export function isOfflineDefaultBuild(): boolean {
  return import.meta.env.PUBLIC_DEFAULT_SYNC_MODE === 'offline';
}

/** 'offline' disables background sync entirely; see resolveSyncMode. */
export function getSyncMode(): SyncMode {
  return resolveSyncMode(localStorage.getItem(SYNC_MODE_KEY), import.meta.env.PUBLIC_DEFAULT_SYNC_MODE);
}

export function setSyncMode(mode: SyncMode): void {
  localStorage.setItem(SYNC_MODE_KEY, mode);
}

export async function setSyncUrl(url: string): Promise<void> {
  const trimmed = url.trim().replace(/\/+$/, '');
  const before = getSyncUrl();
  if (trimmed) localStorage.setItem(SYNC_URL_KEY, trimmed);
  else localStorage.removeItem(SYNC_URL_KEY);
  // server_seq values and the pull cursor are meaningful ONLY relative to the
  // server that issued them. Pointing at a different server must forget them,
  // or a stale high-water mark silently under-fetches the new server's history
  // and local rows it has never seen never get pushed.
  if (getSyncUrl() !== before) await resetLocalSyncState();
}

/**
 * Full reconciliation reset: forget the pull cursor and the server identity,
 * clear every server_seq (they belong to a sequence space we are leaving), and
 * re-queue every local row so it is offered to the new server.
 *
 * MUST be called whenever the local dataset or the sync target is swapped out
 * from under the cursors — a server change (setSyncUrl) or a full backup
 * restore (importData). Skipping either half is a silent permanent fork: the
 * device sits above the server's sequence and never pulls the rows below it.
 */
export async function resetLocalSyncState(): Promise<void> {
  const db = await getDB();
  await Promise.all([
    db.delete('sync_meta', 'lastPullSeq'),
    db.delete('sync_meta', 'serverEpoch'),
  ]);
  // Clear foreign server_seq values without touching updated_at (not an edit).
  for (const store of SYNCED_STORES) {
    const tx = db.transaction(store, 'readwrite');
    const rows = (await tx.store.getAll()) as SyncFields[];
    for (const row of rows) {
      if (row.server_seq != null) tx.store.put({ ...row, server_seq: null });
    }
    await tx.done;
  }
  await clearOutbox();
  await enqueueEverything();
}

/** Map an HTTP failure to a user-facing message; full details go to the console. */
async function describeHttpError(phase: string, res: Response): Promise<string> {
  const body = await res.text().catch(() => '');
  const detail = `${res.status} ${res.statusText || 'error'}`;
  console.error(`[planee sync] ${phase} failed: ${detail}`, body || '(no response body)');
  if (res.status >= 500) {
    return `Sync server error — check the server logs (${detail})`;
  }
  return `Cannot reach the sync server — check the server URL in Settings (${detail})`;
}

function describeNetworkError(phase: string, err: unknown): string {
  console.error(`[planee sync] ${phase} failed:`, err);
  return 'Cannot reach the sync server — check the server URL and that the server is running.';
}

/** Probe a server URL ( /healthz ) with the same error mapping as sync. */
export async function testConnection(url: string): Promise<{ ok: boolean; message: string }> {
  const base = url.trim().replace(/\/+$/, '');
  let res: Response;
  try {
    res = await fetch(`${base}/healthz`);
  } catch (err) {
    return { ok: false, message: describeNetworkError('connection test', err) };
  }
  if (!res.ok) return { ok: false, message: await describeHttpError('connection test', res) };
  return { ok: true, message: 'Connected to sync server successfully.' };
}

async function getMeta<T>(key: string): Promise<T | undefined> {
  const row = (await (await getDB()).get('sync_meta', key)) as { value: T } | undefined;
  return row?.value;
}

async function setMeta(key: string, value: unknown): Promise<void> {
  await (await getDB()).put('sync_meta', { key, value });
}

export interface SyncStatus {
  lastSyncAt: string | null;
  lastError: string | null;
  /** Rows changed on this device and not yet confirmed by the server. */
  pending: number;
}

export async function getSyncStatus(): Promise<SyncStatus> {
  return {
    lastSyncAt: (await getMeta<string>('lastSyncAt')) ?? null,
    lastError: (await getMeta<string | null>('lastError')) ?? null,
    pending: (await drainOutbox()).length,
  };
}

// ---------------------------------------------------------------------------
// Applying rows that came from the server
// ---------------------------------------------------------------------------

type Row = SyncFields & Record<string, unknown>;
type WriteTx = IDBPTransaction<unknown, [string], 'readwrite'>;

/** 'applied' = took the server's row; 'merged' = wrote a union that still needs pushing;
 *  'declined' = we hold something strictly newer and our push will carry it. */
type ApplyOutcome = 'applied' | 'merged' | 'declined';

/**
 * Per-field merge for field-merged tables: take each field from whichever side
 * stamped it later, so two devices editing different fields of the same row
 * both keep their edit instead of the later whole-row write erasing the other.
 * Fields with no stamp fall back to the row's updated_at (rows written before
 * the table was switched to field merge).
 *
 * "tookLocal" reports whether any field came from OUR side — that means the
 * merged row holds something the server has never seen and must be pushed.
 */
function mergeRows(incoming: Row, local: Row): { row: Row; tookLocal: boolean } {
  const incomingTs = (incoming.field_updated_at ?? {}) as Record<string, string>;
  const localTs = (local.field_updated_at ?? {}) as Record<string, string>;
  const merged: Row = { ...local };
  const mergedTs: Record<string, string> = {};
  let tookLocal = false;

  const fields = new Set([...Object.keys(local), ...Object.keys(incoming)]);
  for (const field of fields) {
    if (field === 'id' || field === 'field_updated_at' || field === 'server_seq') continue;
    if (field === 'updated_at') continue;
    const inAt = incomingTs[field] ?? incoming.updated_at;
    const localAt = localTs[field] ?? local.updated_at;
    // '>=' keeps the tie rule identical to the row-level path: the server's
    // copy (the incoming one) wins an exact tie, on both devices.
    if (inAt >= localAt) {
      merged[field] = incoming[field];
      mergedTs[field] = inAt;
    } else {
      merged[field] = local[field];
      mergedTs[field] = localAt;
      tookLocal = true;
    }
  }
  merged.field_updated_at = mergedTs;
  merged.updated_at =
    incoming.updated_at >= local.updated_at ? incoming.updated_at : local.updated_at;
  merged.server_seq = incoming.server_seq ?? local.server_seq ?? null;
  return { row: merged, tookLocal };
}

/**
 * Apply one server row to the local store inside an open transaction. Awaits
 * only IndexedDB promises — awaiting anything else here would let the browser
 * auto-commit the transaction out from under the loop.
 */
async function applyIncoming(store: string, incoming: Row, tx: WriteTx): Promise<ApplyOutcome> {
  const objectStore = tx.objectStore(store);
  const local = (await objectStore.get(incoming.id)) as Row | undefined;
  if (!local) {
    await objectStore.put(incoming);
    return 'applied';
  }
  if (FIELD_MERGED.has(store)) {
    const { row, tookLocal } = mergeRows(incoming, local);
    await objectStore.put(row);
    return tookLocal ? 'merged' : 'applied';
  }
  if (incoming.updated_at >= local.updated_at) {
    await objectStore.put(incoming);
    return 'applied';
  }
  return 'declined';
}

/**
 * Apply a batch of server rows for one store, then queue any merged unions for
 * the next push. Queuing happens AFTER the transaction closes so no non-IDB
 * await ever sits inside it.
 */
async function applyBatch(
  store: string,
  incoming: Row[],
  db: Awaited<ReturnType<typeof getDB>>
): Promise<{ applied: number; merged: string[] }> {
  const tx = db.transaction(store, 'readwrite');
  const merged: string[] = [];
  let applied = 0;
  for (const row of incoming) {
    const outcome = await applyIncoming(store, row, tx);
    if (outcome !== 'declined') applied++;
    if (outcome === 'merged') merged.push(row.id);
  }
  await tx.done;
  for (const id of merged) {
    const row = (await db.get(store, id)) as Row | undefined;
    if (row) await enqueue(store, id, row.updated_at);
  }
  return { applied, merged };
}

// ---------------------------------------------------------------------------
// The sync loop
// ---------------------------------------------------------------------------

let syncing = false;

/**
 * True while a sync is applying rows. Any "reconcile on read" / dedup / heal
 * pass MUST bail while this is true: folding a half-applied dataset tombstones
 * rows whose children have not arrived yet, and that tombstone then propagates
 * to every device.
 */
export function isSyncing(): boolean {
  return syncing;
}

export async function syncNow(): Promise<SyncResult> {
  if (syncing) return { ok: true, pushed: 0, pulled: 0, rejected: 0, conflicts: 0 };
  syncing = true;
  try {
    return await runSync();
  } finally {
    syncing = false;
  }
}

async function runSync(): Promise<SyncResult> {
  let pushed = 0;
  let pulled = 0;
  let rejected = 0;
  let conflicts = 0;
  try {
    const db = await getDB();
    const base = getSyncUrl();

    // ---- push: exactly what the outbox holds, minus rows the server already
    // refused at this version (they would fail again and add nothing).
    const queued = (await drainOutbox()).filter((e) => !isPoisoned(e));
    const sent = new Map<string, string>(); // "store:id" -> updated_at we sent
    const rows: Record<string, Row[]> = {};
    for (const entry of queued) {
      if (!SYNCED.has(entry.store)) continue; // store removed by a migration, or an enum
      const row = (await db.get(entry.store, entry.id)) as Row | undefined;
      if (!row) continue; // hard-deleted locally; nothing to send
      (rows[entry.store] ??= []).push(row);
      sent.set(entry.key, row.updated_at);
      pushed++;
    }

    let pushRes: Response;
    try {
      pushRes = await fetch(`${base}/sync/push`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows }),
      });
    } catch (err) {
      throw new Error(describeNetworkError('push', err));
    }
    if (!pushRes.ok) throw new Error(await describeHttpError('push', pushRes));
    const pushJson = (await pushRes.json()) as {
      accepted: { table: string; id: string; server_seq: number }[];
      conflicts?: Record<string, Row[]>;
      rejected?: { table: string; id: string; reason: string }[];
      epoch?: string;
    };

    await ensureEpoch(pushJson.epoch);

    // Record assigned seqs without touching updated_at (not a user edit), and
    // release the outbox entry for the exact version the server confirmed.
    for (const acc of pushJson.accepted ?? []) {
      const row = (await db.get(acc.table, acc.id)) as Row | undefined;
      if (row) await db.put(acc.table, { ...row, server_seq: acc.server_seq });
      const sentAt = sent.get(acc.table + ':' + acc.id);
      if (sentAt) await confirmPushed(acc.table, acc.id, sentAt);
    }

    // Rows the server could not store at all. Park them so one bad row cannot
    // make every future push fail; they retry automatically once edited.
    for (const bad of pushJson.rejected ?? []) {
      rejected++;
      console.error(`[planee sync] server rejected ${bad.table}/${bad.id}: ${bad.reason}`);
      await markRejected(bad.table, bad.id, bad.reason);
    }

    // Rows that lost last-write-wins. Without adopting these, the losing device
    // keeps its rejected edit forever: its pull cursor is already past that
    // row's server_seq, so a plain pull will never re-offer the winner.
    for (const [store, incoming] of Object.entries(pushJson.conflicts ?? {})) {
      if (!SYNCED.has(store)) continue;
      const outcome = await applyBatch(store, incoming, db);
      conflicts += outcome.applied;
      for (const row of incoming) {
        // The winner is now our row too, so stop offering the version we sent
        // — unless the merge produced a union that still needs pushing.
        if (outcome.merged.includes(row.id)) continue;
        const sentAt = sent.get(store + ':' + row.id);
        if (sentAt) await confirmPushed(store, row.id, sentAt);
      }
    }

    // ---- pull
    const since = (await getMeta<number>('lastPullSeq')) ?? 0;
    let pullRes: Response;
    try {
      pullRes = await fetch(`${base}/sync/pull?since=${since}`);
    } catch (err) {
      throw new Error(describeNetworkError('pull', err));
    }
    if (!pullRes.ok) throw new Error(await describeHttpError('pull', pullRes));
    const pullJson = (await pullRes.json()) as {
      rows: Record<string, Row[]>;
      latestSeq: number;
      epoch?: string;
    };

    if (await ensureEpoch(pullJson.epoch)) {
      // The server was replaced/reset mid-sync. Everything we just read belongs
      // to the old sequence space; bail and let the next sync start clean.
      throw new Error('Sync server identity changed — re-syncing from scratch on the next run.');
    }

    for (const [store, incoming] of Object.entries(pullJson.rows ?? {})) {
      if (!SYNCED.has(store)) continue; // a table this build does not know, or an enum
      pulled += (await applyBatch(store, incoming, db)).applied;
    }
    // Only now — every row of this pull is committed, so a crash mid-apply
    // re-fetches instead of leaving a permanent hole below the cursor.
    await setMeta('lastPullSeq', pullJson.latestSeq ?? since);
    await setMeta('lastSyncAt', new Date().toISOString());
    await setMeta('lastError', null);
    const result: SyncResult = {
      ok: true,
      pushed: (pushJson.accepted ?? []).length,
      pulled,
      rejected,
      conflicts,
    };
    window.dispatchEvent(new CustomEvent(SYNC_EVENT, { detail: result }));
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      await setMeta('lastError', message);
    } catch {
      // storage unavailable — nothing else to do
    }
    const result: SyncResult = { ok: false, pushed: 0, pulled: 0, rejected, conflicts, error: message };
    window.dispatchEvent(new CustomEvent(SYNC_EVENT, { detail: result }));
    return result;
  }
}

/**
 * The server stamps every response with an epoch id generated when its
 * database was created. If it changes, we are talking to a different (or
 * rebuilt) server whose server_seq counter restarted — our cursor and every
 * stored server_seq are meaningless. Returns true when a reset was performed.
 */
async function ensureEpoch(epoch: string | undefined): Promise<boolean> {
  if (!epoch) return false;
  const known = await getMeta<string>('serverEpoch');
  if (known === epoch) return false;
  if (known === undefined) {
    await setMeta('serverEpoch', epoch);
    return false;
  }
  console.warn(`[planee sync] server epoch changed (${known} -> ${epoch}) — resetting sync state`);
  await resetLocalSyncState();
  await setMeta('serverEpoch', epoch);
  return true;
}

// ---------------------------------------------------------------------------
// Triggering a sync
// ---------------------------------------------------------------------------

const REQUEST_DEBOUNCE_MS = 1500;
let requestTimer: ReturnType<typeof setTimeout> | null = null;
let requestPending = false;

/**
 * "Sync soon" — called after EVERY mutation (see db/repo.ts).
 *
 * Without this the only automatic sync is the page-load one, so a change made
 * on one device stays invisible to the others for minutes or until an app
 * relaunch. That is the single most-reported local-first symptom ("my edits
 * don't transfer"), and it also widens every last-write-wins race window,
 * turning rare conflicts into routine ones.
 *
 * Debounced (a burst of writes coalesces into one sync), gated on being online
 * and not in offline mode, and self-mutexed via syncNow's guard.
 */
export function requestSync(): void {
  if (typeof window === 'undefined') return;
  // Test mode drives every sync explicitly; an automatic one racing an
  // assertion makes results nondeterministic and hides real bugs in flakes.
  if (isTestMode()) return;
  if (getSyncMode() === 'offline') return;
  if (typeof navigator !== 'undefined' && !navigator.onLine) return;
  requestPending = true;
  if (requestTimer) clearTimeout(requestTimer);
  requestTimer = setTimeout(() => {
    requestTimer = null;
    if (!requestPending) return;
    requestPending = false;
    void syncNow();
  }, REQUEST_DEBOUNCE_MS);
}

/** Flush a pending debounced sync immediately (page hide, explicit "Sync now"). */
export async function flushPendingSync(): Promise<void> {
  if (requestTimer) {
    clearTimeout(requestTimer);
    requestTimer = null;
  }
  if (!requestPending) return;
  requestPending = false;
  await syncNow();
}

/**
 * Background sync, safe to call on every page load: always runs once when
 * the app is opened (per browser session), then at most every 15 minutes as
 * the user navigates.
 */
export function maybeAutoSync(): void {
  if (typeof navigator === 'undefined' || !navigator.onLine) return;
  if (isTestMode()) return; // see requestSync
  if (getSyncMode() === 'offline') return;
  const syncedThisSession = sessionStorage.getItem(SESSION_SYNC_KEY) === '1';
  const last = Number(localStorage.getItem(AUTO_SYNC_AT_KEY) ?? 0);
  if (syncedThisSession && Date.now() - last < AUTO_SYNC_INTERVAL_MS) return;
  sessionStorage.setItem(SESSION_SYNC_KEY, '1');
  localStorage.setItem(AUTO_SYNC_AT_KEY, String(Date.now()));
  void syncNow();
}
