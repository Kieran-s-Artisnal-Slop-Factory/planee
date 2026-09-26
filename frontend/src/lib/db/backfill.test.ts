import { describe, expect, it } from 'vitest';
import { backfillV3, backfillV4, backfillV5 } from './backfill';

const sync = {
  updated_at: '2026-01-01T00:00:00.000Z',
  deleted_at: null,
  server_seq: 7,
};

describe('backfillV3', () => {
  it('fills the server DEFAULTs and drops project.version, leaving sync fields alone', () => {
    expect(backfillV3('project', { id: 'p', description: 'd', version: '0.1.0', ...sync })).toEqual({
      id: 'p',
      description: 'd',
      name: '',
      field_updated_at: {},
      ...sync,
    });
    expect(backfillV3('version', { id: 'v', number: '1.0.0', project: 'p', ...sync })).toEqual({
      id: 'v',
      number: '1.0.0',
      project: 'p',
      description: null,
      completed: false,
      field_updated_at: {},
      ...sync,
    });
    expect(
      backfillV3('task', { id: 't', project: 'p', description: null, priority: 3, subtasks: null, ...sync })
    ).toEqual({
      id: 't',
      project: 'p',
      title: '',
      task_type: 'feature',
      description: null,
      priority: 3,
      subtasks: null,
      field_updated_at: {},
      ...sync,
    });
    expect(backfillV3('version_task', { id: 'vt', version: 'v', task: 't', ...sync })).toEqual({
      id: 'vt',
      version: 'v',
      task: 't',
      status: 'todo',
      position: 0,
      field_updated_at: {},
      ...sync,
    });
  });

  it('never overwrites a present value, including a present null', () => {
    const row = {
      id: 'v',
      number: '1.0.0',
      project: 'p',
      description: null,
      completed: true,
      field_updated_at: { completed: '2026-02-01T00:00:00.000Z' },
      ...sync,
    };
    expect(backfillV3('version', row)).toBeNull();
  });

  it('does not mutate its input or share the stamp map between rows', () => {
    const a = { id: 'a', description: 'x', version: '', ...sync };
    const b = { id: 'b', description: 'y', version: '', ...sync };
    const upA = backfillV3('project', a)!;
    const upB = backfillV3('project', b)!;
    expect(a).toHaveProperty('version');
    expect(upA.field_updated_at).not.toBe(upB.field_updated_at);
  });

  it('ignores stores it does not upgrade', () => {
    expect(backfillV3('preferences', { id: 'singleton', ...sync })).toBeNull();
    expect(backfillV3('asset', { id: 'x', ...sync })).toBeNull();
  });
});

describe('backfillV4', () => {
  const stamps = { default_task_type: '2026-01-01T00:00:00.000Z', deleted_at: '2026-01-01T00:00:00.000Z' };

  it('fills recent_issues_count with the server DEFAULT, leaving sync fields and stamps alone', () => {
    const row = { id: 'singleton', default_task_type: 'bug', field_updated_at: stamps, ...sync };
    expect(backfillV4('preferences', row)).toEqual({
      id: 'singleton',
      default_task_type: 'bug',
      recent_issues_count: 6,
      field_updated_at: stamps,
      ...sync,
    });
    expect(row).not.toHaveProperty('recent_issues_count');
  });

  it('upgrades a tombstone too', () => {
    const row = { id: 'singleton', default_task_type: 'bug', ...sync, deleted_at: '2026-02-01T00:00:00.000Z' };
    expect(backfillV4('preferences', row)).toMatchObject({ recent_issues_count: 6, deleted_at: row.deleted_at });
  });

  it('never overwrites a present value, including 0', () => {
    expect(backfillV4('preferences', { id: 'singleton', recent_issues_count: 0, ...sync })).toBeNull();
    expect(backfillV4('preferences', { id: 'singleton', recent_issues_count: 20, ...sync })).toBeNull();
  });

  it('ignores stores it does not upgrade', () => {
    for (const store of ['project', 'version', 'task', 'version_task', 'asset']) {
      expect(backfillV4(store, { id: 'x', ...sync })).toBeNull();
    }
  });

  it('chains after backfillV3 the way an old backup is imported', () => {
    const v2 = { id: 'singleton', default_task_type: 'cleanup', field_updated_at: {}, ...sync };
    const afterV3 = backfillV3('preferences', v2) ?? v2;
    expect(backfillV4('preferences', afterV3)).toEqual({ ...v2, recent_issues_count: 6 });
  });
});

describe('backfillV5', () => {
  const stamps = { recent_issues_count: '2026-01-01T00:00:00.000Z', deleted_at: '2026-01-01T00:00:00.000Z' };

  it('turns the cheat sheet on (the server DEFAULT), leaving the count, sync fields and stamps alone', () => {
    const row = { id: 'singleton', default_task_type: 'bug', recent_issues_count: 3, field_updated_at: stamps, ...sync };
    expect(backfillV5('preferences', row)).toEqual({ ...row, show_keybind_sheet: true });
    expect(row).not.toHaveProperty('show_keybind_sheet');
  });

  it('upgrades a tombstone too', () => {
    const row = { id: 'singleton', default_task_type: 'bug', ...sync, deleted_at: '2026-02-01T00:00:00.000Z' };
    expect(backfillV5('preferences', row)).toMatchObject({ show_keybind_sheet: true, deleted_at: row.deleted_at });
  });

  it('never overwrites a present value, including false', () => {
    expect(backfillV5('preferences', { id: 'singleton', show_keybind_sheet: false, ...sync })).toBeNull();
    expect(backfillV5('preferences', { id: 'singleton', show_keybind_sheet: true, ...sync })).toBeNull();
  });

  it('ignores stores it does not upgrade', () => {
    for (const store of ['project', 'version', 'task', 'version_task', 'asset']) {
      expect(backfillV5(store, { id: 'x', ...sync })).toBeNull();
    }
  });

  it('chains after backfillV3 and backfillV4 the way an old backup is imported', () => {
    const v2 = { id: 'singleton', default_task_type: 'cleanup', field_updated_at: {}, ...sync };
    const afterV3 = backfillV3('preferences', v2) ?? v2;
    const afterV4 = backfillV4('preferences', afterV3) ?? afterV3;
    expect(backfillV5('preferences', afterV4)).toEqual({ ...v2, recent_issues_count: 6, show_keybind_sheet: true });
  });
});
