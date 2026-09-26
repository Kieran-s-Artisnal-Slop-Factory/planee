import { describe, expect, it } from 'vitest';
import {
  buildPalette,
  flatten,
  moveHighlight,
  PAGES,
  RECENT_LIMIT,
  scoreText,
  type PaletteData,
} from './palette';

const data = (over: Partial<PaletteData> = {}): PaletteData => ({
  projects: [
    { id: 'p1', name: 'Planee' },
    { id: 'p2', name: 'Garden' },
  ],
  versions: [
    { id: 'v1', number: '0.1.0', project: 'p1', completed: true },
    { id: 'v2', number: '0.2.0', project: 'p1', completed: false },
  ],
  tasks: [
    { id: 't1', title: 'Fix login bug', description: 'Users cannot sign in\nmore text', project: 'p1' },
    { id: 't2', title: 'Plant tomatoes', description: null, project: 'p2' },
    { id: 't3', title: 'Write docs', description: 'Explain the settings page', project: 'p1' },
  ],
  recent: [],
  ...over,
});

describe('scoreText', () => {
  it('ranks exact > prefix > word start > substring > all words > fuzzy', () => {
    const exact = scoreText('login', 'login')!;
    const prefix = scoreText('log', 'login bug')!;
    const word = scoreText('bug', 'login bug')!;
    const sub = scoreText('ogi', 'login')!;
    const words = scoreText('bug login', 'login bug')!;
    const fuzzy = scoreText('lgn', 'login')!;
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(word);
    expect(word).toBeGreaterThan(sub);
    expect(sub).toBeGreaterThan(words);
    expect(words).toBeGreaterThan(fuzzy);
    expect(fuzzy).toBeGreaterThan(0);
  });

  it('is case- and whitespace-insensitive and rejects non-matches', () => {
    expect(scoreText('  LOGIN ', 'Login')).toBe(1000);
    expect(scoreText('xyz', 'login')).toBeNull();
    expect(scoreText('lgn', 'login', { fuzzy: false })).toBeNull();
    expect(scoreText('', 'anything')).toBe(0);
  });

  it('prefers tighter fuzzy matches', () => {
    expect(scoreText('ab', 'ab-----')!).toBeGreaterThan(scoreText('ab', 'a-----b')!);
  });
});

describe('moveHighlight', () => {
  it('wraps both ways', () => {
    expect(moveHighlight(0, -1, 3)).toBe(2);
    expect(moveHighlight(2, 1, 3)).toBe(0);
    expect(moveHighlight(1, 1, 3)).toBe(2);
    expect(moveHighlight(-1, 1, 3)).toBe(0);
    expect(moveHighlight(-1, -1, 3)).toBe(2);
    expect(moveHighlight(0, 1, 0)).toBe(-1);
  });
});

describe('buildPalette — empty query', () => {
  it('shows Actions, Recent and Pages', () => {
    const groups = buildPalette('', data({ recent: [{ kind: 'task', id: 't1', at: '2026-01-01T00:00:00Z' }] }));
    expect(groups.map((g) => g.name)).toEqual(['Actions', 'Recent', 'Pages']);
    expect(groups[0]!.items.map((i) => i.id)).toEqual(['task', 'version', 'project']);
    expect(groups[2]!.items.map((i) => i.id)).toEqual(PAGES.map((p) => p.id));
  });

  it('orders recent most recent first across kinds, skips deleted rows and duplicates, and caps', () => {
    const groups = buildPalette(
      '',
      data({
        recent: [
          { kind: 'task', id: 't1', at: '2026-01-01T00:00:00Z' },
          { kind: 'project', id: 'p2', at: '2026-01-03T00:00:00Z' },
          { kind: 'version', id: 'v2', at: '2026-01-02T00:00:00Z' },
          { kind: 'task', id: 'gone', at: '2026-01-04T00:00:00Z' },
          { kind: 'task', id: 't1', at: '2025-01-01T00:00:00Z' },
        ],
      })
    );
    const recent = groups.find((g) => g.name === 'Recent')!;
    expect(recent.items.map((i) => `${i.kind}:${i.id}`)).toEqual(['project:p2', 'version:v2', 'task:t1']);
    expect(recent.items[1]!.label).toBe('Planee 0.2.0');
    expect(recent.items[2]!.hint).toBe('Planee');

    const many = Array.from({ length: 20 }, (_, i) => ({
      id: `x${i}`,
      title: `T${i}`,
      description: null,
      project: 'p1',
    }));
    const capped = buildPalette(
      '',
      data({ tasks: many, recent: many.map((t, i) => ({ kind: 'task' as const, id: t.id, at: `2026-01-${String(i + 1).padStart(2, '0')}` })) })
    );
    expect(capped.find((g) => g.name === 'Recent')!.items).toHaveLength(RECENT_LIMIT);
  });

  it('omits Recent when nothing was viewed', () => {
    expect(buildPalette('', data()).map((g) => g.name)).toEqual(['Actions', 'Pages']);
  });
});

describe('buildPalette — with a query', () => {
  it('matches task titles and description first lines', () => {
    const tasks = buildPalette('sign in', data()).find((g) => g.name === 'Tasks')!;
    expect(tasks.items.map((i) => i.id)).toEqual(['t1']);
    // Only the FIRST line of a description counts.
    expect(buildPalette('more text', data()).find((g) => g.name === 'Tasks')).toBeUndefined();
  });

  it('matches versions by "Project number" and by number alone', () => {
    const byLabel = buildPalette('planee 0.2', data()).find((g) => g.name === 'Versions')!;
    expect(byLabel.items[0]!.id).toBe('v2');
    const byNumber = buildPalette('0.1.0', data()).find((g) => g.name === 'Versions')!;
    expect(byNumber.items[0]!.id).toBe('v1');
    expect(byNumber.items[0]!.hint).toBe('completed');
  });

  it('puts the group with the best match first', () => {
    const groups = buildPalette('settings', data());
    expect(groups[0]!.name).toBe('Pages');
    expect(flatten(groups)[0]!.id).toBe('/settings/');
    expect(buildPalette('garden', data())[0]!.name).toBe('Projects');
    expect(buildPalette('new task', data())[0]!.items[0]).toEqual({ kind: 'action', id: 'task', label: 'New Task' });
  });

  it('boosts recently viewed rows among equal matches', () => {
    const d = data({
      tasks: [
        { id: 'a', title: 'Deploy app', description: null, project: 'p1' },
        { id: 'b', title: 'Deploy api', description: null, project: 'p1' },
      ],
      recent: [{ kind: 'task', id: 'b', at: '2026-01-01T00:00:00Z' }],
    });
    expect(buildPalette('deploy', d).find((g) => g.name === 'Tasks')!.items.map((i) => i.id)).toEqual(['b', 'a']);
    // …but a boost never beats a better tier.
    expect(buildPalette('deploy app', d).find((g) => g.name === 'Tasks')!.items[0]!.id).toBe('a');
  });

  it('limits each group and hides Recent', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ id: `x${i}`, title: `Task ${i}`, description: null, project: 'p1' }));
    const groups = buildPalette('task', data({ tasks: many }), { groupLimit: 5 });
    expect(groups.find((g) => g.name === 'Tasks')!.items).toHaveLength(5);
    expect(groups.find((g) => g.name === 'Recent')).toBeUndefined();
  });

  it('returns nothing for a query that matches nothing', () => {
    expect(buildPalette('zzzzqqq', data())).toEqual([]);
  });
});

describe('buildPalette — editor tools and key hints (10c-E)', () => {
  const tools = [
    { id: 'formula', label: 'Insert a formula', hint: 'maths, written as it looks', keys: 'Alt+F', icon: '∑' },
    { id: 'diagram', label: 'Insert a diagram', keys: 'Alt+M' },
    { id: 'drawing', label: 'Insert a drawing', keys: 'Alt+E' },
    { id: 'footnotes', label: 'Insert a footnote', keys: 'Alt+0' },
  ];

  it('has no Editor group unless an editor passes its tools', () => {
    expect(buildPalette('', data()).map((g) => g.name)).not.toContain('Editor');
    expect(buildPalette('insert', data()).map((g) => g.name)).not.toContain('Editor');
  });

  it('puts the tools first on an empty query, with their keys', () => {
    const groups = buildPalette('', data({ tools }));
    expect(groups.map((g) => g.name)).toEqual(['Editor', 'Actions', 'Pages']);
    expect(groups[0]!.items[0]).toEqual({
      kind: 'tool',
      id: 'formula',
      label: 'Insert a formula',
      hint: 'maths, written as it looks',
      keys: 'Alt+F',
      icon: '∑',
    });
    expect(groups[0]!.items.map((i) => i.keys)).toEqual(['Alt+F', 'Alt+M', 'Alt+E', 'Alt+0']);
  });

  it('ranks a tool by its label like any other row', () => {
    const groups = buildPalette('formula', data({ tools }));
    expect(groups[0]!.name).toBe('Editor');
    expect(groups[0]!.items.map((i) => i.id)).toEqual(['formula']);
    expect(buildPalette('insert a d', data({ tools }))[0]!.items.map((i) => i.id)).toEqual(['diagram', 'drawing']);
  });

  it('shows each create action with its chord when one is given', () => {
    const groups = buildPalette('', data({ actionKeys: { task: 'Alt+N', project: 'Alt+Shift+P', version: 'Ctrl+Shift+V' } }));
    expect(groups.find((g) => g.name === 'Actions')!.items).toEqual([
      { kind: 'action', id: 'task', label: 'New Task', keys: 'Alt+N' },
      { kind: 'action', id: 'version', label: 'New Version', keys: 'Ctrl+Shift+V' },
      { kind: 'action', id: 'project', label: 'New Project', keys: 'Alt+Shift+P' },
    ]);
  });
});
