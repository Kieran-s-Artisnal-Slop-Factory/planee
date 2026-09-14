import { test, expect } from './helpers/devices';
import { assertInvariants } from './helpers/oracle';
import { STORE_NAMES, buildRow, tableOf } from './helpers/schema';

const T = 'project';
const table = tableOf(T);

test('a backup covers every store', async ({ deviceA }) => {
  const envelope = await deviceA.call<{ data: Record<string, unknown[]> }>('exportData');
  // A hand-maintained store list silently falling behind the schema is how
  // backups quietly stop covering half the app.
  expect(Object.keys(envelope.data).sort()).toEqual([...STORE_NAMES].sort());
});

test('a corrupt backup is rejected without changing anything', async ({ deviceA }) => {
  await deviceA.call('repoPut', T, buildRow(table, 'b1', {}, 1));
  const before = await deviceA.dumpAll();

  const broken = { schemaVersion: 1, exportedAt: new Date().toISOString(), data: { [T]: [{ nope: 1 }] } };
  await expect(deviceA.call('importData', broken, 'replace')).rejects.toThrow();

  expect(await deviceA.dumpAll(), 'a failed import half-applied').toEqual(before);
});

test('merge import never regresses a newer local row', async ({ deviceA }) => {
  await deviceA.call('rawPut', T, { ...buildRow(table, 'b2', {}, 1), updated_at: '2020-01-01T00:00:00.000Z' });
  const envelope = await deviceA.call<{ data: Record<string, unknown[]> }>('exportData');

  // Local row moves on after the backup was taken.
  await deviceA.call('repoPut', T, buildRow(table, 'b2', {}, 0));
  const newer = await deviceA.get(T, 'b2');

  const result = await deviceA.call<{ skipped: number }>('importData', envelope, 'merge');
  expect(result.skipped).toBeGreaterThan(0);
  expect((await deviceA.get(T, 'b2'))!.updated_at).toBe(newer!.updated_at);
});

test('merge import never resurrects a newer tombstone', async ({ deviceA }) => {
  await deviceA.call('repoPut', T, buildRow(table, 'b3', {}, 1));
  const envelope = await deviceA.call<{ data: Record<string, unknown[]> }>('exportData');
  await deviceA.call('repoSoftDelete', T, 'b3');

  await deviceA.call('importData', envelope, 'merge');
  expect((await deviceA.get(T, 'b3'))!.deleted_at, 'the backup un-deleted a row').toBeTruthy();
});

test('a full restore resets sync state so the device does not fork', async ({
  deviceA,
  deviceB,
}) => {
  await deviceA.call('repoPut', T, buildRow(table, 'b4', {}, 1));
  await deviceA.sync();
  await deviceB.sync();
  const envelope = await deviceA.call<{ data: Record<string, unknown[]> }>('exportData');

  // B moves the server on, then A restores an older backup.
  await deviceB.call('repoPut', T, buildRow(table, 'b5', {}, 1));
  await deviceB.sync();

  await deviceA.call('importData', envelope, 'replace');
  const cursors = await deviceA.cursors();
  // Keeping the old cursor is a silent permanent fork: A would sit above the
  // server's sequence and never pull the rows below it again.
  expect(cursors.lastPullSeq ?? 0).toBe(0);

  const after = await deviceA.sync();
  expect(after.ok, after.error).toBe(true);
  expect(await deviceA.get(T, 'b5'), 'the restored device never caught up').toBeTruthy();
  assertInvariants(await deviceA.dumpAll(), 'device A after restore');
});

test('a restore of an older backup does not wipe stores it never covered', async ({ deviceA }) => {
  await deviceA.call('repoPut', T, buildRow(table, 'b6', {}, 1));
  const envelope = await deviceA.call<{ data: Record<string, unknown[]> }>('exportData');
  const trimmed = { ...envelope, data: { [T]: envelope.data[T] } };
  await deviceA.call('importData', trimmed, 'replace');
  expect((await deviceA.dump(T)).length).toBeGreaterThan(0);
});
