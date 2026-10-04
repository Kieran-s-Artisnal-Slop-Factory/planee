/**
 * The command palette's brain: which items show for a query, how they rank
 * and how they group. Pure (plain rows in, groups out) so it is unit-tested in
 * node (palette.test.ts); CommandPalette.svelte only loads rows and renders.
 *
 * Ranking (`scoreText`, higher is better, null = no match):
 *
 *   exact label                      1000
 *   label starts with the query       800
 *   a word in the label starts with it 600
 *   substring anywhere                400 (minus how far in it starts, ≥ 300)
 *   every query word is a substring   250
 *   letters in order (fuzzy)          1–100 (fewer gaps score higher)
 *
 * Tasks also match the first line of their description, at half weight and
 * without the fuzzy tier (a paragraph matches almost anything fuzzily).
 * Recently viewed rows get a small boost so, among equal matches, the one you
 * were just looking at comes first. Groups are ordered by their best item, so
 * Enter on the first row is the best match whichever group it is in.
 *
 * Editor tools (10c-E, D22): while a markdown editor is open the caller
 * passes `tools` ("Insert a formula" …), shown as an Editor group — first
 * when the query is empty, since inserting is what you are most likely
 * reaching for mid-edit — and ranked by label otherwise. Items may carry
 * `keys`, the chord that does the same thing (tool keys; the create
 * actions' keybinds via `actionKeys`), which the palette shows as a hint.
 */
import type { CreateKind } from './commands';
import type { RecentKind } from './recent';

export type PaletteKind = 'action' | 'tool' | 'task' | 'project' | 'version' | 'page';
export type GroupName = 'Editor' | 'Actions' | 'Recent' | 'Tasks' | 'Projects' | 'Versions' | 'Pages';

export interface PaletteItem {
  kind: PaletteKind;
  /** Row id; the CreateKind for actions; the tool id for tools; the app path for pages. */
  id: string;
  label: string;
  /** Secondary text (a task's project, "completed"). */
  hint?: string;
  /** The key chord that does the same thing, as shown (`Alt+F`, `Alt+N`). */
  keys?: string;
  /** A glyph shown instead of the kind's icon (the editor tools'). */
  icon?: string;
}

/** An editor tool row, as the caller hands it in (lib/markdown/shortcuts.ts TOOLS). */
export interface PaletteTool {
  id: string;
  label: string;
  hint?: string;
  keys?: string;
  icon?: string;
}

export interface PaletteGroup {
  name: GroupName;
  items: PaletteItem[];
}

export interface PaletteTask {
  id: string;
  title: string;
  description: string | null;
  project: string;
}
export interface PaletteProject {
  id: string;
  name: string;
  description?: string | null;
}
export interface PaletteVersion {
  id: string;
  number: string;
  project: string;
  completed: boolean;
}
export interface PaletteRecent {
  kind: RecentKind;
  id: string;
  /** UTC ISO 8601 of the view. */
  at: string;
}

export interface PaletteData {
  tasks: readonly PaletteTask[];
  projects: readonly PaletteProject[];
  versions: readonly PaletteVersion[];
  /** Views of every kind; order does not matter (sorted by `at` here). */
  recent: readonly PaletteRecent[];
  /** Editor tools, when a markdown editor is open to receive them. */
  tools?: readonly PaletteTool[];
  /** The chord shown beside each create action. */
  actionKeys?: Partial<Record<CreateKind, string>>;
}

export const ACTIONS: readonly { id: CreateKind; label: string }[] = [
  { id: 'task', label: 'New Task' },
  { id: 'version', label: 'New Version' },
  { id: 'project', label: 'New Project' },
];

/** App paths (pass through paths.ts href() before navigating). */
export const PAGES: readonly { id: string; label: string }[] = [
  { id: '/', label: 'Home' },
  { id: '/project/', label: 'Project' },
  { id: '/version/', label: 'Version' },
  { id: '/task/', label: 'Task' },
  { id: '/version_task/', label: 'Version task' },
  { id: '/asset/', label: 'Assets' },
  { id: '/preferences/', label: 'Preferences' },
  { id: '/settings/', label: 'Settings' },
];

export const RECENT_LIMIT = 8;
export const GROUP_LIMIT = 8;
/** Added to a recently viewed row's score: enough to break ties, never to beat a better tier. */
export const RECENT_BOOST = 50;

const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** How well `text` matches `query` (see the module comment); null when it doesn't. */
export function scoreText(query: string, text: string, { fuzzy = true }: { fuzzy?: boolean } = {}): number | null {
  const q = normalize(query);
  const t = normalize(text);
  if (q === '') return 0;
  if (t === '') return null;
  if (t === q) return 1000;
  if (t.startsWith(q)) return 800;
  const at = t.indexOf(q);
  if (at > 0) {
    const before = t[at - 1]!;
    if (!/[a-z0-9]/.test(before)) return 600;
    return Math.max(300, 400 - at);
  }
  const words = q.split(' ');
  if (words.length > 1 && words.every((w) => t.includes(w))) return 250;
  if (!fuzzy) return null;
  // Letters in order; each skipped character costs a point.
  let ti = 0;
  let gaps = 0;
  let started = false;
  for (const ch of q.replace(/ /g, '')) {
    const found = t.indexOf(ch, ti);
    if (found === -1) return null;
    if (started) gaps += found - ti;
    started = true;
    ti = found + 1;
  }
  return Math.max(1, 100 - gaps);
}

const firstLine = (s: string | null | undefined) => (s ?? '').split('\n').find((line) => line.trim() !== '')?.trim() ?? '';

/** A project's label: its name, or its description for unnamed rows (crud.ts projectLabel). */
export function projectName(project: PaletteProject | undefined): string {
  if (!project) return '';
  return (project.name ?? '').trim() || firstLine(project.description) || '(unnamed)';
}

export function taskTitle(task: PaletteTask): string {
  return (task.title ?? '').trim() || firstLine(task.description) || '(untitled)';
}

export function versionLabel(version: PaletteVersion, projects: ReadonlyMap<string, PaletteProject>): string {
  const name = projectName(projects.get(version.project));
  return name ? `${name} ${version.number}` : version.number;
}

/** Wrap-around highlight movement; -1 when there is nothing to highlight. */
export function moveHighlight(index: number, delta: number, length: number): number {
  if (length <= 0) return -1;
  if (index < 0) return delta < 0 ? length - 1 : 0;
  return (((index + delta) % length) + length) % length;
}

export function flatten(groups: readonly PaletteGroup[]): PaletteItem[] {
  return groups.flatMap((g) => g.items);
}

interface Scored {
  item: PaletteItem;
  score: number;
  /** Original order, for stable ties. */
  order: number;
}

function top(scored: Scored[], limit: number): { items: PaletteItem[]; best: number } {
  scored.sort((a, b) => b.score - a.score || a.order - b.order);
  return { items: scored.slice(0, limit).map((s) => s.item), best: scored[0]?.score ?? -Infinity };
}

export function buildPalette(
  query: string,
  data: PaletteData,
  { recentLimit = RECENT_LIMIT, groupLimit = GROUP_LIMIT }: { recentLimit?: number; groupLimit?: number } = {}
): PaletteGroup[] {
  const projects = new Map(data.projects.map((p) => [p.id, p]));
  const tasks = new Map(data.tasks.map((t) => [t.id, t]));
  const versions = new Map(data.versions.map((v) => [v.id, v]));

  const taskItem = (t: PaletteTask): PaletteItem => ({
    kind: 'task',
    id: t.id,
    label: taskTitle(t),
    hint: projectName(projects.get(t.project)) || undefined,
  });
  const projectItem = (p: PaletteProject): PaletteItem => ({ kind: 'project', id: p.id, label: projectName(p) });
  const versionItem = (v: PaletteVersion): PaletteItem => ({
    kind: 'version',
    id: v.id,
    label: versionLabel(v, projects),
    hint: v.completed ? 'completed' : undefined,
  });

  // Recent, most recent first, resolved to live rows (deleted ones skipped).
  const recentItems: PaletteItem[] = [];
  const recentRank = new Map<string, number>();
  const seen = new Set<string>();
  for (const view of [...data.recent].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))) {
    const key = `${view.kind}:${view.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let item: PaletteItem | undefined;
    if (view.kind === 'task') {
      const t = tasks.get(view.id);
      item = t && taskItem(t);
    } else if (view.kind === 'project') {
      const p = projects.get(view.id);
      item = p && projectItem(p);
    } else {
      const v = versions.get(view.id);
      item = v && versionItem(v);
    }
    if (!item) continue;
    recentRank.set(key, recentItems.length);
    recentItems.push(item);
  }

  const withKeys = (item: PaletteItem, keys: string | undefined): PaletteItem => (keys ? { ...item, keys } : item);
  const actions = ACTIONS.map((a): PaletteItem =>
    withKeys({ kind: 'action', id: a.id, label: a.label }, data.actionKeys?.[a.id])
  );
  const tools = (data.tools ?? []).map((t): PaletteItem => {
    const item: PaletteItem = withKeys({ kind: 'tool', id: t.id, label: t.label }, t.keys);
    if (t.hint) item.hint = t.hint;
    if (t.icon) item.icon = t.icon;
    return item;
  });
  const pages = PAGES.map((p): PaletteItem => ({ kind: 'page', id: p.id, label: p.label }));

  if (normalize(query) === '') {
    const groups: PaletteGroup[] = [
      { name: 'Editor', items: tools },
      { name: 'Actions', items: actions },
      { name: 'Recent', items: recentItems.slice(0, recentLimit) },
      { name: 'Pages', items: pages },
    ];
    return groups.filter((g) => g.items.length > 0);
  }

  const boost = (kind: RecentKind, id: string) => (recentRank.has(`${kind}:${id}`) ? RECENT_BOOST : 0);
  const recency = (kind: RecentKind, id: string, fallback: number) =>
    recentRank.get(`${kind}:${id}`) ?? recentItems.length + fallback;

  const scoreAll = <T>(rows: readonly T[], score: (row: T) => number | null, item: (row: T) => PaletteItem, order: (row: T, i: number) => number) => {
    const out: Scored[] = [];
    rows.forEach((row, i) => {
      const s = score(row);
      if (s !== null) out.push({ item: item(row), score: s, order: order(row, i) });
    });
    return out;
  };

  const candidates: { name: GroupName; scored: Scored[] }[] = [
    {
      name: 'Editor',
      scored: scoreAll(tools, (t) => scoreText(query, t.label), (t) => t, (_t, i) => i),
    },
    {
      name: 'Actions',
      scored: scoreAll(actions, (a) => scoreText(query, a.label), (a) => a, (_a, i) => i),
    },
    {
      name: 'Tasks',
      scored: scoreAll(
        data.tasks,
        (t) => {
          const title = scoreText(query, taskTitle(t));
          const desc = scoreText(query, firstLine(t.description), { fuzzy: false });
          const best = Math.max(title ?? -1, desc === null ? -1 : desc / 2);
          return best < 0 ? null : best + boost('task', t.id);
        },
        taskItem,
        (t, i) => recency('task', t.id, i)
      ),
    },
    {
      name: 'Projects',
      scored: scoreAll(
        data.projects,
        (p) => {
          const s = scoreText(query, projectName(p));
          return s === null ? null : s + boost('project', p.id);
        },
        projectItem,
        (p, i) => recency('project', p.id, i)
      ),
    },
    {
      name: 'Versions',
      scored: scoreAll(
        data.versions,
        (v) => {
          const s = Math.max(scoreText(query, versionLabel(v, projects)) ?? -1, scoreText(query, v.number) ?? -1);
          return s < 0 ? null : s + boost('version', v.id);
        },
        versionItem,
        (v, i) => recency('version', v.id, i)
      ),
    },
    {
      name: 'Pages',
      scored: scoreAll(pages, (p) => scoreText(query, p.label), (p) => p, (_p, i) => i),
    },
  ];

  const fixedOrder = candidates.map((c) => c.name);
  return candidates
    .map((c) => ({ name: c.name, ...top(c.scored, groupLimit) }))
    .filter((g) => g.items.length > 0)
    .sort((a, b) => b.best - a.best || fixedOrder.indexOf(a.name) - fixedOrder.indexOf(b.name))
    .map(({ name, items }) => ({ name, items }));
}
