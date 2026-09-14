// Ported from retoken (af25bc6)
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PRIORITIES,
  DEFAULT_STATUSES,
  foldValue,
  humanize,
  normalizeSchema,
  priorityById,
  resolvePriority,
  resolveRole,
  resolveStatus,
  sampleKeys,
  statusById,
} from './types';

describe('humanize', () => {
  it('turns a key into a heading', () => {
    expect(humanize('due_date')).toBe('Due date');
    expect(humanize('dueDate')).toBe('Due date');
    expect(humanize('due-date')).toBe('Due date');
    expect(humanize('title')).toBe('Title');
  });

  it('returns the key when there is nothing to humanize', () => {
    expect(humanize('')).toBe('');
    expect(humanize('__')).toBe('__');
  });
});

describe('foldValue', () => {
  it('folds case and separators, so one status has one spelling', () => {
    expect(foldValue('IN_PROGRESS')).toBe('in progress');
    expect(foldValue('  In-Progress ')).toBe('in progress');
    expect(foldValue('in   progress')).toBe('in progress');
  });

  it('is empty for nothing', () => {
    expect(foldValue(null)).toBe('');
    expect(foldValue(undefined)).toBe('');
    expect(foldValue('   ')).toBe('');
  });
});

describe('resolveRole', () => {
  it('accepts the canonical names', () => {
    for (const role of ['id', 'title', 'status', 'due', 'priority', 'description', 'order']) {
      expect(resolveRole(role)).toBe(role);
    }
  });

  it('accepts reasonable aliases, however they are written', () => {
    expect(resolveRole('name')).toBe('title');
    expect(resolveRole('state')).toBe('status');
    expect(resolveRole('dueDate')).toBe('due');
    expect(resolveRole('due_date')).toBe('due');
    expect(resolveRole('DEADLINE')).toBe('due');
    expect(resolveRole('urgency')).toBe('priority');
    expect(resolveRole('notes')).toBe('description');
    expect(resolveRole('position')).toBe('order');
  });

  it('returns null for a role it does not know, rather than guessing', () => {
    expect(resolveRole('assignee')).toBeNull();
    expect(resolveRole('')).toBeNull();
  });
});

describe('normalizeSchema', () => {
  it('needs no schema at all when the keys look like the defaults', () => {
    const model = normalizeSchema(undefined, ['id', 'title', 'status', 'dueDate', 'priority']);
    expect(model.fields.title).toBe('title');
    expect(model.fields.status).toBe('status');
    expect(model.fields.due).toBe('dueDate');
    expect(model.statuses.map((s) => s.id)).toEqual(['todo', 'in-progress', 'done']);
  });

  it('picks the spelling the data actually uses for an unnamed role', () => {
    expect(normalizeSchema({}, ['due_date']).fields.due).toBe('due_date');
    expect(normalizeSchema({}, ['due']).fields.due).toBe('due');
    expect(normalizeSchema({}, ['name']).fields.title).toBe('name');
    expect(normalizeSchema({}, ['body']).fields.description).toBe('body');
  });

  it('falls back to the canonical spelling when the data has none of them', () => {
    const model = normalizeSchema({}, ['foo']);
    expect(model.fields.title).toBe('title');
    expect(model.fields.due).toBe('dueDate');
  });

  it('maps your keys onto roles', () => {
    const model = normalizeSchema({
      ticket: 'id',
      headline: 'title',
      state: 'status',
      deadline: 'due',
      urgency: 'priority',
      notes: 'description',
    });
    expect(model.fields).toMatchObject({
      id: 'ticket',
      title: 'headline',
      status: 'state',
      due: 'deadline',
      priority: 'urgency',
      description: 'notes',
    });
  });

  it('ignores a role it does not know', () => {
    const model = normalizeSchema({ assignee: 'person', headline: 'title' });
    expect(model.fields.title).toBe('headline');
    expect(Object.values(model.fields)).not.toContain('assignee');
  });

  it('gives a role exactly one source key — the first one that claims it', () => {
    const model = normalizeSchema({ headline: 'title', name: 'title' });
    expect(model.fields.title).toBe('headline');
  });

  it('reports an ordering field only when there is somewhere to write it', () => {
    expect(normalizeSchema({}, ['id', 'title']).hasOrder).toBe(false);
    expect(normalizeSchema({}, ['id', 'position']).hasOrder).toBe(true);
    expect(normalizeSchema({ seq: 'order' }).hasOrder).toBe(true);
  });

  it('takes a status vocabulary as bare strings', () => {
    const model = normalizeSchema({ state: { role: 'status', options: ['Backlog', 'Doing'] } });
    expect(model.statuses.map((s) => s.id)).toEqual(['Backlog', 'Doing']);
    expect(model.statuses.map((s) => s.label)).toEqual(['Backlog', 'Doing']);
    // The id is what gets written back unless a value says otherwise.
    expect(model.statuses.map((s) => s.value)).toEqual(['Backlog', 'Doing']);
  });

  it('takes a status vocabulary as objects, with the value to write', () => {
    const model = normalizeSchema({
      state: {
        role: 'status',
        options: [
          { id: 'todo', label: 'Inbox', value: 'TO_DO', limit: 3 },
          { id: 'done', label: 'Shipped', value: 2 },
        ],
      },
    });
    expect(model.statuses[0]).toMatchObject({ id: 'todo', label: 'Inbox', value: 'TO_DO', limit: 3 });
    expect(model.statuses[1]).toMatchObject({ id: 'done', label: 'Shipped', value: 2 });
    // Both the written value and the label resolve back to the status.
    expect(resolveStatus('TO_DO', model.statuses)).toBe('todo');
    expect(resolveStatus('Inbox', model.statuses)).toBe('todo');
    expect(resolveStatus(2, model.statuses)).toBe('done');
  });

  it('drops duplicate statuses, keeping the first', () => {
    const model = normalizeSchema({
      state: { role: 'status', options: ['todo', 'TODO', 'done'] },
    });
    expect(model.statuses.map((s) => s.id)).toEqual(['todo', 'done']);
  });

  it('falls back to the three defaults for an empty vocabulary', () => {
    const model = normalizeSchema({ state: { role: 'status', options: [] } });
    expect(model.statuses.map((s) => s.id)).toEqual(DEFAULT_STATUSES.map((s) => s.id));
  });

  it('weights a custom priority list by its order and tones it by position', () => {
    const model = normalizeSchema({
      urgency: { role: 'priority', options: ['whenever', 'soon', 'now'] },
    });
    expect(model.priorities.map((p) => p.weight)).toEqual([0, 1, 2]);
    expect(model.priorities.map((p) => p.tone)).toEqual(['muted', 'info', 'danger']);
  });

  it('re-weights after dropping duplicates so the weights have no gaps', () => {
    const model = normalizeSchema({
      urgency: { role: 'priority', options: ['low', 'low', 'high'] },
    });
    expect(model.priorities.map((p) => [p.id, p.weight])).toEqual([
      ['low', 0],
      ['high', 1],
    ]);
  });

  it('labels the editor fields, and takes an override', () => {
    const plain = normalizeSchema({});
    expect(plain.labels.due).toBe('Due date');
    expect(plain.labels.title).toBe('Title');
    const named = normalizeSchema({ deadline: { role: 'due', label: 'Ship by' } });
    expect(named.labels.due).toBe('Ship by');
  });

  it('carries the due format through', () => {
    expect(normalizeSchema({}).dueFormat).toBe('auto');
    expect(normalizeSchema({ due: { role: 'due', format: 'epoch' } }).dueFormat).toBe('epoch');
  });
});

describe('resolveStatus', () => {
  const statuses = normalizeSchema({}).statuses;

  it('reads the ids', () => {
    expect(resolveStatus('todo', statuses)).toBe('todo');
    expect(resolveStatus('in-progress', statuses)).toBe('in-progress');
    expect(resolveStatus('done', statuses)).toBe('done');
  });

  it('reads how other systems spell them', () => {
    expect(resolveStatus('IN_PROGRESS', statuses)).toBe('in-progress');
    expect(resolveStatus('In Progress', statuses)).toBe('in-progress');
    expect(resolveStatus('doing', statuses)).toBe('in-progress');
    expect(resolveStatus('wip', statuses)).toBe('in-progress');
    expect(resolveStatus('Backlog', statuses)).toBe('todo');
    expect(resolveStatus('open', statuses)).toBe('todo');
    expect(resolveStatus('Completed', statuses)).toBe('done');
    expect(resolveStatus('shipped', statuses)).toBe('done');
  });

  it('is null for a value no column claims', () => {
    expect(resolveStatus('archived', statuses)).toBeNull();
    expect(resolveStatus(null, statuses)).toBeNull();
    expect(resolveStatus('', statuses)).toBeNull();
  });
});

describe('resolvePriority', () => {
  const priorities = normalizeSchema({}).priorities;

  it('reads the ids and their aliases', () => {
    expect(resolvePriority('low', priorities)).toBe('low');
    expect(resolvePriority('Normal', priorities)).toBe('medium');
    expect(resolvePriority('major', priorities)).toBe('high');
    expect(resolvePriority('critical', priorities)).toBe('urgent');
  });

  it('reads the numeric convention where a lower number is more urgent', () => {
    expect(resolvePriority('P0', priorities)).toBe('urgent');
    expect(resolvePriority(1, priorities)).toBe('high');
    expect(resolvePriority('2', priorities)).toBe('medium');
    expect(resolvePriority(3, priorities)).toBe('low');
  });

  it('is null when nothing is set', () => {
    expect(resolvePriority(null, priorities)).toBeNull();
    expect(resolvePriority('whatever', priorities)).toBeNull();
  });

  it('has a default vocabulary of four, quietest first', () => {
    expect(priorities.map((p) => p.id)).toEqual(DEFAULT_PRIORITIES.map((p) => p.id));
    expect(priorities.map((p) => p.tone)).toEqual(['muted', 'info', 'warning', 'danger']);
  });
});

describe('lookups', () => {
  const model = normalizeSchema({});

  it('finds a status and a priority by id', () => {
    expect(statusById('done', model.statuses)?.label).toBe('Done');
    expect(priorityById('urgent', model.priorities)?.tone).toBe('danger');
  });

  it('is undefined for nothing', () => {
    expect(statusById(null, model.statuses)).toBeUndefined();
    expect(priorityById('nope', model.priorities)).toBeUndefined();
  });
});

describe('sampleKeys', () => {
  it('collects the keys across the cards', () => {
    expect(sampleKeys([{ a: 1 }, { b: 2 }, { a: 3, c: 4 }]).sort()).toEqual(['a', 'b', 'c']);
  });

  it('stops after the limit, and survives junk in the list', () => {
    const cards = Array.from({ length: 50 }, (_, i) => ({ [`k${i}`]: i }));
    expect(sampleKeys(cards, 3)).toEqual(['k0', 'k1', 'k2']);
    expect(sampleKeys([null as never, { a: 1 }])).toEqual(['a']);
  });
});
