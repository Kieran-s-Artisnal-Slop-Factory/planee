import { describe, expect, it } from 'vitest';
import { createCoalescer, relevantStores, syncChangedData } from './changes';

/** A scheduler that runs nothing until the test flushes it. */
function manualScheduler() {
  const queued: (() => void)[] = [];
  return {
    schedule: (flush: () => void) => queued.push(flush),
    run: () => queued.splice(0).forEach((flush) => flush()),
    get size() {
      return queued.length;
    },
  };
}

describe('createCoalescer', () => {
  it('delivers a burst once, with the union of stores', () => {
    const clock = manualScheduler();
    const batches: string[][] = [];
    const notify = createCoalescer(clock.schedule, (stores) => batches.push(stores));
    notify(['task']);
    notify(['version_task']);
    notify(['task', 'version']);
    expect(clock.size).toBe(1);
    expect(batches).toEqual([]);
    clock.run();
    expect(batches).toEqual([['task', 'version_task', 'version']]);
  });

  it('schedules again after a flush', () => {
    const clock = manualScheduler();
    const batches: string[][] = [];
    const notify = createCoalescer(clock.schedule, (stores) => batches.push(stores));
    notify(['task']);
    clock.run();
    notify(['asset']);
    expect(clock.size).toBe(1);
    clock.run();
    expect(batches).toEqual([['task'], ['asset']]);
  });

  it('ignores an empty notification', () => {
    const clock = manualScheduler();
    const batches: string[][] = [];
    const notify = createCoalescer(clock.schedule, (stores) => batches.push(stores));
    notify([]);
    expect(clock.size).toBe(0);
  });

  it('collects stores notified while a delivery is running into the next batch', () => {
    const clock = manualScheduler();
    const batches: string[][] = [];
    let notify: (stores: readonly string[]) => void = () => {};
    notify = createCoalescer(clock.schedule, (stores) => {
      batches.push(stores);
      if (batches.length === 1) notify(['preferences']);
    });
    notify(['task']);
    clock.run();
    clock.run();
    expect(batches).toEqual([['task'], ['preferences']]);
  });
});

describe('relevantStores', () => {
  it('filters to the stores a listener asked for', () => {
    expect(relevantStores(['task', 'version'], ['asset', 'task'])).toEqual(['task']);
    expect(relevantStores(['task'], ['asset'])).toBeNull();
    expect(relevantStores('*', ['asset'])).toEqual(['asset']);
    expect(relevantStores('*', [])).toBeNull();
  });
});

describe('syncChangedData', () => {
  it('is true only for a successful sync that wrote rows', () => {
    expect(syncChangedData({ ok: true, pulled: 2, conflicts: 0 })).toBe(true);
    expect(syncChangedData({ ok: true, pulled: 0, conflicts: 1 })).toBe(true);
    expect(syncChangedData({ ok: true, pulled: 0, conflicts: 0, pushed: 3 })).toBe(false);
    expect(syncChangedData({ ok: false, pulled: 5, conflicts: 0 })).toBe(false);
    expect(syncChangedData(null)).toBe(false);
  });
});
