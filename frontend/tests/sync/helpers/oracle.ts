import { expect } from '@playwright/test';
import type { Backend } from './backend';
import type { Device } from './devices';
import { diffDb, diffStore, formatDiffs, type Rows } from './compare';
import { TABLES, STORE_NAMES } from './schema';

export type Db = Record<string, Rows>;

/**
 * Bookkeeping the client keeps and the server does not, or vice versa. Ignored
 * only when comparing a client leg against a server leg — never between the
 * two devices, where a divergent server_seq is itself a finding.
 */
const CLIENT_ONLY = ['server_seq'];

export interface FourLeg {
  a: Db;
  b: Db;
  served: Db;
  stored: Db;
}

/**
 * Capture all four legs.
 *
 * The server counts TWICE — what it serves via /sync/pull and what is actually
 * in its sqlite file — because those can disagree (a value mangled on write
 * but re-derived on read, a column dropped from the pull's select). A
 * pull-only view launders exactly that class of corruption.
 */
export async function capture(a: Device, b: Device, backend: Backend): Promise<FourLeg> {
  return {
    a: await a.dumpAll(),
    b: await b.dumpAll(),
    served: (await backend.served()) as Db,
    stored: (await backend.stored()) as Db,
  };
}

/** Assert every leg agrees, naming which pair diverged. */
export function assertConverged(legs: FourLeg, stores: string[] = STORE_NAMES): void {
  const pick = (db: Db) => Object.fromEntries(stores.map((s) => [s, db[s] ?? []]));
  const pairs: [string, Db, Db, string[]][] = [
    ['device A <-> device B', pick(legs.a), pick(legs.b), []],
    ['device A <-> server (served)', pick(legs.a), pick(legs.served), CLIENT_ONLY],
    ['server (served) <-> server (stored)', pick(legs.served), pick(legs.stored), []],
  ];
  for (const [label, left, right, ignore] of pairs) {
    const diffs = diffDb(left, right, ignore);
    expect(diffs.length === 0, label + ' diverged:\n' + formatDiffs(diffs)).toBe(true);
  }
}

/**
 * Assert a field holds the value the test INTENDED, on every leg.
 *
 * Convergence alone is not enough and this is the subtle part: if a push
 * erases a field, the server stores the erased value, the pusher pulls its own
 * row back and overwrites its local copy, and all four legs happily agree — on
 * the erased value. Only an expected-value check catches that.
 */
export function assertFieldEverywhere(
  legs: FourLeg,
  store: string,
  id: string,
  field: string,
  expected: unknown
): void {
  const legNames: (keyof FourLeg)[] = ['a', 'b', 'served', 'stored'];
  for (const leg of legNames) {
    const row = (legs[leg][store] ?? []).find((r) => r.id === id);
    expect(row, store + '/' + id + ' missing on leg "' + String(leg) + '"').toBeTruthy();
    const diffs = diffStore(
      [{ id, [field]: expected }],
      [{ id, [field]: row![field] }]
    );
    expect(
      diffs.length === 0,
      'leg "' + String(leg) + '" ' + store + '.' + field + ':\n' + formatDiffs(diffs)
    ).toBe(true);
  }
}

/**
 * The collateral-damage detector.
 *
 * After a case changes ONE field of ONE row, the total delta across every store
 * on both devices must be exactly that change. Most real data loss shows up
 * here rather than in the targeted assertion: a reconcile pass restamping
 * unrelated rows, a pull clobbering a locally-edited field, a save rewriting
 * every sibling's position.
 */
export function assertIsolatedDelta(before: Db, after: Db, allowed: { store: string; id: string }[]): void {
  const allow = new Set(allowed.map((x) => x.store + ':' + x.id));
  const unexpected = diffDb(before, after)
    .filter((d) => {
      const [store, rest] = d.path.split('.', 2);
      const id = (rest ?? '').replace(/^id=/, '').split(/[.[]/, 1)[0];
      return !allow.has(store + ':' + id);
    })
    .map((d) => d.path);
  expect(
    unexpected.length === 0,
    'unrelated rows changed:\n  ' + [...new Set(unexpected)].join('\n  ')
  ).toBe(true);
}

/**
 * Structural invariants that must hold on ANY converged database, checked after
 * every real case and deliberately tripped by the sabotage suite.
 */
export function assertInvariants(db: Db, label: string): void {
  const live = (store: string) => (db[store] ?? []).filter((r) => !r.deleted_at);

  for (const table of TABLES) {
    const rows = db[table.name] ?? [];

    // 1. ids are unique within a store.
    const ids = rows.map((r) => String(r.id));
    expect(new Set(ids).size, label + ': duplicate ids in ' + table.name).toBe(ids.length);

    // 2. a single-row table holds exactly one row — the classic
    //    "logical singleton with a random id" duplicate is invisible until two
    //    devices each mint one and reads become nondeterministic.
    if (table.singleton) {
      expect(live(table.name).length, label + ': ' + table.name + ' is not a singleton').toBeLessThanOrEqual(1);
    }

    // 3. every live FK points at a row that exists.
    for (const col of table.columns) {
      if (!col.references) continue;
      const parentIds = new Set((db[col.references] ?? []).map((r) => String(r.id)));
      for (const row of live(table.name)) {
        const value = row[col.name];
        if (value == null) continue;
        expect(
          parentIds.has(String(value)),
          label + ': ' + table.name + '.' + col.name + ' = ' + String(value) + ' has no ' + col.references
        ).toBe(true);
      }
    }

    // 4. sync bookkeeping is well-formed.
    for (const row of rows) {
      expect(typeof row.updated_at, label + ': ' + table.name + ' row has no updated_at').toBe('string');
    }
  }
}
