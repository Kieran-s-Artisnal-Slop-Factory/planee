import { test, expect } from './helpers/devices';
import { diffValues, diffStore } from './helpers/compare';
import { assertConverged, assertIsolatedDelta, capture } from './helpers/oracle';
import { buildRow, tableOf } from './helpers/schema';

/**
 * Negative controls. Before trusting anything the oracle says is fine, prove it
 * says the right thing about a mismatch it was handed on purpose.
 */
test.describe('the comparator distinguishes what matters', () => {
  const cases: [string, unknown, unknown][] = [
    ['number vs string', 1, '1'],
    ['boolean vs number', true, 1],
    ['false vs 0', false, 0],
    ['null vs undefined', null, undefined],
    ['empty array vs null', [], null],
    ['float precision', 62.4999, 62.5],
    ['int coercion', 1.5, 1],
    ['unicode', 'ünï 😀', 'uni'],
    ['array order', ['a', 'b'], ['b', 'a']],
  ];
  for (const [name, left, right] of cases) {
    test(name, () => {
      expect(diffValues(left, right).length, name + ' was treated as equal').toBeGreaterThan(0);
      expect(diffValues(left, left)).toEqual([]);
    });
  }

  test('an absent key is not a null key', () => {
    expect(diffStore([{ id: '1', a: null }], [{ id: '1' }]).length).toBeGreaterThan(0);
  });
});

test('the oracle reports a corrupted device, instead of passing', async ({
  deviceA,
  deviceB,
  backend,
}) => {
  const row = buildRow(tableOf('project'), 'oracle-1', {}, 1);
  await deviceA.call('repoPut', 'project', row);
  await deviceA.sync();
  await deviceB.sync();

  const clean = await capture(deviceA, deviceB, backend);
  assertConverged(clean, ['project']); // genuinely converged

  // Corrupt B behind sync's back, then require the oracle to notice.
  const bRow = await deviceB.get('project', 'oracle-1');
  await deviceB.call('rawPut', 'project', { ...bRow, updated_at: '1999-01-01T00:00:00.000Z' });
  const dirty = await capture(deviceA, deviceB, backend);
  expect(() => assertConverged(dirty, ['project'])).toThrow();
});

test('the isolation diff pinpoints an unrelated write', async ({ deviceA }) => {
  const table = tableOf('project');
  await deviceA.call('repoPut', 'project', buildRow(table, 'iso-1', {}, 1));
  await deviceA.call('repoPut', 'project', buildRow(table, 'iso-2', {}, 1));
  const before = await deviceA.dumpAll();

  await deviceA.call('repoPut', 'project', buildRow(table, 'iso-1', {}, 0));
  await deviceA.call('repoPut', 'project', buildRow(table, 'iso-2', {}, 0));
  const after = await deviceA.dumpAll();

  // Only iso-1 was supposed to change; iso-2 must be reported.
  expect(() => assertIsolatedDelta(before, after, [{ store: 'project', id: 'iso-1' }])).toThrow();
});
