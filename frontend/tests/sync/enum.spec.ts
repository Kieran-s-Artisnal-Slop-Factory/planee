import { test, expect } from './helpers/devices';
import { normalizeStored } from './helpers/schema';
import { ENUM_TABLES, buildRow, enumRows, seedParents, tableOf } from './helpers/schema';
import { diffStore, formatDiffs } from './helpers/compare';

const byId = (rows: Record<string, unknown>[]) =>
  [...rows].sort((a, b) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0));

for (const table of ENUM_TABLES) {
  test.describe(table.name, () => {
    test('both devices and the server hold exactly the declared rows', async ({ deviceA, deviceB, backend }) => {
      const expected = enumRows(table);
      expect(expected.length, 'an enum with no values').toBeGreaterThan(0);
      expect(byId(await deviceA.dump(table.name))).toEqual(expected);
      expect(byId(await deviceB.dump(table.name))).toEqual(expected);
      // The server's own copy comes from schema.sql, not from a push.
      const stored = normalizeStored(await backend.stored())[table.name] ?? [];
      const diffs = diffStore(expected, byId(stored), []);
      expect(diffs.length, 'server enum rows differ from the schema:\n' + formatDiffs(diffs)).toBe(0);
    });

    test('the app refuses to write to it', async ({ deviceA }) => {
      await expect(
        deviceA.call('repoPut', table.name, { ...enumRows(table)[0]!, label: 'edited' })
      ).rejects.toThrow(/enum store/);
      expect(byId(await deviceA.dump(table.name))).toEqual(enumRows(table));
    });

    test('a backup neither carries it nor disturbs it on restore', async ({ deviceA }) => {
      const envelope = await deviceA.call<{ data: Record<string, unknown[]> }>('exportData');
      expect(Object.keys(envelope.data)).not.toContain(table.name);
      await deviceA.call('importData', envelope, 'replace');
      expect(byId(await deviceA.dump(table.name))).toEqual(enumRows(table));
    });
  });
}

test('enum rows never travel: a round trip pushes and pulls no enum store', async ({ deviceA, deviceB, backend }) => {
  const table = tableOf('preferences');
  const parents = await seedParents(table, 'enum-rt', (store, row) => deviceA.call('rawPut', store, row));
  for (const [parentTable, parentId] of Object.entries(parents)) {
    const parent = tableOf(parentTable);
    if (parent.enum) continue;
    await deviceB.call('rawPut', parentTable, buildRow(parent, parentId, {}, 1));
  }
  await deviceA.call('repoPut', table.name, buildRow(table, 'enum-rt', parents, 1));

  const pushed: string[] = [];
  await deviceA.page.route('**/sync/push', async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}') as { rows?: Record<string, unknown[]> };
    pushed.push(...Object.keys(body.rows ?? {}));
    await route.continue();
  });
  expect((await deviceA.sync()).ok).toBe(true);
  await deviceA.page.unroute('**/sync/push');
  expect((await deviceB.sync()).ok).toBe(true);

  const enumNames = ENUM_TABLES.map((t) => t.name);
  for (const name of enumNames) {
    expect(pushed, 'an enum store was pushed').not.toContain(name);
    expect(Object.keys(await backend.served()), 'an enum store was served by /sync/pull').not.toContain(name);
    expect(byId(await deviceB.dump(name))).toEqual(enumRows(tableOf(name)));
  }
  // and the row that references the enum did arrive, key intact
  const fk = table.columns.find((c) => c.references && tableOf(c.references).enum)!;
  const onB = await deviceB.get(table.name, 'enum-rt');
  expect(onB?.[fk.name]).toBe(parents[fk.references!]);
});
