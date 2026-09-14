import { describe, expect, it } from 'vitest';
import { backfillV3 } from './backfill';

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
