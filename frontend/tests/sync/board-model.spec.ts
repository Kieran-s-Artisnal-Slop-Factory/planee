import { test, expect, makeDevice } from './helpers/devices';
import type { Device } from './helpers/devices';
import type { Backend } from './helpers/backend';
import { diffStore, formatDiffs } from './helpers/compare';
import { createV2Database, describeDatabase, v1ServerSql, type LegacyRows } from './helpers/legacy';
import {
  assertConverged,
  assertFieldEverywhere,
  assertInvariants,
  assertIsolatedDelta,
  capture,
  type FourLeg,
} from './helpers/oracle';
import { buildRow, seedParents, tableOf } from './helpers/schema';

/**
 * The board's data model (schema v3): per-field merge on the four data tables,
 * version completion, float board positions, synced assets, and upgrading an
 * install that predates all of it.
 *
 * Every case checks all four legs (A, B, what the server serves, what it
 * stored), the value each edit INTENDED, the isolation of the delta and the
 * structural invariants.
 */

/** Seed a row (and its FK parents) on A through the repo, and bring both devices into sync. */
async function seedSynced(
  a: Device,
  b: Device,
  store: string,
  id: string,
  values: Record<string, unknown>
): Promise<void> {
  const table = tableOf(store);
  const parents = await seedParents(table, id, async (s, row) => {
    await a.call('repoPut', s, row);
  });
  await a.call('repoPut', store, { ...buildRow(table, id, parents, 0), ...values });
  for (const dev of [a, b, a]) expect((await dev.sync()).ok).toBe(true);
}

function assertInvariantsEverywhere(legs: FourLeg): void {
  assertInvariants(legs.a, 'device A');
  assertInvariants(legs.b, 'device B');
  assertInvariants(legs.served, 'server (served)');
  assertInvariants(legs.stored, 'server (stored)');
}

function assertIsolatedEverywhere(before: FourLeg, after: FourLeg, allowed: { store: string; id: string }[]): void {
  assertIsolatedDelta(before.a, after.a, allowed);
  assertIsolatedDelta(before.b, after.b, allowed);
  assertIsolatedDelta(before.served, after.served, allowed);
  assertIsolatedDelta(before.stored, after.stored, allowed);
}

/**
 * Two devices edit DIFFERENT fields of one synced row concurrently — neither
 * has seen the other's edit — then sync A, B, A. Per-field merge must keep
 * both edits on every leg.
 */
async function concurrentFieldEdits(
  a: Device,
  b: Device,
  backend: Backend,
  store: string,
  id: string,
  seed: Record<string, unknown>,
  aChange: Record<string, unknown>,
  bChange: Record<string, unknown>
): Promise<FourLeg> {
  await seedSynced(a, b, store, id, seed);
  const before = await capture(a, b, backend);

  expect(await a.call('repoPatch', store, id, aChange)).toBeTruthy();
  expect(await b.call('repoPatch', store, id, bChange)).toBeTruthy();
  for (const dev of [a, b, a]) {
    const result = await dev.sync();
    expect(result.ok, result.error).toBe(true);
  }

  const legs = await capture(a, b, backend);
  assertConverged(legs);
  for (const [field, value] of Object.entries({ ...aChange, ...bChange })) {
    assertFieldEverywhere(legs, store, id, field, value);
  }
  assertIsolatedEverywhere(before, legs, [{ store, id }]);
  assertInvariantsEverywhere(legs);
  return legs;
}

test.describe('per-field merge', () => {
  test('version_task: status (A) and position (B) edited concurrently both survive', async ({
    deviceA,
    deviceB,
    backend,
  }) => {
    await concurrentFieldEdits(
      deviceA,
      deviceB,
      backend,
      'version_task',
      'bm-vt',
      { status: 'todo', position: 1 },
      { status: 'in_progress' },
      { position: 2.5 }
    );
  });

  test('task: title (A) and description (B) edited concurrently both survive', async ({
    deviceA,
    deviceB,
    backend,
  }) => {
    await concurrentFieldEdits(
      deviceA,
      deviceB,
      backend,
      'task',
      'bm-task',
      { title: 'Original title', description: 'Original description', task_type: 'feature', priority: 4 },
      { title: 'Renamed on A' },
      { description: '## Edited on B\n\n- [ ] with a checklist' }
    );
  });

  test('version: completed (A) and description (B) edited concurrently both survive, completed stays boolean', async ({
    deviceA,
    deviceB,
    backend,
  }) => {
    const legs = await concurrentFieldEdits(
      deviceA,
      deviceB,
      backend,
      'version',
      'bm-version',
      { number: '0.1.0', description: null, completed: false },
      { completed: true },
      { description: 'Release notes written on B' }
    );
    // assertFieldEverywhere already compares type-exactly; spell the boolean
    // out as well, since `1` from sqlite is the specific failure this guards.
    for (const leg of ['a', 'b', 'served', 'stored'] as const) {
      const row = legs[leg].version!.find((r) => r.id === 'bm-version')!;
      expect(row.completed, 'version.completed on leg ' + leg).toBe(true);
      expect(typeof row.completed, 'version.completed type on leg ' + leg).toBe('boolean');
    }
  });
});

test('version_task.position round-trips floats exactly', async ({ deviceA, deviceB, backend }) => {
  const id = 'bm-float';
  await seedSynced(deviceA, deviceB, 'version_task', id, { status: 'todo', position: 0 });

  // Each value is a way a float gets mangled: the classic binary-rounding
  // artefact (a REAL printed with too few digits), a negative fraction, and an
  // exponent-notation value (JSON encoders switch to 1e-7 form here).
  for (const position of [0.30000000000000004, -1.5, 1e-7]) {
    const before = await capture(deviceA, deviceB, backend);
    await deviceA.call('repoPatch', 'version_task', id, { position });
    expect((await deviceA.sync()).ok).toBe(true);
    expect((await deviceB.sync()).ok).toBe(true);

    const legs = await capture(deviceA, deviceB, backend);
    assertFieldEverywhere(legs, 'version_task', id, 'position', position);
    assertConverged(legs);
    assertIsolatedEverywhere(before, legs, [{ store: 'version_task', id }]);
    assertInvariantsEverywhere(legs);
  }
});

test('a ~1 MB asset pushes and pulls intact', async ({ deviceA, deviceB, backend }) => {
  const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
  // 786,432 bytes -> exactly 1 MiB of base64, patterned so a truncated or
  // reordered chunk cannot compare equal.
  const bytes = Buffer.alloc(786_432);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + (i >> 8)) % 256;
  const data = bytes.toString('base64');
  expect(data.length).toBe(1024 * 1024);

  const before = await capture(deviceA, deviceB, backend);
  const row = {
    ...buildRow(tableOf('asset'), id, {}, 0),
    name: 'big.png',
    mime: 'image/png',
    size: bytes.length,
    data,
  };
  await deviceA.call('repoPut', 'asset', row);
  expect((await deviceA.sync()).ok).toBe(true);
  const pulled = await deviceB.sync();
  expect(pulled.ok, pulled.error).toBe(true);

  const legs = await capture(deviceA, deviceB, backend);
  for (const [field, value] of Object.entries({ name: 'big.png', mime: 'image/png', size: bytes.length, data })) {
    assertFieldEverywhere(legs, 'asset', id, field, value);
  }
  assertConverged(legs);
  assertIsolatedEverywhere(before, legs, [{ store: 'asset', id }]);
  assertInvariantsEverywhere(legs);
});

// ---------------------------------------------------------------------------
// Upgrade: an old device AND an old server, both holding the same data
// ---------------------------------------------------------------------------

const V1_EPOCH = 'feedfacefeedfacefeedfacefeedface';
const T = (n: number) => `2026-01-01T00:00:0${n}.000Z`;
const TOMBSTONED_AT = '2026-01-02T00:00:00.000Z';

/**
 * Rows as the old builds held them, identical on the old device and the old
 * server — the state after the old client synced. v2 shapes: project has the
 * free-text `version` and no name; task has no title or type; version_task has
 * no status or position; nothing but preferences has field_updated_at.
 */
const LEGACY: LegacyRows = {
  project: [{ id: 'up-p1', description: 'Planee', version: '0.1.0', updated_at: T(0), deleted_at: null, server_seq: 1 }],
  version: [{ id: 'up-v1', number: '0.1.0', project: 'up-p1', updated_at: T(1), deleted_at: null, server_seq: 2 }],
  task: [
    {
      id: 'up-t1',
      project: 'up-p1',
      description: 'Write the migration',
      priority: 2,
      subtasks: '- [ ] server\n- [x] client',
      updated_at: T(2),
      deleted_at: null,
      server_seq: 3,
    },
    // priority 3 was the old default; it must stay 3, not become the new default 4.
    { id: 'up-t2', project: 'up-p1', description: null, priority: 3, subtasks: null, updated_at: T(3), deleted_at: null, server_seq: 4 },
  ],
  version_task: [
    { id: 'up-vt1', version: 'up-v1', task: 'up-t1', updated_at: T(4), deleted_at: null, server_seq: 5 },
    // Tombstones upgrade too: they still sync and back up.
    { id: 'up-vt2', version: 'up-v1', task: 'up-t2', updated_at: T(5), deleted_at: TOMBSTONED_AT, server_seq: 6 },
  ],
  // Untouched by the v3 upgrade; the v4 upgrade (server migration v3) adds
  // recent_issues_count and must leave the rest, stamps included, alone.
  preferences: [
    {
      id: 'singleton',
      default_task_type: 'bug',
      updated_at: T(6),
      deleted_at: null,
      server_seq: 7,
      field_updated_at: { default_task_type: T(6), deleted_at: T(6) },
    },
  ],
};
const LEGACY_LAST_SEQ = 7;

/**
 * What every leg must hold after both sides upgrade, written out by hand
 * rather than derived from backfill.ts or the Go migration, so a wrong default
 * on either side cannot vouch for itself. updated_at and server_seq are the
 * legacy values, unchanged.
 */
const UPGRADED: LegacyRows = {
  project: [
    { id: 'up-p1', name: '', description: 'Planee', updated_at: T(0), deleted_at: null, server_seq: 1, field_updated_at: {} },
  ],
  version: [
    {
      id: 'up-v1',
      number: '0.1.0',
      project: 'up-p1',
      description: null,
      completed: false,
      updated_at: T(1),
      deleted_at: null,
      server_seq: 2,
      field_updated_at: {},
    },
  ],
  task: [
    {
      id: 'up-t1',
      project: 'up-p1',
      title: '',
      task_type: 'feature',
      description: 'Write the migration',
      priority: 2,
      subtasks: '- [ ] server\n- [x] client',
      updated_at: T(2),
      deleted_at: null,
      server_seq: 3,
      field_updated_at: {},
    },
    {
      id: 'up-t2',
      project: 'up-p1',
      title: '',
      task_type: 'feature',
      description: null,
      priority: 3,
      subtasks: null,
      updated_at: T(3),
      deleted_at: null,
      server_seq: 4,
      field_updated_at: {},
    },
  ],
  version_task: [
    {
      id: 'up-vt1',
      version: 'up-v1',
      task: 'up-t1',
      status: 'todo',
      position: 0,
      updated_at: T(4),
      deleted_at: null,
      server_seq: 5,
      field_updated_at: {},
    },
    {
      id: 'up-vt2',
      version: 'up-v1',
      task: 'up-t2',
      status: 'todo',
      position: 0,
      updated_at: T(5),
      deleted_at: TOMBSTONED_AT,
      server_seq: 6,
      field_updated_at: {},
    },
  ],
  asset: [],
  preferences: [
    {
      id: 'singleton',
      default_task_type: 'bug',
      recent_issues_count: 6,
      updated_at: T(6),
      deleted_at: null,
      server_seq: 7,
      // No stamp for recent_issues_count on either side: it falls back to updated_at.
      field_updated_at: { default_task_type: T(6), deleted_at: T(6) },
    },
  ],
};

test.describe('schema upgrade', () => {
  // The server starts on a database the v1 server build left behind and runs
  // its v2 and v3 migrations at startup, on real rows.
  test.use({ backendSeedSql: v1ServerSql(LEGACY, { epoch: V1_EPOCH, lastSeq: LEGACY_LAST_SEQ }) });

  test('an old device and an old server upgrade independently and converge with no push', async ({
    browser,
    backend,
    deviceB,
  }) => {
    // Device A: a browser profile the v2 client build had been syncing with
    // that server. Build its IndexedDB with the raw API on the app's origin
    // before any app page runs, so the app's own open is the v2 -> v4 upgrade.
    const context = await browser.newContext();
    const deviceA = await makeDevice(context, backend, 'A');
    await deviceA.page.goto(backend.url + '/favicon.svg');
    await createV2Database(deviceA.page, LEGACY, {
      lastPullSeq: LEGACY_LAST_SEQ,
      serverEpoch: V1_EPOCH,
      lastSyncAt: TOMBSTONED_AT,
      lastError: null,
    });
    const legacy = await describeDatabase(deviceA.page);
    expect(legacy.version).toBe(2);
    expect(Object.keys(legacy.stores)).not.toContain('asset');

    // The server kept its identity across the migration, so A's cursor is
    // still valid and nothing forces a reset-and-requeue.
    expect(await backend.epoch()).toBe(V1_EPOCH);

    await deviceA.goto('/');
    const upgradedA = await deviceA.dumpAll();

    // The upgrade is not an edit: nothing queued, nothing restamped.
    expect(await deviceA.outbox(), 'the upgrade queued rows for push').toEqual([]);
    const shape = await describeDatabase(deviceA.page);
    expect(shape.version).toBe(4);
    expect(shape.stores.asset).toEqual({ keyPath: 'id', indexes: [] });
    expect(shape.stores.version!.indexes).toEqual(['project']);
    expect(shape.stores.task!.indexes).toEqual(['project']);
    expect(shape.stores.version_task!.indexes).toEqual(['task', 'version']);

    const beforeSync = await capture(deviceA, deviceB, backend);
    const syncA = await deviceA.sync();
    expect(syncA.ok, syncA.error).toBe(true);
    expect(syncA.pushed, 'the upgraded device pushed rows it never edited').toBe(0);
    expect(syncA.pulled).toBe(0);
    expect(await deviceA.cursors()).toMatchObject({ lastPullSeq: LEGACY_LAST_SEQ, serverEpoch: V1_EPOCH });

    // Device B: a fresh install at the current schema joining afterwards.
    const syncB = await deviceB.sync();
    expect(syncB.ok, syncB.error).toBe(true);
    expect(syncB.pushed).toBe(0);
    const legs = await capture(deviceA, deviceB, backend);

    // Every leg holds exactly the upgraded rows: backfilled defaults, the
    // dropped column gone, legacy updated_at and server_seq untouched.
    for (const leg of ['a', 'b', 'served', 'stored'] as const) {
      for (const [store, expected] of Object.entries(UPGRADED)) {
        const diffs = diffStore(expected, legs[leg][store] ?? []);
        expect(diffs.length === 0, `leg "${leg}" ${store} after upgrade:\n` + formatDiffs(diffs)).toBe(true);
      }
    }
    for (const [store, expected] of Object.entries(UPGRADED)) {
      const diffs = diffStore(expected, upgradedA[store] ?? []);
      expect(diffs.length === 0, `device A ${store} straight after the upgrade:\n` + formatDiffs(diffs)).toBe(true);
    }
    assertFieldEverywhere(legs, 'project', 'up-p1', 'name', '');
    assertFieldEverywhere(legs, 'version', 'up-v1', 'completed', false);
    assertFieldEverywhere(legs, 'version', 'up-v1', 'description', null);
    assertFieldEverywhere(legs, 'task', 'up-t1', 'title', '');
    assertFieldEverywhere(legs, 'task', 'up-t1', 'task_type', 'feature');
    assertFieldEverywhere(legs, 'task', 'up-t2', 'priority', 3);
    assertFieldEverywhere(legs, 'version_task', 'up-vt1', 'status', 'todo');
    assertFieldEverywhere(legs, 'version_task', 'up-vt1', 'position', 0);
    assertFieldEverywhere(legs, 'preferences', 'singleton', 'recent_issues_count', 6);

    assertConverged(legs);
    // Syncing an upgraded device changes nothing anywhere on A or the server.
    assertIsolatedDelta(beforeSync.a, legs.a, []);
    assertIsolatedDelta(beforeSync.served, legs.served, []);
    assertIsolatedDelta(beforeSync.stored, legs.stored, []);
    assertInvariantsEverywhere(legs);

    // And the upgraded rows still merge per field: an edit on each side of an
    // upgraded row (whose field_updated_at is still empty) keeps both.
    await deviceA.call('repoPatch', 'version_task', 'up-vt1', { status: 'done' });
    await deviceB.call('repoPatch', 'version_task', 'up-vt1', { position: 3 });
    for (const dev of [deviceA, deviceB, deviceA]) expect((await dev.sync()).ok).toBe(true);
    const edited = await capture(deviceA, deviceB, backend);
    assertConverged(edited);
    assertFieldEverywhere(edited, 'version_task', 'up-vt1', 'status', 'done');
    assertFieldEverywhere(edited, 'version_task', 'up-vt1', 'position', 3);
    assertIsolatedEverywhere(legs, edited, [{ store: 'version_task', id: 'up-vt1' }]);

    expect(deviceA.errors, 'device A logged errors').toEqual([]);
    await context.close();
  });
});
