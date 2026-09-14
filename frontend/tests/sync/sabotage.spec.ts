import { test, expect } from './helpers/devices';
import type { Device } from './helpers/devices';
import { assertConverged, assertFieldEverywhere, assertInvariants, capture } from './helpers/oracle';
import { SYNCED_TABLES, buildRow, sampleValue, seedParents, tableOf } from './helpers/schema';

/**
 * The trust gate: thirteen deliberate faults, each of which the oracle MUST
 * catch. Until this suite is green, no other green in this run means anything —
 * a harness that has never been shown to fail is unverified, not passing.
 *
 * Every test name starts with "sabotage:" because trust-gate.ts counts them and
 * fails the run when the count is zero.
 */

const T = 'project';
const table = tableOf(T);
const WITH_FK = SYNCED_TABLES.filter((t) => t.columns.some((c) => c.references));
const SINGLETONS = SYNCED_TABLES.filter((t) => t.singleton);

/** Seed one row on A and bring both devices into sync. */
async function seeded(a: Device, b: Device, id: string): Promise<void> {
  await a.call('repoPut', T, buildRow(table, id, {}, 1));
  await a.sync();
  await b.sync();
}

test('sabotage: a store dropped from the push is detected', async ({ deviceA, deviceB, backend }) => {
  await deviceA.call('repoPut', T, buildRow(table, 's1', {}, 1));
  await deviceA.page.route('**/sync/push', (route) =>
    route.continue({ postData: JSON.stringify({ rows: {} }) })
  );
  await deviceA.sync();
  await deviceA.page.unroute('**/sync/push');
  await deviceB.sync();

  const legs = await capture(deviceA, deviceB, backend);
  expect(() => assertConverged(legs, [T])).toThrow();
});

test('sabotage: a field nulled on the wire is detected', async ({ deviceA, deviceB, backend }) => {
  // Any table with a nullable non-FK column will do. Skipping when the default
  // table lacks one silently shrinks the trust gate, so search them all; a
  // schema with no nullable column anywhere is the only legitimate miss.
  const target = SYNCED_TABLES.find((t) => !t.singleton && t.columns.some((c) => c.nullable && !c.references));
  expect(target, 'no synced table has a nullable non-FK column to sabotage').toBeDefined();
  const nulled = target!;
  const col = nulled.columns.find((c) => c.nullable && !c.references);
  const intended = sampleValue(col!, 1);
  // Parents first, so the row is valid apart from the injected fault.
  const parents = await seedParents(nulled, 's2', async (store, row) => {
    await deviceA.call('repoPut', store, row);
  });
  await deviceA.call('repoPut', nulled.name, { ...buildRow(nulled, 's2', parents, 1), [col!.name]: intended });

  await deviceA.page.route('**/sync/push', async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}') as {
      rows: Record<string, Record<string, unknown>[]>;
    };
    for (const row of body.rows?.[nulled.name] ?? []) row[col!.name] = null;
    await route.continue({ postData: JSON.stringify(body) });
  });
  await deviceA.sync();
  await deviceA.page.unroute('**/sync/push');
  await deviceA.sync(); // A pulls its own erased row back
  await deviceB.sync();

  const legs = await capture(deviceA, deviceB, backend);
  // All four legs now AGREE — on the erased value. Convergence alone is fooled;
  // only the intended-value check sees it, which is why every field case in
  // field-matrix.spec.ts asserts against the value the test meant to write.
  expect(() => assertFieldEverywhere(legs, nulled.name, 's2', col!.name, intended)).toThrow();
});

test('sabotage: a retyped value is detected', async ({ deviceA, deviceB, backend }) => {
  await seeded(deviceA, deviceB, 's3');
  const row = await deviceB.get(T, 's3');
  // server_seq as a string instead of a number: the drift a wire-format change
  // causes, and exactly what a loose equality check waves through.
  await deviceB.call('rawPut', T, { ...row, server_seq: String(row!.server_seq) });
  const legs = await capture(deviceA, deviceB, backend);
  expect(() => assertConverged(legs, [T])).toThrow();
});

test('sabotage: an inflated pull cursor is detected', async ({ deviceA, deviceB, backend }) => {
  await deviceA.call('repoPut', T, buildRow(table, 's4', {}, 1));
  await deviceA.sync();
  // B's cursor jumps past the row — the "permanent pull hole" shape.
  await deviceB.call('setMeta', 'lastPullSeq', 99999);
  await deviceB.sync();

  expect(await deviceB.get(T, 's4')).toBeFalsy();
  const legs = await capture(deviceA, deviceB, backend);
  expect(() => assertConverged(legs, [T])).toThrow();
});

test('sabotage: a row dropped from the pull is detected', async ({ deviceA, deviceB, backend }) => {
  await deviceA.call('repoPut', T, buildRow(table, 's5', {}, 1));
  await deviceA.sync();
  await deviceB.page.route('**/sync/pull*', async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { rows: Record<string, unknown[]> };
    body.rows = {};
    await route.fulfill({ response: res, body: JSON.stringify(body) });
  });
  await deviceB.sync();
  await deviceB.page.unroute('**/sync/pull*');

  const legs = await capture(deviceA, deviceB, backend);
  expect(() => assertConverged(legs, [T])).toThrow();
});

test('sabotage: a clock-skewed local edit is detected', async ({ deviceA, deviceB, backend }) => {
  await seeded(deviceA, deviceB, 's6');
  await deviceB.call('rawPut', T, {
    ...(await deviceB.get(T, 's6')),
    updated_at: '1999-01-01T00:00:00.000Z',
  });
  const legs = await capture(deviceA, deviceB, backend);
  expect(() => assertConverged(legs, [T])).toThrow();
});

test('sabotage: an orphaned child row is detected', async ({ deviceA }) => {
  test.skip(WITH_FK.length === 0, 'schema has no foreign keys');
  const child = WITH_FK[0]!;
  const fk = child.columns.find((c) => c.references)!;
  await deviceA.call('rawPut', child.name, {
    ...buildRow(child, 's7', {}, 1),
    [fk.name]: 'no-such-parent',
  });
  const db = await deviceA.dumpAll();
  expect(() => assertInvariants(db, 'device A')).toThrow();
});

test('sabotage: a duplicated single-row table is detected', async ({ deviceA }) => {
  test.skip(SINGLETONS.length === 0, 'schema has no single-row tables');
  const single = SINGLETONS[0]!;
  await deviceA.call('rawPut', single.name, buildRow(single, 'singleton', {}, 1));
  await deviceA.call('rawPut', single.name, buildRow(single, 'rogue-uuid', {}, 1));
  const db = await deviceA.dumpAll();
  expect(() => assertInvariants(db, 'device A')).toThrow();
});

test('sabotage: a hard delete without a tombstone is detected', async ({ deviceA, deviceB, backend }) => {
  await seeded(deviceA, deviceB, 's9');
  await deviceB.call('rawDelete', T, 's9');
  const legs = await capture(deviceA, deviceB, backend);
  expect(() => assertConverged(legs, [T])).toThrow();
});

test('sabotage: a faked push success does not drop the change', async ({ deviceA, deviceB }) => {
  await deviceA.call('repoPut', T, buildRow(table, 's10', {}, 1));
  await deviceA.page.route('**/sync/push', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ accepted: [], latestSeq: 0 }),
    })
  );
  const result = await deviceA.sync();
  await deviceA.page.unroute('**/sync/push');

  expect(result.pushed).toBe(0);
  // A 200 that accepted nothing must leave the row queued. Clearing the queue
  // because "the request succeeded" rather than "the server took this row" is
  // how a change disappears with no error anywhere.
  expect((await deviceA.outbox()).length).toBeGreaterThan(0);
  await deviceB.sync();
  expect(await deviceB.get(T, 's10')).toBeFalsy();
});

test('sabotage: an HTTP 500 on push is surfaced, not swallowed', async ({ deviceA }) => {
  await deviceA.call('repoPut', T, buildRow(table, 's11', {}, 1));
  await deviceA.page.route('**/sync/push', (route) => route.fulfill({ status: 500, body: 'boom' }));
  const result = await deviceA.sync();
  await deviceA.page.unroute('**/sync/push');

  expect(result.ok).toBe(false);
  expect(result.error).toBeTruthy();
  expect((await deviceA.outbox()).length).toBeGreaterThan(0);
});

test('sabotage: one unstorable row does not stop the rest of the batch', async ({
  deviceA,
  deviceB,
}) => {
  await deviceA.call('repoPut', T, buildRow(table, 's12-good', {}, 1));
  // A row the server cannot store, queued behind the app's back. Historically
  // this 500'd the whole batch and the client retried the same payload forever,
  // halting ALL sync in both directions for that device.
  await deviceA.call('rawPut', T, { id: 's12-bad', updated_at: '', deleted_at: null, server_seq: null });
  await deviceA.call('enqueue', T, 's12-bad', '');
  await deviceA.call('repoPut', T, buildRow(table, 's12-good2', {}, 1));

  const result = await deviceA.sync();
  expect(result.ok, result.error).toBe(true);
  expect(result.rejected, 'the unstorable row was not reported').toBeGreaterThan(0);

  await deviceB.sync();
  expect(await deviceB.get(T, 's12-good'), 'a good row was lost to a bad one').toBeTruthy();
  expect(await deviceB.get(T, 's12-good2')).toBeTruthy();

  // ...and the poison row does not make every later push fail.
  const again = await deviceA.sync();
  expect(again.ok).toBe(true);
});

test('sabotage: server treats version_task as whole-row LWW', async ({ deviceA, deviceB, backend }) => {
  // Whole-row last-write-wins, wherever it happens, looks like this from the
  // outside: the later write carries every field, so an earlier concurrent
  // edit to a DIFFERENT field is lost. Injected here the way it happens for
  // real — a client that saves a whole version_task row from a stale UI
  // snapshot (put, not patch), which stamps every field with "now". The
  // per-field concurrency assertion must see A's status edit disappear.
  const vt = tableOf('version_task');
  const id = 's13';
  const parents = await seedParents(vt, id, async (store, row) => {
    await deviceA.call('repoPut', store, row);
  });
  await deviceA.call('repoPut', 'version_task', { ...buildRow(vt, id, parents, 0), status: 'todo', position: 1 });
  await deviceA.sync();
  await deviceB.sync();

  // B renders the row, then A moves the card to in_progress and syncs.
  const staleOnB = (await deviceB.get('version_task', id))!;
  await deviceA.call('repoPatch', 'version_task', id, { status: 'in_progress' });
  await deviceA.sync();

  // B saves its (stale) snapshot with a new position: every field re-stamped
  // with now — strictly after A's edit, which completed a push round trip ago.
  const at = new Date().toISOString();
  const stamps = Object.fromEntries(vt.columns.map((c) => [c.name, at]));
  await deviceB.call('rawPut', 'version_task', {
    ...staleOnB,
    position: 2,
    updated_at: at,
    field_updated_at: { ...stamps, deleted_at: at },
  });
  await deviceB.call('enqueue', 'version_task', id, at);
  await deviceB.sync();
  await deviceA.sync();

  const legs = await capture(deviceA, deviceB, backend);
  // Everyone agrees — on the clobbered row. Only the intended value notices.
  assertConverged(legs, ['version_task']);
  assertFieldEverywhere(legs, 'version_task', id, 'position', 2);
  expect(() => assertFieldEverywhere(legs, 'version_task', id, 'status', 'in_progress')).toThrow();
});
