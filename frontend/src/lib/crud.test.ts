import { describe, expect, it } from 'vitest';
import { changedFields, priorityLabel, projectLabel, taskLabel } from './crud';

describe('labels', () => {
  it('prefers the name/title and falls back to the description', () => {
    expect(projectLabel({ name: 'Planee', description: 'x' })).toBe('Planee');
    expect(projectLabel({ name: '  ', description: 'old project' })).toBe('old project');
    expect(projectLabel(undefined)).toBe('');
    expect(taskLabel({ title: 'Fix it', description: null })).toBe('Fix it');
    expect(taskLabel({ title: '', description: 'legacy' })).toBe('legacy');
    expect(taskLabel({ title: '', description: null })).toBe('');
  });

  it('names priorities', () => {
    expect(priorityLabel(1)).toBe('Urgent');
    expect(priorityLabel(4)).toBe('Low');
    expect(priorityLabel(7)).toBe('7');
  });
});

describe('changedFields', () => {
  it('keeps only the fields that differ', () => {
    expect(
      changedFields(
        { title: 'a', description: null as string | null, priority: 4 },
        { title: 'a', description: 'new', priority: 4 }
      )
    ).toEqual({ description: 'new' });
  });

  it('is empty when nothing changed, and type-strict', () => {
    expect(changedFields({ a: 1, b: null }, { a: 1, b: null })).toEqual({});
    expect(changedFields<{ a: unknown }>({ a: 1 }, { a: '1' })).toEqual({ a: '1' });
    expect(changedFields<{ a: unknown }>({ a: null }, { a: '' })).toEqual({ a: '' });
  });
});
