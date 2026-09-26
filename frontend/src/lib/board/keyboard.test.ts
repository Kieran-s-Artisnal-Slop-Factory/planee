import { describe, expect, it } from 'vitest';
import { firstCard, neighbourCard, nextColumn, planKeyboardMove, prevColumn, type ColumnCards } from './keyboard';
import { planDrop } from '../kanban/board';

const ORDER = ['todo', 'in_progress', 'done'];
const board = (todo: string[], inProgress: string[], done: string[]): ColumnCards[] => [
  { status: 'todo', ids: todo },
  { status: 'in_progress', ids: inProgress },
  { status: 'done', ids: done },
];

describe('columns', () => {
  it('steps right and left, stopping at the edges', () => {
    expect(nextColumn(ORDER, 'todo')).toBe('in_progress');
    expect(nextColumn(ORDER, 'in_progress')).toBe('done');
    expect(nextColumn(ORDER, 'done')).toBeNull();
    expect(prevColumn(ORDER, 'done')).toBe('in_progress');
    expect(prevColumn(ORDER, 'todo')).toBeNull();
    expect(nextColumn(ORDER, 'wontfix')).toBeNull();
    expect(prevColumn(ORDER, 'wontfix')).toBeNull();
  });
});

describe('neighbourCard (Tab / PageDown, Shift+Tab / PageUp)', () => {
  const cols = board(['a', 'b'], [], ['c', 'd']);

  it('walks down a column and on into the next non-empty one', () => {
    expect(neighbourCard(cols, 'a', 1)).toBe('b');
    expect(neighbourCard(cols, 'b', 1)).toBe('c'); // skips the empty In Progress
    expect(neighbourCard(cols, 'c', 1)).toBe('d');
  });

  it('walks back up, into the previous column’s LAST card', () => {
    expect(neighbourCard(cols, 'c', -1)).toBe('b');
    expect(neighbourCard(cols, 'b', -1)).toBe('a');
  });

  it('is null at either end (the key falls through) and for an unknown card', () => {
    expect(neighbourCard(cols, 'd', 1)).toBeNull();
    expect(neighbourCard(cols, 'a', -1)).toBeNull();
    expect(neighbourCard(cols, 'zz', 1)).toBeNull();
  });

  it('firstCard is the top of a column, null when empty', () => {
    expect(firstCard(cols, 'todo')).toBe('a');
    expect(firstCard(cols, 'in_progress')).toBeNull();
    expect(firstCard(cols, 'done')).toBe('c');
    expect(firstCard(cols, 'nope')).toBeNull();
  });
});

describe('planKeyboardMove', () => {
  const cols = board(['a', 'b', 'c'], ['p'], ['d']);

  it('Ctrl+↑ / Ctrl+↓ swap with the neighbour, as an index among the others', () => {
    expect(planKeyboardMove(cols, 'c', 'up')).toEqual({ fromStatus: 'todo', toStatus: 'todo', index: 1 });
    expect(planKeyboardMove(cols, 'a', 'down')).toEqual({ fromStatus: 'todo', toStatus: 'todo', index: 1 });
    expect(planKeyboardMove(cols, 'b', 'down')).toEqual({ fromStatus: 'todo', toStatus: 'todo', index: 2 });
  });

  it('refuses to move past the top or bottom of a column', () => {
    expect(planKeyboardMove(cols, 'a', 'up')).toBeNull();
    expect(planKeyboardMove(cols, 'c', 'down')).toBeNull();
    expect(planKeyboardMove(cols, 'p', 'up')).toBeNull();
  });

  it('Ctrl+→ / Ctrl+← go to the top of the neighbouring column', () => {
    expect(planKeyboardMove(cols, 'b', 'right')).toEqual({ fromStatus: 'todo', toStatus: 'in_progress', index: 0 });
    expect(planKeyboardMove(cols, 'p', 'left')).toEqual({ fromStatus: 'in_progress', toStatus: 'todo', index: 0 });
    expect(planKeyboardMove(cols, 'p', 'right')).toEqual({ fromStatus: 'in_progress', toStatus: 'done', index: 0 });
    // Done → In Progress: the COLUMN is the source, whatever resolution the card has.
    expect(planKeyboardMove(cols, 'd', 'left')).toEqual({ fromStatus: 'done', toStatus: 'in_progress', index: 0 });
  });

  it('has nowhere to go right of Done or left of TODO', () => {
    expect(planKeyboardMove(cols, 'd', 'right')).toBeNull();
    expect(planKeyboardMove(cols, 'a', 'left')).toBeNull();
    expect(planKeyboardMove(cols, 'zz', 'left')).toBeNull();
  });

  it('feeds planDrop: a reorder sends only the order, a column change the status too', () => {
    const keys = { a: 0, b: 1, c: 2, p: 0, d: 5 } as Record<string, number>;
    const slots = (ids: string[], without: string) =>
      ids.filter((id) => id !== without).map((id) => ({ id, key: keys[id]! }));
    const seen = (ids: string[], without: string) => ids.filter((id) => id !== without).map((id) => ({ id }));

    const up = planKeyboardMove(cols, 'c', 'up')!;
    const reorder = planDrop('c', up.fromStatus, up.toStatus, slots(['a', 'b', 'c'], 'c'), seen(['a', 'b', 'c'], 'c'), up.index);
    expect(reorder.fields).toEqual({ order: 0.5 }); // between a (0) and b (1): above b
    expect(reorder.reindex).toEqual([]);

    const left = planKeyboardMove(cols, 'd', 'left')!;
    const across = planDrop('d', left.fromStatus, left.toStatus, slots(['p'], 'd'), seen(['p'], 'd'), left.index);
    expect(across.fields).toEqual({ order: -1, status: 'in_progress' }); // above p (0)
  });
});
