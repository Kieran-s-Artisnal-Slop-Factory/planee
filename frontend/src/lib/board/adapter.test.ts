import { describe, expect, it } from 'vitest';
import {
  boardSchema,
  bumpTargetFor,
  planBump,
  planBumpMany,
  planComplete,
  planCreate,
  planDelete,
  splitPatch,
  subtaskProgress,
  toCards,
  topPosition,
} from './adapter';
import { normalizeEntries, planDrop, toCardPatch, columnsOf, sortKeyOf } from '../kanban/board';
import { normalizeSchema, sampleKeys } from '../kanban/types';
import type { Task, Version, VersionTask } from '../db/types';

const sync = { updated_at: '2026-01-01T00:00:00.000Z', deleted_at: null, server_seq: null };

const task = (id: string, fields: Partial<Task> = {}): Task => ({
  id,
  ...sync,
  project: 'p1',
  title: `Task ${id}`,
  task_type: 'feature',
  description: null,
  priority: 4,
  subtasks: null,
  ...fields,
});

const link = (id: string, fields: Partial<VersionTask> = {}): VersionTask => ({
  id,
  ...sync,
  version: 'v1',
  task: 't1',
  status: 'todo',
  position: 0,
  ...fields,
});

const version = (id: string, number: string, fields: Partial<Version> = {}): Version => ({
  id,
  ...sync,
  number,
  project: 'p1',
  description: null,
  completed: false,
  ...fields,
});

describe('boardSchema', () => {
  const model = normalizeSchema(boardSchema(), ['id', 'title', 'status', 'priority', 'position', 'description']);

  it('has three columns, with the resolutions in Done (D2)', () => {
    expect(model.statuses.map((s) => s.id)).toEqual(['todo', 'in_progress', 'done']);
    const entries = normalizeEntries(
      ['todo', 'in_progress', 'done', 'wontfix', 'out_of_scope', 'bumped'].map((status, i) => ({
        id: String(i),
        title: status,
        status,
        position: i,
      })),
      model
    );
    expect(entries.map((e) => e.status)).toEqual(['todo', 'in_progress', 'done', 'done', 'done', 'done']);
  });

  it('maps priorities by number, and writes numbers back (D15)', () => {
    expect(model.priorities.map((p) => [p.id, p.label, p.tone])).toEqual([
      ['1', 'Urgent', 'danger'],
      ['2', 'High', 'warning'],
      ['3', 'Medium', 'info'],
      ['4', 'Low', 'muted'],
    ]);
    const [entry] = normalizeEntries([{ id: 'a', title: 'x', status: 'todo', priority: 3, position: 0 }], model);
    expect(entry!.priority).toBe('3');
    expect(toCardPatch({ priority: '1' }, entry!, model)).toEqual({ priority: 1 });
    expect(model.fields.order).toBe('position');
    expect(model.hasOrder).toBe(true);
  });

  it('keeps wontfix when a card is reordered within Done', () => {
    const cards = toCards(
      [
        link('l1', { task: 't1', status: 'done', position: 0 }),
        link('l2', { task: 't2', status: 'wontfix', position: 1 }),
        link('l3', { task: 't3', status: 'out_of_scope', position: 2 }),
      ],
      [task('t1'), task('t2'), task('t3')]
    );
    const m = normalizeSchema(boardSchema(), sampleKeys(cards));
    const entries = normalizeEntries(cards, m);
    const done = columnsOf(entries, m).find((c) => c.status.id === 'done')!;
    const moving = done.entries[1]!; // the wontfix card
    const others = done.entries.filter((e) => e.id !== moving.id);
    const plan = planDrop(
      moving.id,
      'done',
      'done',
      others.map((e) => ({ id: e.id, key: sortKeyOf(e) })),
      others,
      0
    );
    const patch = toCardPatch(plan.fields, moving, m);
    expect(patch).toEqual({ position: -1 });
    expect(splitPatch(patch)).toEqual({ link: { position: -1 }, task: {} });
  });

  it('writes done when a card is dragged into Done from another column', () => {
    const cards = toCards([link('l1', { task: 't1', status: 'todo' })], [task('t1')]);
    const m = normalizeSchema(boardSchema(), sampleKeys(cards));
    const [entry] = normalizeEntries(cards, m);
    const plan = planDrop(entry!.id, 'todo', 'done', [], [], 0);
    expect(toCardPatch(plan.fields, entry!, m)).toEqual({ status: 'done', position: 0 });
  });
});

describe('toCards', () => {
  it('joins live links to live tasks', () => {
    const cards = toCards(
      [
        link('l1', { task: 't1', status: 'wontfix', position: 2.5 }),
        link('l2', { task: 't2' }),
        link('l3', { task: 't3', deleted_at: '2026-02-01T00:00:00.000Z' }),
        link('l4', { task: 'missing' }),
      ],
      [
        task('t1', { title: 'One', priority: 2, description: '# hi', subtasks: '- [ ] a', task_type: 'bug' }),
        task('t2', { deleted_at: '2026-02-01T00:00:00.000Z' }),
        task('t3'),
      ]
    );
    expect(cards).toEqual([
      {
        id: 'l1',
        taskId: 't1',
        title: 'One',
        status: 'wontfix',
        priority: 2,
        position: 2.5,
        description: '# hi',
        subtasks: '- [ ] a',
        task_type: 'bug',
      },
    ]);
  });
});

describe('splitPatch', () => {
  it('sends status and position to the link, the rest to the task', () => {
    expect(splitPatch({ status: 'done', position: 3, title: 'New', priority: 2, description: 'd' })).toEqual({
      link: { status: 'done', position: 3 },
      task: { title: 'New', priority: 2, description: 'd' },
    });
  });

  it('only carries keys that are present', () => {
    expect(splitPatch({ title: 'x' })).toEqual({ link: {}, task: { title: 'x' } });
    expect(splitPatch({})).toEqual({ link: {}, task: {} });
  });

  it('turns a cleared priority into the default, and numeric strings into numbers', () => {
    expect(splitPatch({ priority: null }).task).toEqual({ priority: 4 });
    expect(splitPatch({ priority: '' }).task).toEqual({ priority: 4 });
    expect(splitPatch({ priority: '1' }).task).toEqual({ priority: 1 });
    expect(splitPatch({ priority: 3 }).task).toEqual({ priority: 3 });
  });

  it('drops values outside the enums', () => {
    expect(splitPatch({ status: 'nope', task_type: 'nope' })).toEqual({ link: {}, task: {} });
    expect(splitPatch({ task_type: 'bug' }).task).toEqual({ task_type: 'bug' });
  });
});

describe('planCreate', () => {
  const ctx = { projectId: 'p1', versionId: 'v1', defaultTaskType: 'bug' as const, links: [] };

  it('builds the task and link rows', () => {
    expect(planCreate({ title: '  Hello  ', status: 'in_progress', priority: 2, position: -3 }, ctx)).toEqual({
      task: { project: 'p1', title: 'Hello', task_type: 'bug', description: null, priority: 2, subtasks: null },
      link: { version: 'v1', status: 'in_progress', position: -3 },
    });
  });

  it('defaults priority to 4, status to todo and the type to feature without a preference', () => {
    const plan = planCreate({ title: 'x' }, { ...ctx, defaultTaskType: null });
    expect(plan.task.priority).toBe(4);
    expect(plan.task.task_type).toBe('feature');
    expect(plan.link.status).toBe('todo');
    expect(plan.link.position).toBe(0);
  });

  it('puts a card with no position at the top of its column', () => {
    const links = [
      link('a', { status: 'todo', position: 2 }),
      link('b', { status: 'todo', position: -1 }),
      link('c', { status: 'done', position: -10 }),
    ];
    expect(planCreate({ title: 'x' }, { ...ctx, links }).link.position).toBe(-2);
    expect(planCreate({ title: 'x', status: 'done' }, { ...ctx, links }).link.position).toBe(-11);
  });
});

describe('topPosition', () => {
  it('treats every done status as one column', () => {
    const links = [link('a', { status: 'wontfix', position: 1 }), link('b', { status: 'bumped', position: 0.5 })];
    expect(topPosition(links, 'done')).toBe(-0.5);
    expect(topPosition(links, 'todo')).toBe(0);
  });
});

describe('planDelete', () => {
  it('deletes the task too when nothing else schedules it', () => {
    expect(planDelete('l1', [link('l1', { task: 't1' }), link('l2', { task: 't2' })])).toEqual({
      deleteLink: 'l1',
      deleteTask: true,
      taskId: 't1',
    });
  });

  it('keeps a task another live link still schedules', () => {
    const links = [link('l1', { task: 't1', version: 'v2' }), link('l0', { task: 't1', version: 'v1', status: 'bumped' })];
    expect(planDelete('l1', links).deleteTask).toBe(false);
  });

  it('ignores tombstoned links', () => {
    const links = [link('l1', { task: 't1' }), link('l0', { task: 't1', deleted_at: '2026-02-01T00:00:00.000Z' })];
    expect(planDelete('l1', links).deleteTask).toBe(true);
  });
});

describe('planBump (D1)', () => {
  const v1 = version('v1', '0.1.0');
  const v2 = version('v2', '0.2.0');

  it('targets the next incomplete version, at the top of its TODO column', () => {
    const l = link('l1', { task: 't1', version: 'v1', status: 'in_progress' });
    const all = [l, link('x', { task: 't9', version: 'v2', status: 'todo', position: 5 })];
    const plan = planBump(l, v1, [v1, v2], all);
    expect(plan.patchOld).toEqual({ status: 'bumped' });
    expect(plan.target).toEqual({ version: v2 });
    expect(plan.items).toEqual([
      { oldLinkId: 'l1', reuseLinkId: null, newLink: { task: 't1', status: 'todo', position: 4 } },
    ]);
  });

  it('creates a minor bump when there is no next incomplete version', () => {
    const l = link('l1');
    expect(planBump(l, v1, [v1, version('v2', '0.2.0', { completed: true })], [l]).target).toEqual({
      create: '0.3.0',
    });
    expect(planBump(l, v1, [v1], [l]).target).toEqual({ create: '0.2.0' });
  });

  it('reuses the task\'s existing link in the target instead of duplicating it', () => {
    const l = link('l1', { task: 't1', version: 'v1' });
    const existing = link('l2', { task: 't1', version: 'v2', status: 'done', position: 0 });
    const plan = planBump(l, v1, [v1, v2], [l, existing, link('l3', { task: 't3', version: 'v2', position: 1 })]);
    expect(plan.items[0]).toEqual({
      oldLinkId: 'l1',
      reuseLinkId: 'l2',
      newLink: { task: 't1', status: 'todo', position: 0 },
    });
  });

  it('bumps many to one target, keeping in-progress work first', () => {
    const a = link('a', { task: 'ta', status: 'todo', position: 0 });
    const b = link('b', { task: 'tb', status: 'in_progress', position: 7 });
    const c = link('c', { task: 'tc', status: 'todo', position: -1 });
    const plan = planBumpMany([a, b, c], v1, [v1], [a, b, c]);
    expect(plan.target).toEqual({ create: '0.2.0' });
    expect(plan.items.map((i) => [i.oldLinkId, i.newLink.position])).toEqual([
      ['b', -2],
      ['c', -1],
      ['a', 0],
    ]);
  });

  it('never suggests a number that already exists', () => {
    const v3 = version('v3', '0.3.0', { completed: true });
    expect(bumpTargetFor(v2, [v1, v2, v3])).toEqual({ create: '0.4.0' });
  });
});

describe('planComplete (D5)', () => {
  it('lists the open links and where they would go', () => {
    const v1 = version('v1', '0.1.0');
    const links = [
      link('a', { status: 'todo' }),
      link('b', { status: 'in_progress' }),
      link('c', { status: 'done' }),
      link('d', { status: 'wontfix' }),
      link('e', { status: 'todo', version: 'other' }),
      link('f', { status: 'todo', deleted_at: '2026-02-01T00:00:00.000Z' }),
    ];
    const plan = planComplete(v1, links, [v1]);
    expect(plan.openLinks.map((l) => l.id)).toEqual(['a', 'b']);
    expect([plan.todo, plan.inProgress]).toEqual([1, 1]);
    expect(plan.target).toEqual({ create: '0.2.0' });
  });
});

describe('subtaskProgress', () => {
  it('counts GFM task items', () => {
    const md = [
      '- [ ] one',
      '- [x] two',
      '* [X] three',
      '+ [ ] four',
      '1. [x] five',
      '2) [ ] six',
      '  - [x] nested',
      '- not a task',
      '- [] not either',
      '- [x]',
    ].join('\n');
    expect(subtaskProgress(md)).toEqual({ done: 5, total: 8 });
  });

  it('ignores fenced code', () => {
    const md = ['- [x] real', '```md', '- [ ] fake', '```', '~~~', '- [x] fake', '~~~', '- [ ] real'].join('\n');
    expect(subtaskProgress(md)).toEqual({ done: 1, total: 2 });
  });

  it('handles empty input', () => {
    expect(subtaskProgress(null)).toEqual({ done: 0, total: 0 });
    expect(subtaskProgress('')).toEqual({ done: 0, total: 0 });
  });
});
