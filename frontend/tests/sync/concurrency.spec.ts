import { test, expect } from './helpers/devices';
import { assertConverged, assertInvariants, capture } from './helpers/oracle';
import { buildRow, tableOf } from './helpers/schema';

const T = 'project';
const table = tableOf(T);

/** Both devices established, holding data, pulling incrementally. */
async function bothInSync(a: { sync(): Promise<unknown> }, b: { sync(): Promise<unknown> }) {
  await a.sync();
  await b.sync();
  await a.sync();
}

test('an update to a row B already holds reaches B', async ({ deviceA, deviceB, backend }) => {
  await deviceA.call('repoPut', T, buildRow(table, 'c1', {}, 1));
  await bothInSync(deviceA, deviceB);

  await deviceA.call('repoPut', T, buildRow(table, 'c1', {}, 0));
  await deviceA.sync();
  const pulled = await deviceB.sync();
  expect(pulled.pulled).toBe(1);

  assertConverged(await capture(deviceA, deviceB, backend), [T]);
});

test('a tombstone propagates and is not resurrected', async ({ deviceA, deviceB, backend }) => {
  await deviceA.call('repoPut', T, buildRow(table, 'c2', {}, 1));
  await bothInSync(deviceA, deviceB);

  await deviceA.call('repoSoftDelete', T, 'c2');
  await deviceA.sync();
  await deviceB.sync();

  const onB = await deviceB.get(T, 'c2');
  expect(onB, 'the row vanished entirely — deletes must be tombstones, not hard deletes').toBeTruthy();
  expect(onB!.deleted_at, 'tombstone did not propagate to B').toBeTruthy();

  // And it stays deleted after another round trip in both directions.
  await bothInSync(deviceB, deviceA);
  expect((await deviceA.get(T, 'c2'))!.deleted_at).toBeTruthy();
  assertConverged(await capture(deviceA, deviceB, backend), [T]);
});

test('the LWW loser adopts the winner instead of diverging forever', async ({
  deviceA,
  deviceB,
  backend,
}) => {
  await deviceA.call('repoPut', T, buildRow(table, 'c3', {}, 1));
  await bothInSync(deviceA, deviceB);

  // B edits with an OLDER timestamp than A's edit — the shape a slow clock
  // produces. B's push loses; historically B then kept its rejected edit
  // forever, because its pull cursor was already past that row.
  const aRow = { ...buildRow(table, 'c3', {}, 0), updated_at: '2030-01-01T00:00:00.000Z' };
  const bRow = { ...buildRow(table, 'c3', {}, 1), updated_at: '2029-01-01T00:00:00.000Z' };
  // rawPut bypasses the repo, so it also bypasses the outbox; queue the edits
  // explicitly or neither device has anything to push.
  await deviceA.call('rawPut', T, aRow);
  await deviceA.call('enqueue', T, 'c3', aRow.updated_at);
  await deviceB.call('rawPut', T, bRow);
  await deviceB.call('enqueue', T, 'c3', bRow.updated_at);
  await deviceA.sync();

  const bResult = await deviceB.sync();
  expect(bResult.ok, bResult.error).toBe(true);
  expect(bResult.conflicts, 'the server did not hand back the winning row').toBeGreaterThan(0);

  const converged = await deviceB.get(T, 'c3');
  expect(converged!.updated_at).toBe('2030-01-01T00:00:00.000Z');
  assertConverged(await capture(deviceA, deviceB, backend), [T]);
});

test('an exact timestamp tie resolves the same way on both sides', async ({
  deviceA,
  deviceB,
  backend,
}) => {
  const at = '2030-06-01T12:00:00.000Z';
  await deviceA.call('rawPut', T, { ...buildRow(table, 'c4', {}, 0), updated_at: at });
  await deviceB.call('rawPut', T, { ...buildRow(table, 'c4', {}, 1), updated_at: at });
  await deviceA.call('repoPatch', T, 'c4', {});
  await deviceA.call('rawPut', T, { ...(await deviceA.get(T, 'c4'))!, updated_at: at });
  await deviceA.sync();
  await deviceB.sync();
  await deviceB.sync();
  await deviceA.sync();

  // Opposite tie rules (server skips on <=, client applies on >=) leave the two
  // sides on different rows permanently. They must land on the same one.
  assertConverged(await capture(deviceA, deviceB, backend), [T]);
});

test('delete then recreate under the same id converges', async ({ deviceA, deviceB, backend }) => {
  await deviceA.call('repoPut', T, buildRow(table, 'c5', {}, 1));
  await bothInSync(deviceA, deviceB);
  await deviceA.call('repoSoftDelete', T, 'c5');
  await deviceA.sync();
  await deviceA.call('repoPut', T, { ...buildRow(table, 'c5', {}, 0), deleted_at: null });
  await deviceA.sync();
  await deviceB.sync();

  expect((await deviceB.get(T, 'c5'))!.deleted_at).toBeNull();
  assertConverged(await capture(deviceA, deviceB, backend), [T]);
});

test('a row queued while a push is in flight is not lost', async ({ deviceA, deviceB, backend }) => {
  await deviceA.call('repoPut', T, buildRow(table, 'c6', {}, 1));

  // Hold the push open, write a second row mid-flight, then release. A
  // timestamp watermark loses this row; an outbox cannot.
  await deviceA.page.route('**/sync/push', async (route) => {
    await deviceA.call('repoPut', T, buildRow(table, 'c7', {}, 1));
    await route.continue();
  });
  await deviceA.sync();
  await deviceA.page.unroute('**/sync/push');

  await deviceA.sync();
  await deviceB.sync();
  expect(await deviceB.get(T, 'c7'), 'the row written during the push never arrived').toBeTruthy();
  assertInvariants(await deviceB.dumpAll(), 'device B');
  assertConverged(await capture(deviceA, deviceB, backend), [T]);
});

test('a rebuilt server resets the cursor instead of silently under-fetching', async ({
  deviceA,
}) => {
  await deviceA.call('repoPut', T, buildRow(table, 'c8', {}, 1));
  await deviceA.sync();
  const before = await deviceA.cursors();
  expect(before.serverEpoch).toBeTruthy();

  // Pretend we had been syncing with a different database all along.
  await deviceA.call('setMeta', 'serverEpoch', 'a-different-server');
  await deviceA.sync();

  const after = await deviceA.cursors();
  expect(after.serverEpoch, 'the client did not notice the server identity change').toBe(
    before.serverEpoch
  );
});
