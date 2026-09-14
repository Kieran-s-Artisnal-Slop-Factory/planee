// Ported from retoken (af25bc6)
import { describe, expect, it } from 'vitest';
import {
  anchorIndex,
  applyPending,
  columnsOf,
  diffFields,
  draftEntry,
  dropIndexFor,
  fieldsOf,
  filterEntries,
  FORM_FIELDS,
  formResult,
  formStart,
  isNoMove,
  normalizeEntries,
  planDrop,
  planMove,
  prunePending,
  sortKeyOf,
  toCardDraft,
  toCardPatch,
  toInsertIndex,
  type Entry,
  type Pending,
  type PendingCreate,
  type PendingPatch,
} from './board';
import { dueFromDay } from './dates';
import { normalizeSchema, type KanbanSchema } from './types';

const model = (schema: KanbanSchema = {}, keys: string[] = ['id', 'title', 'status', 'dueDate', 'priority', 'description']) =>
  normalizeSchema(schema, keys);

const ordered = model({}, ['id', 'title', 'status', 'dueDate', 'priority', 'description', 'order']);

describe('normalizeEntries', () => {
  const m = model();

  it('reads the roles off each card', () => {
    const [entry] = normalizeEntries(
      [
        {
          id: 7,
          title: 'Ship it',
          status: 'IN_PROGRESS',
          dueDate: '2026-03-04',
          priority: 'P1',
          description: '**bold**',
        },
      ],
      m
    );
    expect(entry).toMatchObject({
      id: '7',
      cardId: 7,
      title: 'Ship it',
      status: 'in-progress',
      priority: 'high',
      description: '**bold**',
      synthetic: false,
    });
    expect(entry?.due?.day).toBe('2026-03-04');
  });

  it('leaves a status no column claims unresolved', () => {
    expect(normalizeEntries([{ id: 1, status: 'archived' }], m)[0]?.status).toBeNull();
  });

  it('borrows the array position when a card has no id, and says so', () => {
    const [a, b] = normalizeEntries([{ title: 'a' }, { id: '', title: 'b' }], m);
    expect(a).toMatchObject({ id: 'row-0', synthetic: true });
    expect(b).toMatchObject({ id: 'row-1', synthetic: true });
  });

  it('keeps duplicate ids distinct, so an each-key cannot collide', () => {
    const entries = normalizeEntries([{ id: 'x' }, { id: 'x' }, { id: 'x' }], m);
    expect(entries.map((e) => e.id)).toEqual(['x', 'x~2', 'x~3']);
    // What gets reported is still the id the data actually has.
    expect(entries.map((e) => e.cardId)).toEqual(['x', 'x', 'x']);
  });

  it('reads a numeric order, including one written as text', () => {
    const entries = normalizeEntries(
      [
        { id: 1, order: 5 },
        { id: 2, order: '7' },
        { id: 3, order: 'nope' },
        { id: 4 },
      ],
      ordered
    );
    expect(entries.map((e) => e.order)).toEqual([5, 7, undefined, undefined]);
  });

  it('coerces titles and descriptions to text, and objects to nothing', () => {
    const entries = normalizeEntries([{ id: 1, title: 42, description: { a: 1 } }], m);
    expect(entries[0]).toMatchObject({ title: '42', description: '' });
  });

  it('keeps the caller object untouched, for the callbacks to hand back', () => {
    const card = { id: 1, title: 'a' };
    expect(normalizeEntries([card], m)[0]?.card).toBe(card);
  });

  it('survives junk in the list', () => {
    expect(normalizeEntries([null as never], m)[0]).toMatchObject({ id: 'row-0', title: '' });
  });
});

const entry = (over: Partial<Entry> = {}): Entry => ({
  id: 'a',
  cardId: 'a',
  index: 0,
  title: 'A',
  status: 'todo',
  due: null,
  priority: null,
  description: '',
  order: undefined,
  card: {},
  synthetic: false,
  ...over,
});

describe('sortKeyOf', () => {
  it('is the ordering field when there is one, the array position when not', () => {
    expect(sortKeyOf(entry({ order: 4.5, index: 9 }))).toBe(4.5);
    expect(sortKeyOf(entry({ index: 9 }))).toBe(9);
  });
});

describe('columnsOf', () => {
  const m = model();

  it('groups the cards and orders each column', () => {
    const entries = [
      entry({ id: 'a', status: 'todo', order: 2 }),
      entry({ id: 'b', status: 'done', order: 0 }),
      entry({ id: 'c', status: 'todo', order: 1 }),
    ];
    const columns = columnsOf(entries, ordered);
    expect(columns.map((c) => c.status.id)).toEqual(['todo', 'in-progress', 'done']);
    expect(columns[0]?.entries.map((e) => e.id)).toEqual(['c', 'a']);
    expect(columns[1]?.entries).toEqual([]);
    expect(columns[2]?.entries.map((e) => e.id)).toEqual(['b']);
  });

  it('breaks a tie by array position, so the order is stable', () => {
    const entries = [
      entry({ id: 'a', order: 1, index: 1 }),
      entry({ id: 'b', order: 1, index: 0 }),
    ];
    expect(columnsOf(entries, ordered)[0]?.entries.map((e) => e.id)).toEqual(['b', 'a']);
  });

  it('puts a card whose status no column claims in the first column', () => {
    const columns = columnsOf([entry({ status: null })], m);
    expect(columns[0]?.entries).toHaveLength(1);
  });

  it('flags a column past its WIP limit', () => {
    const limited = normalizeSchema({
      status: { role: 'status', options: [{ id: 'todo', limit: 1 }, { id: 'done' }] },
    });
    const columns = columnsOf([entry({ id: 'a' }), entry({ id: 'b' })], limited);
    expect(columns[0]?.over).toBe(true);
    expect(columns[1]?.over).toBe(false);
  });
});

describe('filterEntries', () => {
  const entries = [
    entry({ id: 'a', title: 'Ship the thing', description: 'about latency' }),
    entry({ id: 'b', title: 'Write docs', description: '' }),
  ];

  it('matches the title or the description, case-insensitively', () => {
    expect(filterEntries(entries, 'SHIP').map((e) => e.id)).toEqual(['a']);
    expect(filterEntries(entries, 'latency').map((e) => e.id)).toEqual(['a']);
    expect(filterEntries(entries, 'docs').map((e) => e.id)).toEqual(['b']);
  });

  it('matches everything for a blank term', () => {
    expect(filterEntries(entries, '   ')).toHaveLength(2);
  });
});

describe('planMove', () => {
  const slots = (...keys: number[]) => keys.map((key, i) => ({ id: `s${i}`, key }));

  it('takes the midpoint between two neighbours', () => {
    expect(planMove(slots(0, 1), 1, 'x')).toEqual({ key: 0.5, reindex: [] });
    expect(planMove(slots(0, 10), 1, 'x').key).toBe(5);
  });

  it('steps past the end and before the start', () => {
    expect(planMove(slots(0, 1), 2, 'x')).toEqual({ key: 2, reindex: [] });
    expect(planMove(slots(4, 5), 0, 'x')).toEqual({ key: 3, reindex: [] });
  });

  it('starts at zero in an empty column', () => {
    expect(planMove([], 0, 'x')).toEqual({ key: 0, reindex: [] });
  });

  it('clamps an index outside the column', () => {
    expect(planMove(slots(0, 1), 99, 'x').key).toBe(2);
    expect(planMove(slots(0, 1), -5, 'x').key).toBe(-1);
  });

  it('renumbers the column when there is no room left between two cards', () => {
    const plan = planMove(slots(1, 1 + 1e-9), 1, 'x');
    expect(plan.reindex.map((s) => s.id)).toEqual(['s0', 'x', 's1']);
    expect(plan.reindex.map((s) => s.key)).toEqual([0, 1, 2]);
    expect(plan.key).toBe(1);
  });

  it('renumbers when two cards share an order value', () => {
    const plan = planMove(slots(3, 3), 1, 'x');
    expect(plan.reindex).toHaveLength(3);
    expect(plan.key).toBe(1);
  });

  it('halves the same gap many times over, then renumbers instead of losing it', () => {
    // Dropping into the same slot over and over is what eventually runs out of
    // room between two keys. It has to survive plenty of those before it does.
    let column = slots(0, 1);
    let halvings = 0;
    for (let i = 0; i < 40; i += 1) {
      const plan = planMove(column, 1, 'x');
      if (plan.reindex.length > 0) break;
      halvings += 1;
      column = [column[0]!, { id: 'x', key: plan.key }];
    }
    expect(halvings).toBeGreaterThan(15);
    // And when it does give up, it renumbers rather than colliding.
    const plan = planMove(column, 1, 'x');
    expect(plan.reindex.map((s) => s.key)).toEqual([0, 1, 2]);
  });
});

describe('dropIndexFor / toInsertIndex / isNoMove', () => {
  const rects = [
    { top: 0, height: 100 },
    { top: 100, height: 100 },
    { top: 200, height: 100 },
  ];

  it('counts the cards whose middle the pointer is past', () => {
    expect(dropIndexFor(rects, 10)).toBe(0);
    expect(dropIndexFor(rects, 60)).toBe(1);
    expect(dropIndexFor(rects, 160)).toBe(2);
    expect(dropIndexFor(rects, 999)).toBe(3);
  });

  it('is zero over an empty column', () => {
    expect(dropIndexFor([], 42)).toBe(0);
  });

  it('closes the gap the dragged card still occupies', () => {
    expect(toInsertIndex(0, 2)).toBe(0);
    expect(toInsertIndex(2, 2)).toBe(2);
    expect(toInsertIndex(3, 2)).toBe(2);
    expect(toInsertIndex(3, null)).toBe(3);
  });

  it('anchors a filtered drop to the visible card it landed after', () => {
    const all = [{ id: 'a' }, { id: 'h1' }, { id: 'b' }, { id: 'h2' }, { id: 'c' }];
    const visible = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    // "After b" is index 2 of the visible list and index 3 of the real one.
    expect(anchorIndex(all, visible, 2)).toBe(3);
    expect(anchorIndex(all, visible, 1)).toBe(1);
    // Before everything visible means before the first visible card, hidden
    // cards above it keeping their place.
    expect(anchorIndex(all, visible, 0)).toBe(0);
    expect(anchorIndex(all, visible, 3)).toBe(5);
  });

  it('passes the index straight through when the search hid nothing', () => {
    const same = [{ id: 'a' }, { id: 'b' }];
    expect(anchorIndex(same, same, 1)).toBe(1);
  });

  it('sends a drop into a column the search emptied to the end', () => {
    expect(anchorIndex([{ id: 'h1' }, { id: 'h2' }], [], 0)).toBe(2);
  });

  it('knows a drop that changes nothing', () => {
    expect(isNoMove('todo', 1, 'todo', 1)).toBe(true);
    expect(isNoMove('todo', 1, 'todo', 2)).toBe(false);
    expect(isNoMove('todo', 1, 'done', 1)).toBe(false);
  });
});

describe('applyPending', () => {
  const entries = [entry({ id: 'a', title: 'A' }), entry({ id: 'b', title: 'B' })];

  it('overlays a patch', () => {
    const pending: Record<string, Pending> = {
      a: { kind: 'patch', fields: { title: 'A!', status: 'done' }, before: {}, done: false },
    };
    const view = applyPending(entries, pending);
    expect(view[0]).toMatchObject({ title: 'A!', status: 'done' });
    expect(view[1]).toBe(entries[1]);
  });

  it('overlays a cleared due date, which a plain `??` would miss', () => {
    const withDue = [entry({ id: 'a', due: dueFromDay('2026-03-04') })];
    const pending: Record<string, Pending> = {
      a: { kind: 'patch', fields: { due: null }, before: {}, done: false },
    };
    expect(applyPending(withDue, pending)[0]?.due).toBeNull();
  });

  it('hides a deleted card', () => {
    const view = applyPending(entries, { a: { kind: 'delete', done: false } });
    expect(view.map((e) => e.id)).toEqual(['b']);
  });

  it('brings back a card whose deletion was refused, so it can be retried', () => {
    const view = applyPending(entries, { a: { kind: 'delete', done: true, error: 'offline' } });
    expect(view.map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('appends the cards the board added itself', () => {
    const create: PendingCreate = { entry: entry({ id: 'new-1' }), known: ['a', 'b'], done: false };
    expect(applyPending(entries, {}, [create]).map((e) => e.id)).toEqual(['a', 'b', 'new-1']);
  });

  it('shows an added card once, even when the source already has it', () => {
    // The moment a storage hands its id back, both copies exist for a beat.
    const create: PendingCreate = { entry: entry({ id: 'a' }), known: [], done: true };
    expect(applyPending(entries, {}, [create]).map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('shows two added cards that adopted the same id once', () => {
    // A storage that hands back an id it has already used would otherwise put
    // the same {#each} key on screen twice, which is a crash, not a glitch.
    const twice: PendingCreate[] = [
      { entry: entry({ id: 'srv-1', title: 'first' }), known: [], done: true },
      { entry: entry({ id: 'srv-1', title: 'second' }), known: [], done: true },
    ];
    const view = applyPending([], {}, twice);
    expect(view.map((e) => e.id)).toEqual(['srv-1']);
    expect(view[0]?.title).toBe('first');
  });
});

describe('prunePending', () => {
  const m = model();

  it('drops a field the source has caught up with', () => {
    const entries = [entry({ id: 'a', status: 'done' })];
    const pending: Record<string, Pending> = {
      a: { kind: 'patch', fields: { status: 'done' }, before: { status: 'todo' }, done: true },
    };
    const result = prunePending(entries, pending, [], m);
    expect(result.changed).toBe(true);
    expect(result.pending).toEqual({});
  });

  it('keeps a field the source never persisted', () => {
    const entries = [entry({ id: 'a', status: 'todo' })];
    const pending: Record<string, Pending> = {
      a: { kind: 'patch', fields: { status: 'done' }, before: { status: 'todo' }, done: true },
    };
    expect(prunePending(entries, pending, [], m).pending.a).toBeDefined();
  });

  it('gives way when the source changed the field itself', () => {
    const entries = [entry({ id: 'a', status: 'in-progress' })];
    const pending: Record<string, Pending> = {
      a: { kind: 'patch', fields: { status: 'done' }, before: { status: 'todo' }, done: true },
    };
    expect(prunePending(entries, pending, [], m).pending).toEqual({});
  });

  it('waits while the callback is still in flight', () => {
    const entries = [entry({ id: 'a', status: 'done' })];
    const pending: Record<string, Pending> = {
      a: { kind: 'patch', fields: { status: 'done' }, before: { status: 'todo' }, done: false },
    };
    expect(prunePending(entries, pending, [], m).pending.a).toBeDefined();
  });

  it('keeps a failed patch, so the card can show it failed', () => {
    const entries = [entry({ id: 'a', status: 'done' })];
    const pending: Record<string, Pending> = {
      a: {
        kind: 'patch',
        fields: { status: 'done' },
        before: { status: 'todo' },
        done: true,
        error: 'offline',
      },
    };
    expect(prunePending(entries, pending, [], m).pending.a).toBeDefined();
  });

  it('settles one field and keeps another', () => {
    const entries = [entry({ id: 'a', status: 'done', title: 'A' })];
    const pending: Record<string, Pending> = {
      a: {
        kind: 'patch',
        fields: { status: 'done', title: 'A!' },
        before: { status: 'todo', title: 'A' },
        done: true,
      },
    };
    const result = prunePending(entries, pending, [], m);
    const kept = result.pending.a as PendingPatch;
    expect(kept.fields).toEqual({ title: 'A!' });
  });

  it('keeps a local position for good when there is nowhere to store one', () => {
    const entries = [entry({ id: 'a', index: 0 })];
    const pending: Record<string, Pending> = {
      a: { kind: 'patch', fields: { order: 2.5 }, before: { order: 0 }, done: true },
    };
    expect(prunePending(entries, pending, [], m).pending.a).toBeDefined();
  });

  it('settles a position once the source stores it', () => {
    const entries = [entry({ id: 'a', order: 2.5 })];
    const pending: Record<string, Pending> = {
      a: { kind: 'patch', fields: { order: 2.5 }, before: { order: 0 }, done: true },
    };
    expect(prunePending(entries, pending, [], ordered).pending).toEqual({});
  });

  it('drops a patch whose card is gone', () => {
    const pending: Record<string, Pending> = {
      a: { kind: 'patch', fields: { title: 'x' }, before: {}, done: false },
    };
    expect(prunePending([], pending, [], m).pending).toEqual({});
  });

  it('drops a delete once the card is gone', () => {
    expect(prunePending([], { a: { kind: 'delete', done: true } }, [], m).pending).toEqual({});
  });

  it('keeps hiding a card the source still has', () => {
    const entries = [entry({ id: 'a' })];
    expect(prunePending(entries, { a: { kind: 'delete', done: true } }, [], m).pending.a).toBeDefined();
  });

  it('settles a create once the stored card comes back under its id', () => {
    const created: PendingCreate = {
      entry: entry({ id: 'srv-1', title: 'New' }),
      known: [],
      done: true,
    };
    const result = prunePending([entry({ id: 'srv-1', title: 'New' })], {}, [created], m);
    expect(result.creates).toEqual([]);
    expect(result.changed).toBe(true);
  });

  it('settles a create by title when no id came back', () => {
    const created: PendingCreate = {
      entry: entry({ id: 'new-9', title: 'New card' }),
      known: ['a'],
      done: true,
    };
    const entries = [entry({ id: 'a' }), entry({ id: 'b', title: 'New card' })];
    expect(prunePending(entries, {}, [created], m).creates).toEqual([]);
  });

  it('does not settle a create against a card that was already there', () => {
    const created: PendingCreate = {
      entry: entry({ id: 'new-9', title: 'New card' }),
      known: ['a'],
      done: true,
    };
    const entries = [entry({ id: 'a', title: 'New card' })];
    expect(prunePending(entries, {}, [created], m).creates).toHaveLength(1);
  });

  it('keeps a create while it is in flight, or after it failed', () => {
    const flying: PendingCreate = { entry: entry({ id: 'n' }), known: [], done: false };
    const failed: PendingCreate = { entry: entry({ id: 'n' }), known: [], done: true, error: 'x' };
    expect(prunePending([], {}, [flying], m).creates).toHaveLength(1);
    expect(prunePending([], {}, [failed], m).creates).toHaveLength(1);
  });

  it('reports nothing changed when nothing did', () => {
    const entries = [entry({ id: 'a', status: 'todo' })];
    const pending: Record<string, Pending> = {
      a: { kind: 'patch', fields: { status: 'done' }, before: { status: 'todo' }, done: false },
    };
    expect(prunePending(entries, pending, [], m).changed).toBe(false);
  });
});

describe('diffFields', () => {
  const before = {
    status: 'todo',
    title: 'A',
    due: '2026-03-04',
    priority: 'low',
    description: 'x',
  };

  it('reports only what changed', () => {
    expect(diffFields(before, { ...before, title: 'B' })).toEqual({ title: 'B' });
    expect(diffFields(before, { ...before, status: 'done', priority: 'high' })).toEqual({
      status: 'done',
      priority: 'high',
    });
  });

  it('reports nothing for an edit that changed nothing', () => {
    expect(diffFields(before, { ...before })).toEqual({});
  });

  it('reports a cleared date and a cleared priority', () => {
    expect(diffFields(before, { ...before, due: null, priority: null })).toEqual({
      due: null,
      priority: null,
    });
  });

  it('treats a field `before` never mentioned as unset, not as changed', () => {
    expect(diffFields({}, { due: null, priority: null })).toEqual({});
    expect(diffFields({}, { title: 'A' })).toEqual({ title: 'A' });
  });

  it('ignores a field `after` says nothing about', () => {
    expect(diffFields(before, { title: 'A' })).toEqual({});
  });
});

describe('fieldsOf', () => {
  it('reads an entry in the same vocabulary a patch uses', () => {
    expect(fieldsOf(entry({ due: dueFromDay('2026-03-04'), order: 3 }))).toEqual({
      status: 'todo',
      order: 3,
      title: 'A',
      due: '2026-03-04',
      priority: null,
      description: '',
    });
  });
});

describe('toCardPatch', () => {
  it('writes through your own keys, with your own values', () => {
    const m = normalizeSchema({
      state: {
        role: 'status',
        options: [{ id: 'todo', value: 'TO_DO' }, { id: 'done', value: 'DONE' }],
      },
      deadline: 'due',
      urgency: { role: 'priority', options: [{ id: 'low', value: 1 }] },
      headline: 'title',
      notes: 'description',
    });
    const card = { headline: 'A', state: 'TO_DO', deadline: '2026-01-01' };
    const patch = toCardPatch(
      { status: 'done', title: 'B', due: '2026-03-04', priority: 'low', description: 'x' },
      entry({ card }),
      m
    );
    expect(patch).toEqual({
      state: 'DONE',
      headline: 'B',
      deadline: '2026-03-04',
      urgency: 1,
      notes: 'x',
    });
  });

  it('writes a cleared priority as null', () => {
    expect(toCardPatch({ priority: null }, entry(), model())).toEqual({ priority: null });
  });

  it('leaves out a position when the data has nowhere to keep one', () => {
    expect(toCardPatch({ order: 2.5 }, entry(), model())).toEqual({});
    expect(toCardPatch({ order: 2.5 }, entry(), ordered)).toEqual({ order: 2.5 });
  });

  it('writes the due date in the shape the field already had', () => {
    const card = { dueDate: new Date(2026, 0, 1) };
    const patch = toCardPatch({ due: '2026-03-04' }, entry({ card }), model());
    expect(patch.dueDate).toBeInstanceOf(Date);
  });

  it('only carries the fields it was given', () => {
    expect(toCardPatch({ title: 'x' }, entry(), model())).toEqual({ title: 'x' });
  });
});

describe('toCardDraft / draftEntry', () => {
  it('builds a new card in the caller vocabulary, with no id of its own', () => {
    const m = normalizeSchema({ headline: 'title', state: 'status' });
    expect(toCardDraft({ title: 'New', status: 'todo' }, m)).toEqual({
      headline: 'New',
      state: 'todo',
    });
  });

  it('builds the optimistic entry to show until the storage answers', () => {
    const m = model();
    const draft = draftEntry({ title: 'New', status: 'done', due: '2026-03-04' }, m, 3, 'new-1');
    expect(draft).toMatchObject({
      id: 'new-1',
      index: 3,
      title: 'New',
      status: 'done',
      optimistic: true,
    });
    expect(draft.due?.day).toBe('2026-03-04');
    expect(draft.card).toMatchObject({ id: 'new-1', title: 'New', status: 'done' });
  });

  it('defaults a new card to the first column', () => {
    expect(draftEntry({ title: 'x' }, model(), 0).status).toBe('todo');
  });
});

// ── Planee: 3 columns, resolutions in Done, numeric priorities ────────────────

describe('planee schema (D2, D15)', () => {
  const planee = normalizeSchema(
    {
      id: 'id',
      title: 'title',
      status: {
        role: 'status',
        options: [
          { id: 'todo', label: 'TODO', value: 'todo' },
          {
            id: 'in_progress',
            label: 'In Progress',
            value: 'in_progress',
            match: ['in-progress', 'doing'],
          },
          {
            id: 'done',
            label: 'Done',
            value: 'done',
            match: ['wontfix', 'out_of_scope', 'bumped'],
          },
        ],
      },
      priority: {
        role: 'priority',
        options: [
          { id: '1', label: 'Urgent', value: 1, tone: 'danger' },
          { id: '2', label: 'High', value: 2, tone: 'warning' },
          { id: '3', label: 'Medium', value: 3, tone: 'info' },
          { id: '4', label: 'Low', value: 4, tone: 'muted' },
        ],
      },
      position: 'order',
      description: 'description',
    },
    ['id', 'title', 'status', 'priority', 'position', 'description']
  );

  const cards = [
    { id: 't1', title: 'Todo one', status: 'todo', priority: 4, position: 0, description: '' },
    { id: 'p1', title: 'Doing', status: 'in-progress', priority: 2, position: 0, description: '' },
    { id: 'd1', title: 'Shipped', status: 'done', priority: 3, position: 0, description: '' },
    { id: 'w1', title: 'Nope', status: 'wontfix', priority: 1, position: 1, description: '' },
    { id: 'o1', title: 'Elsewhere', status: 'out_of_scope', priority: 4, position: 2, description: '' },
    { id: 'b1', title: 'Later', status: 'bumped', priority: 4, position: 3, description: '' },
  ];
  const entries = normalizeEntries(cards, planee);
  const byId = (id: string) => entries.find((e) => e.id === id)!;
  /** A column's slots in order, without the moving card — what a drop plans against. */
  const slotsIn = (status: string, without: string) =>
    columnsOf(entries, planee)
      .find((c) => c.status.id === status)!
      .entries.filter((e) => e.id !== without)
      .map((e) => ({ id: e.id, key: sortKeyOf(e) }));

  it('has three columns and routes every resolution into Done', () => {
    const columns = columnsOf(entries, planee);
    expect(columns.map((c) => c.status.id)).toEqual(['todo', 'in_progress', 'done']);
    expect(columns[1]!.entries.map((e) => e.id)).toEqual(['p1']);
    expect(columns[2]!.entries.map((e) => e.id)).toEqual(['d1', 'w1', 'o1', 'b1']);
  });

  it('reads the in-progress spellings as the middle column', () => {
    for (const raw of ['in_progress', 'in-progress', 'IN PROGRESS', 'doing']) {
      expect(normalizeEntries([{ id: 'x', status: raw }], planee)[0]!.status).toBe('in_progress');
    }
  });

  it('(a) a wontfix card reordered WITHIN Done writes only its position', () => {
    const others = slotsIn('done', 'w1');
    const plan = planDrop('w1', 'done', 'done', others, others, others.length);
    expect(plan.fields.status).toBeUndefined();
    const patch = toCardPatch(plan.fields, byId('w1'), planee);
    expect(patch).toEqual({ position: 4 });
    expect(patch).not.toHaveProperty('status');
  });

  it('(a) a same-column move never sends status, even for a card no column claims', () => {
    const odd = normalizeEntries([{ id: 'z', status: 'archived', position: 0 }], planee)[0]!;
    expect(odd.status).toBeNull();
    const others = slotsIn('todo', 'z');
    const plan = planDrop('z', 'todo', 'todo', others, others, 0);
    expect(toCardPatch(plan.fields, odd, planee)).not.toHaveProperty('status');
  });

  it('(a) a renumber inside Done moves the other cards by position only', () => {
    const crowded = [
      { id: 'x', key: 1 },
      { id: 'y', key: 1 },
    ];
    const plan = planDrop('w1', 'done', 'done', crowded, crowded, 1);
    expect(plan.fields).toEqual({ order: 1 });
    expect(plan.reindex).toEqual([
      { id: 'x', key: 0 },
      { id: 'y', key: 2 },
    ]);
  });

  it('(b) a wontfix card dragged Done -> TODO writes todo', () => {
    const others = slotsIn('todo', 'w1');
    const plan = planDrop('w1', 'done', 'todo', others, others, 0);
    expect(toCardPatch(plan.fields, byId('w1'), planee)).toEqual({ status: 'todo', position: -1 });
  });

  it('(b) a card dragged TODO -> Done writes done', () => {
    const others = slotsIn('done', 't1');
    const plan = planDrop('t1', 'todo', 'done', others, others, 1);
    expect(toCardPatch(plan.fields, byId('t1'), planee)).toEqual({
      status: 'done',
      position: 0.5,
    });
  });

  it('(b) a card dragged into In Progress writes the option value', () => {
    const plan = planDrop('t1', 'todo', 'in_progress', [], [], 0);
    expect(toCardPatch(plan.fields, byId('t1'), planee)).toEqual({
      status: 'in_progress',
      position: 0,
    });
  });

  it('(c) editing a wontfix card without touching the status does not rewrite it', () => {
    const w1 = byId('w1');
    const opened = formStart(fieldsOf(w1), planee);
    // The select shows Done; the reader only renames the card.
    expect(opened.status).toBe('done');
    const changed = formResult('edit', opened, { ...opened, title: 'Nope, really' });
    expect(changed).toEqual({ title: 'Nope, really' });
    expect(toCardPatch(changed, w1, planee)).toEqual({ title: 'Nope, really' });
  });

  it('(c) changing the status in the editor does write it', () => {
    const w1 = byId('w1');
    const opened = formStart(fieldsOf(w1), planee);
    const changed = formResult('edit', opened, { ...opened, status: 'todo' });
    expect(toCardPatch(changed, w1, planee)).toEqual({ status: 'todo' });
  });

  it('(c) saving a card no column claims does not move it into the first column', () => {
    const odd = normalizeEntries([{ id: 'z', title: 'Odd', status: 'archived' }], planee)[0]!;
    const opened = formStart(fieldsOf(odd), planee);
    expect(opened.status).toBe('todo');
    expect(formResult('edit', opened, { ...opened, title: 'Odder' })).toEqual({ title: 'Odder' });
  });

  it('reports only the fields the form shows', () => {
    const shown = ['title', 'status', 'priority'] as const;
    const draft = {
      title: 'New',
      status: 'todo',
      priority: '4',
      due: null,
      description: 'ignored',
    };
    expect(formResult('create', {}, draft, shown)).toEqual({
      title: 'New',
      status: 'todo',
      priority: '4',
    });
    const opened = formStart(fieldsOf(byId('t1')), planee);
    expect(formResult('edit', opened, { ...opened, description: 'x' }, shown)).toEqual({});
    // Everything, by default.
    expect(FORM_FIELDS).toEqual(['title', 'status', 'due', 'priority', 'description']);
    expect(formResult('edit', opened, { ...opened, description: 'x' })).toEqual({
      description: 'x',
    });
  });

  it('resolves numeric priorities 1..4 to the right option', () => {
    expect(entries.map((e) => [e.id, e.priority])).toEqual([
      ['t1', '4'],
      ['p1', '2'],
      ['d1', '3'],
      ['w1', '1'],
      ['o1', '4'],
      ['b1', '4'],
    ]);
    // Written as text, too.
    expect(normalizeEntries([{ id: 'x', priority: '2' }], planee)[0]!.priority).toBe('2');
    // Labels and tones come from the options, not from retoken's defaults.
    expect(planee.priorities.map((p) => [p.id, p.label, p.tone])).toEqual([
      ['1', 'Urgent', 'danger'],
      ['2', 'High', 'warning'],
      ['3', 'Medium', 'info'],
      ['4', 'Low', 'muted'],
    ]);
  });

  it('writes priorities back as numbers, not strings', () => {
    for (const id of ['1', '2', '3', '4']) {
      const patch = toCardPatch({ priority: id }, byId('t1'), planee);
      expect(patch.priority).toBe(Number(id));
    }
    expect(toCardDraft({ title: 'n', status: 'todo', priority: '4' }, planee)).toEqual({
      title: 'n',
      status: 'todo',
      priority: 4,
    });
  });

  it('a priority change in the editor round-trips as a number', () => {
    const d1 = byId('d1');
    const opened = formStart(fieldsOf(d1), planee);
    const changed = formResult('edit', opened, { ...opened, priority: '1' });
    expect(toCardPatch(changed, d1, planee)).toEqual({ priority: 1 });
  });
});
