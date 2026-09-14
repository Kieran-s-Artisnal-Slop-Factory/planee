/**
 * The change feed: "rows in these stores may have changed — re-read them".
 *
 * Three sources feed it:
 *
 *  1. Local writes. Every successful write in repo.ts ends with
 *     `notifyChanged([store])`.
 *  2. Sync. A finished sync that pulled rows or adopted conflict winners wrote
 *     to IndexedDB behind repo's back, so the `planee-sync` window event (with
 *     `ok && (pulled > 0 || conflicts > 0)`) is turned into a notification for
 *     every synced store.
 *  3. Other tabs. IndexedDB is shared by every tab of the origin, but events
 *     are not: sources 1 and 2 are re-posted on a BroadcastChannel, and a
 *     message from another tab is delivered to this tab's listeners only
 *     (never re-broadcast, or two tabs would echo forever).
 *
 * Notifications are coalesced: a burst of writes (a create is a task put and a
 * link put; a bump is several) reaches each listener once, a frame later, with
 * the union of the stores touched.
 *
 * Listeners must only READ. A listener that writes triggers another
 * notification, which triggers the listener again — and every write restamps
 * rows, which is how "refresh on change" turns into silent data loss.
 *
 * SSR-safe: nothing touches `window` or `BroadcastChannel` until the first
 * notify/subscribe call, and both are skipped where they do not exist.
 *
 * Not covered: writes that bypass repo.ts (backup import, the test hook's
 * raw* helpers, migrations). Those either reload the page or are test-only.
 */
import { SYNCED_STORES } from './types';

/** The window event sync.ts fires after every attempt (sync.ts SYNC_EVENT). */
const SYNC_EVENT = 'planee-sync';
const CHANNEL_NAME = 'planee-data';
/** How long a burst of notifications is gathered before listeners run. */
const COALESCE_MS = 16;

export type ChangeCallback = (stores: string[]) => void;

/**
 * Gather store names and deliver them once per `schedule` tick. Pure apart
 * from the scheduler it is given, so the coalescing is unit-testable.
 */
export function createCoalescer(
  schedule: (flush: () => void) => void,
  deliver: (stores: string[]) => void
): (stores: readonly string[]) => void {
  let pending = new Set<string>();
  let scheduled = false;
  return (stores) => {
    if (stores.length === 0) return;
    for (const store of stores) pending.add(store);
    if (scheduled) return;
    scheduled = true;
    schedule(() => {
      scheduled = false;
      const batch = [...pending];
      pending = new Set();
      if (batch.length > 0) deliver(batch);
    });
  };
}

/**
 * The stores of `changed` a listener asked for, or null when none of them
 * concern it. `'*'` takes everything.
 */
export function relevantStores(
  wanted: readonly string[] | '*',
  changed: readonly string[]
): string[] | null {
  if (wanted === '*') return changed.length > 0 ? [...changed] : null;
  const hits = changed.filter((store) => wanted.includes(store));
  return hits.length > 0 ? hits : null;
}

/** Whether a sync result wrote anything local listeners should re-read. */
export function syncChangedData(detail: unknown): boolean {
  if (!detail || typeof detail !== 'object') return false;
  const result = detail as { ok?: unknown; pulled?: unknown; conflicts?: unknown };
  return result.ok === true && (Number(result.pulled) > 0 || Number(result.conflicts) > 0);
}

interface Listener {
  stores: readonly string[] | '*';
  cb: ChangeCallback;
}

const listeners = new Set<Listener>();
let channel: BroadcastChannel | null | undefined;
let syncListenerInstalled = false;

function deliverLocal(stores: string[]): void {
  for (const listener of [...listeners]) {
    const hits = relevantStores(listener.stores, stores);
    if (!hits) continue;
    try {
      listener.cb(hits);
    } catch (err) {
      console.error('[planee changes] listener failed:', err);
    }
  }
}

const schedule = (flush: () => void) => {
  setTimeout(flush, COALESCE_MS);
};

const queue = createCoalescer(schedule, deliverLocal);

function getChannel(): BroadcastChannel | null {
  if (channel !== undefined) return channel;
  if (typeof BroadcastChannel === 'undefined') {
    channel = null;
    return channel;
  }
  try {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = (event: MessageEvent) => {
      const stores = (event.data as { stores?: unknown } | null)?.stores;
      if (Array.isArray(stores)) queue(stores.filter((s): s is string => typeof s === 'string'));
    };
  } catch {
    channel = null;
  }
  return channel;
}

function installSyncListener(): void {
  if (syncListenerInstalled || typeof window === 'undefined') return;
  syncListenerInstalled = true;
  window.addEventListener(SYNC_EVENT, (event) => {
    if (syncChangedData((event as CustomEvent).detail)) notifyChanged(SYNCED_STORES);
  });
}

// Any page that loads repo.ts relays its syncs to other tabs, even a page with
// no listeners of its own (Settings syncing while a board is open elsewhere).
// Guarded, so a server render imports this without touching `window`.
if (typeof window !== 'undefined') installSyncListener();

/**
 * Tell this tab's listeners, and every other tab's, that rows in `stores`
 * changed. Called by repo.ts after each successful write.
 */
export function notifyChanged(stores: readonly string[]): void {
  if (typeof window === 'undefined' || stores.length === 0) return;
  installSyncListener();
  queue(stores);
  try {
    getChannel()?.postMessage({ stores: [...stores] });
  } catch {
    // A closed or unavailable channel only costs other tabs their live update.
  }
}

/**
 * Run `cb` (coalesced) whenever any of `stores` changes — here, in another
 * tab, or through a sync. Returns the unsubscribe function. `cb` must only
 * read.
 */
export function onChanged(stores: readonly string[] | '*', cb: ChangeCallback): () => void {
  const listener: Listener = { stores, cb };
  listeners.add(listener);
  if (typeof window !== 'undefined') {
    installSyncListener();
    getChannel();
  }
  return () => {
    listeners.delete(listener);
  };
}
