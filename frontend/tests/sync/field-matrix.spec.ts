import { test, expect } from './helpers/devices';
import type { Device } from './helpers/devices';
import { assertConverged, assertFieldEverywhere, assertInvariants, capture } from './helpers/oracle';
import { SYNCED_TABLES, buildRow, sampleValue, seedParents as seedParentsWith, tableOf, type TableMeta } from './helpers/schema';

/**
 * Every store, every column, every value class — pushed from A, read back off
 * the server twice, pulled into B, and checked type-exactly against the value
 * the test INTENDED (not merely that the three copies agree, which an erased
 * field also satisfies).
 *
 * A column with no case here is a hole, and holes are where the bugs live.
 * Enum stores are not here: their rows never travel (see enum.spec.ts).
 */

/** Create the FK parents this table needs on `dev`, returning table -> id. */
const seedParents = (dev: Device, table: TableMeta, tag: string) =>
  seedParentsWith(table, tag, (store, row) => dev.call('rawPut', store, row));

/** Mirror the row-backed parents onto the other device (enum parents are already there). */
async function mirrorParents(dev: Device, parents: Record<string, string>): Promise<void> {
  for (const [parentTable, parentId] of Object.entries(parents)) {
    const parent = tableOf(parentTable);
    if (parent.enum) continue;
    await dev.call('rawPut', parentTable, buildRow(parent, parentId, {}, 1));
  }
}

for (const table of SYNCED_TABLES) {
  test.describe(table.name, () => {
    for (const col of table.columns) {
      // FK columns are exercised by the referential-integrity invariant rather
      // than by swapping values, which would just orphan the row.
      if (col.references) continue;

      test(col.name + ' (' + col.type + ') round-trips exactly', async ({
        deviceA,
        deviceB,
        backend,
      }) => {
        const id = 'fm-' + table.name + '-' + col.name;
        const parents = await seedParents(deviceA, table, id);
        await mirrorParents(deviceB, parents);

        // create with one value, then update to a distinct second one: a field
        // that only ever holds its default looks fine even when writes are lost.
        for (const variant of [0, 1]) {
          const value = sampleValue(col, variant);
          const row = { ...buildRow(table, id, parents, variant), [col.name]: value };
          await deviceA.call('repoPut', table.name, row);
          expect((await deviceA.sync()).ok).toBe(true);
          expect((await deviceB.sync()).ok).toBe(true);

          const legs = await capture(deviceA, deviceB, backend);
          assertFieldEverywhere(legs, table.name, id, col.name, value);
        }

        // null transition, where the column allows it: value -> null -> value.
        if (col.nullable) {
          await deviceA.call('repoPatch', table.name, id, { [col.name]: null });
          await deviceA.sync();
          await deviceB.sync();
          assertFieldEverywhere(await capture(deviceA, deviceB, backend), table.name, id, col.name, null);

          const back = sampleValue(col, 1);
          await deviceA.call('repoPatch', table.name, id, { [col.name]: back });
          await deviceA.sync();
          await deviceB.sync();
          assertFieldEverywhere(await capture(deviceA, deviceB, backend), table.name, id, col.name, back);
        }

        const legs = await capture(deviceA, deviceB, backend);
        assertConverged(legs, [table.name]);
        assertInvariants(legs.b, 'device B');
      });
    }

    test('an omitted optional field is preserved, not erased', async ({
      deviceA,
      deviceB,
      backend,
    }) => {
      const id = 'omit-' + table.name;
      const parents = await seedParents(deviceA, table, id);
      await mirrorParents(deviceB, parents);
      const full = buildRow(table, id, parents, 1);
      await deviceA.call('repoPut', table.name, full);
      await deviceA.sync();
      await deviceB.sync();

      // Push the row again with every non-key column stripped off the wire.
      // A server that lists all columns in its upsert binds NULL for the
      // missing ones and silently erases data the client never touched.
      await deviceA.call('repoPatch', table.name, id, {});
      await deviceA.page.route('**/sync/push', async (route) => {
        const body = JSON.parse(route.request().postData() ?? '{}') as {
          rows: Record<string, Record<string, unknown>[]>;
        };
        for (const rows of Object.values(body.rows ?? {})) {
          for (const row of rows) {
            if (row.id !== id) continue;
            for (const key of Object.keys(row)) {
              if (!['id', 'updated_at', 'deleted_at', 'server_seq', 'field_updated_at'].includes(key)) {
                delete row[key];
              }
            }
          }
        }
        await route.continue({ postData: JSON.stringify(body) });
      });
      await deviceA.sync();
      await deviceA.page.unroute('**/sync/push');

      const legs = await capture(deviceA, deviceB, backend);
      for (const col of table.columns) {
        if (col.references) continue;
        assertFieldEverywhere(legs, table.name, id, col.name, full[col.name]);
      }
    });
  });
}
