import { test, expect } from './helpers/devices';
import { assertConverged, assertInvariants, capture } from './helpers/oracle';
import { buildRow, tableOf } from './helpers/schema';

test('test mode makes the app observable: loading a page writes nothing', async ({ deviceA }) => {
  const before = await deviceA.dumpAll();
  await deviceA.goto('/settings/');
  await deviceA.goto('/');
  const after = await deviceA.dumpAll();
  // If this ever fails, something mutates synced data as a side effect of
  // rendering — which means no snapshot in this suite is trustworthy, and it
  // is a data-loss risk in production too.
  expect(after).toEqual(before);
});

test('A creates a row -> server holds it -> B pulls it, field-exact', async ({
  deviceA,
  deviceB,
  backend,
}) => {
  const table = tableOf('project');
  const row = buildRow(table, 'smoke-1', {}, 1);
  await deviceA.call('repoPut', 'project', row);

  const pushed = await deviceA.sync();
  expect(pushed.ok, pushed.error).toBe(true);
  expect(pushed.pushed).toBe(1);

  const pulled = await deviceB.sync();
  expect(pulled.ok, pulled.error).toBe(true);
  expect(pulled.pulled).toBe(1);

  const legs = await capture(deviceA, deviceB, backend);
  assertConverged(legs, ['project']);
  assertInvariants(legs.b, 'device B');
});

test('re-syncing changes nothing: the queue drains and stays drained', async ({
  deviceA,
  deviceB,
}) => {
  const row = buildRow(tableOf('project'), 'idem-1', {}, 1);
  await deviceA.call('repoPut', 'project', row);
  await deviceA.sync();
  await deviceB.sync();

  // The outbox is the push set. If it does not empty, every later sync re-sends
  // the same rows and widens every conflict window.
  expect(await deviceA.outbox()).toEqual([]);

  const again = await deviceA.sync();
  expect(again.pushed).toBe(0);
  const bAgain = await deviceB.sync();
  expect(bAgain.pushed).toBe(0);
  expect(bAgain.pulled).toBe(0);
});
