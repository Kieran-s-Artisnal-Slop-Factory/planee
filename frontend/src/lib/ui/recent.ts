/**
 * Recently viewed tasks, projects and versions — per DEVICE, on purpose.
 *
 * Views are UI history, not data: syncing them would turn every card you open
 * into a write, an outbox entry and a push. They live in localStorage, so each
 * device keeps its own list. "Recently added/updated" comes from the synced
 * rows themselves (created/updated_at) and does follow you between devices.
 *
 * The storage is injectable so the list logic is unit-testable in node.
 */

export type RecentKind = 'task' | 'project' | 'version';

export interface RecentView {
  id: string;
  /** UTC ISO 8601 of the most recent view. */
  at: string;
}

type Views = Partial<Record<RecentKind, RecentView[]>>;

interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const RECENT_VIEWS_KEY = 'planee-recent-views';
/** Per kind — enough for any "recent" list without growing forever. */
export const MAX_VIEWS_PER_KIND = 50;

/** Fired on window after a view is recorded (same tab). */
export const RECENT_VIEWS_EVENT = 'planee-recent-views';

function defaultStore(): KeyValueStore | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null; // storage blocked
  }
}

function read(store: KeyValueStore | null): Views {
  if (!store) return {};
  try {
    const parsed = JSON.parse(store.getItem(RECENT_VIEWS_KEY) ?? '{}') as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Views) : {};
  } catch {
    return {}; // a corrupt entry is just no history
  }
}

/** Pure: the list after viewing `id` at `at` — moved to the front, deduped, capped. */
export function withView(list: readonly RecentView[], id: string, at: string): RecentView[] {
  return [{ id, at }, ...list.filter((v) => v.id !== id)].slice(0, MAX_VIEWS_PER_KIND);
}

export function recordView(
  kind: RecentKind,
  id: string,
  at: string = new Date().toISOString(),
  store: KeyValueStore | null = defaultStore()
): void {
  if (!store || !id) return;
  const views = read(store);
  views[kind] = withView(views[kind] ?? [], id, at);
  try {
    store.setItem(RECENT_VIEWS_KEY, JSON.stringify(views));
  } catch {
    return; // quota or blocked storage: history is best-effort
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(RECENT_VIEWS_EVENT, { detail: { kind, id } }));
  }
}

/** Most recent first. */
export function recentViews(
  kind: RecentKind,
  limit = MAX_VIEWS_PER_KIND,
  store: KeyValueStore | null = defaultStore()
): RecentView[] {
  return (read(store)[kind] ?? []).slice(0, limit);
}

/** Drop ids that no longer exist (deleted rows) from a kind's history view. */
export function forgetViews(kind: RecentKind, ids: readonly string[], store: KeyValueStore | null = defaultStore()): void {
  if (!store || ids.length === 0) return;
  const views = read(store);
  const drop = new Set(ids);
  views[kind] = (views[kind] ?? []).filter((v) => !drop.has(v.id));
  try {
    store.setItem(RECENT_VIEWS_KEY, JSON.stringify(views));
  } catch {
    // best-effort
  }
}
