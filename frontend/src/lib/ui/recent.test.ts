import { describe, expect, it } from 'vitest';
import { MAX_VIEWS_PER_KIND, RECENT_VIEWS_KEY, forgetViews, recentViews, recordView, withView } from './recent';

function memoryStore() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    data,
  };
}

describe('recent views', () => {
  it('moves a re-viewed id to the front without duplicating it', () => {
    const list = withView(withView(withView([], 'a', '1'), 'b', '2'), 'a', '3');
    expect(list).toEqual([
      { id: 'a', at: '3' },
      { id: 'b', at: '2' },
    ]);
  });

  it('caps each kind', () => {
    let list = withView([], 'x0', '0');
    for (let i = 1; i < MAX_VIEWS_PER_KIND + 10; i++) list = withView(list, 'x' + i, String(i));
    expect(list).toHaveLength(MAX_VIEWS_PER_KIND);
    expect(list[0]!.id).toBe('x' + (MAX_VIEWS_PER_KIND + 9));
  });

  it('records and reads per kind, most recent first, limited', () => {
    const store = memoryStore();
    recordView('task', 't1', '2026-01-01T00:00:00.000Z', store);
    recordView('task', 't2', '2026-01-02T00:00:00.000Z', store);
    recordView('project', 'p1', '2026-01-03T00:00:00.000Z', store);
    expect(recentViews('task', 10, store).map((v) => v.id)).toEqual(['t2', 't1']);
    expect(recentViews('task', 1, store).map((v) => v.id)).toEqual(['t2']);
    expect(recentViews('project', 10, store).map((v) => v.id)).toEqual(['p1']);
    expect(recentViews('version', 10, store)).toEqual([]);
  });

  it('treats corrupt storage as empty history', () => {
    const store = memoryStore();
    store.setItem(RECENT_VIEWS_KEY, '{not json');
    expect(recentViews('task', 10, store)).toEqual([]);
    recordView('task', 't1', 'now', store);
    expect(recentViews('task', 10, store).map((v) => v.id)).toEqual(['t1']);
  });

  it('forgets deleted ids', () => {
    const store = memoryStore();
    recordView('task', 't1', '1', store);
    recordView('task', 't2', '2', store);
    forgetViews('task', ['t1'], store);
    expect(recentViews('task', 10, store).map((v) => v.id)).toEqual(['t2']);
  });
});
