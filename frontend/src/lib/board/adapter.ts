/**
 * The board adapter: how planee's rows become KanbanBoard cards, and what each
 * board operation should write. PURE — no IndexedDB, no Svelte — so every
 * decision is unit-tested (adapter.test.ts). `actions.ts` executes the plans
 * through repo.ts.
 *
 * A card is a `version_task` (D1) joined to its `task`:
 *
 *   card.id        = version_task.id   (what the board reports back)
 *   card.status    = version_task.status   ─┐ per version: patch the link
 *   card.position  = version_task.position ─┘
 *   card.title / priority / description / subtasks / task_type
 *                  = the task's fields         shared: patch the task
 *
 * The Done column claims `done` plus the three resolutions (D2). The board
 * only sends `status` when a card changes column, so reordering a `wontfix`
 * card inside Done keeps `wontfix` (see board.ts planDrop, tested here too).
 */
import type { CardRecord, KanbanSchema, Tone } from '../kanban/types';
import {
  DEFAULT_PRIORITY,
  DEFAULT_STATUS,
  DEFAULT_TASK_TYPE,
  PRIORITY_VALUES,
  STATUS_TYPE_VALUES,
  TASK_TYPE_VALUES,
  isDoneStatus,
} from '../db/types';
import type {
  StatusTypeKey,
  SyncFields,
  Task,
  TaskTypeKey,
  Version,
  VersionTask,
} from '../db/types';
import { compareVersions, nextVersionAfter, suggestNextNumber } from '../versions';

// ─── Schema and cards ───────────────────────────────────────────────────────

const PRIORITY_TONES: Record<number, Tone> = { 1: 'danger', 2: 'warning', 3: 'info', 4: 'muted' };

/** Statuses the Done column claims besides `done` itself (D2). */
export const RESOLUTION_STATUSES: StatusTypeKey[] = ['wontfix', 'out_of_scope', 'bumped'];

/** Short labels for the resolution badges and select. */
export const RESOLUTION_LABELS: Record<string, string> = {
  done: 'Done',
  wontfix: "Won't fix",
  out_of_scope: 'Out of scope',
  bumped: 'Bumped',
};

/** The board's schema for planee cards. */
export function boardSchema(): KanbanSchema {
  return {
    id: 'id',
    title: 'title',
    status: {
      role: 'status',
      options: [
        { id: 'todo', label: 'TODO', tone: 'muted' },
        { id: 'in_progress', label: 'In Progress', tone: 'info' },
        { id: 'done', label: 'Done', tone: 'success', match: [...RESOLUTION_STATUSES] },
      ],
    },
    priority: {
      role: 'priority',
      // Ids are the numbers as strings: a word id ("low") would pull in the
      // board's built-in spellings, where "3" means low.
      options: PRIORITY_VALUES.map((p) => ({
        id: String(p.value),
        label: p.label,
        value: p.value,
        tone: PRIORITY_TONES[p.value] ?? 'muted',
      })),
    },
    position: 'order',
    description: 'description',
  };
}

/** The composer's starting values, in the board's own vocabulary (priority ids). */
export const BOARD_CREATE_DEFAULTS = { priority: String(DEFAULT_PRIORITY) };

/** What a card carries. `id` is the version_task id. */
export interface BoardCard extends CardRecord {
  id: string;
  taskId: string;
  title: string;
  status: StatusTypeKey;
  priority: number;
  position: number;
  description: string;
  subtasks: string;
  task_type: TaskTypeKey;
}

/** Live links whose task is live, as cards. */
export function toCards(links: readonly VersionTask[], tasks: readonly Task[]): BoardCard[] {
  const byId = new Map(tasks.filter((t) => !t.deleted_at).map((t) => [t.id, t]));
  const cards: BoardCard[] = [];
  for (const link of links) {
    if (link.deleted_at) continue;
    const task = byId.get(link.task);
    if (!task) continue;
    cards.push({
      id: link.id,
      taskId: task.id,
      title: task.title ?? '',
      status: link.status ?? DEFAULT_STATUS,
      priority: typeof task.priority === 'number' ? task.priority : DEFAULT_PRIORITY,
      position: typeof link.position === 'number' ? link.position : 0,
      description: task.description ?? '',
      subtasks: task.subtasks ?? '',
      task_type: task.task_type ?? DEFAULT_TASK_TYPE,
    });
  }
  return cards;
}

// ─── Updates ────────────────────────────────────────────────────────────────

export type LinkChanges = Partial<Pick<VersionTask, 'status' | 'position'>>;
export type TaskChanges = Partial<Pick<Task, 'title' | 'priority' | 'description' | 'subtasks' | 'task_type'>>;

const STATUS_KEYS = new Set<string>(STATUS_TYPE_VALUES.map((s) => s.key));
const TASK_TYPE_KEYS = new Set<string>(TASK_TYPE_VALUES.map((t) => t.key));

export const isStatusKey = (value: unknown): value is StatusTypeKey =>
  typeof value === 'string' && STATUS_KEYS.has(value);
export const isTaskTypeKey = (value: unknown): value is TaskTypeKey =>
  typeof value === 'string' && TASK_TYPE_KEYS.has(value);

/** A priority from the board (number, numeric string, null or '') as a stored number. */
export function toPriority(value: unknown): number {
  if (value === null || value === undefined || value === '') return DEFAULT_PRIORITY;
  const n = typeof value === 'number' ? value : Number(value);
  return PRIORITY_VALUES.some((p) => p.value === n) ? n : DEFAULT_PRIORITY;
}

/**
 * Split a board patch (card keys) into what belongs to the link and what
 * belongs to the task. Only keys present in the patch come out, so each side
 * can be `patch`ed with exactly the fields the reader changed.
 */
export function splitPatch(patch: CardRecord): { link: LinkChanges; task: TaskChanges } {
  const link: LinkChanges = {};
  const task: TaskChanges = {};
  const has = (key: string) => Object.prototype.hasOwnProperty.call(patch, key);
  if (has('status') && isStatusKey(patch.status)) link.status = patch.status;
  if (has('position')) {
    const n = Number(patch.position);
    if (Number.isFinite(n)) link.position = n;
  }
  if (has('title')) task.title = String(patch.title ?? '');
  if (has('priority')) task.priority = toPriority(patch.priority);
  if (has('description')) task.description = (patch.description as string | null) ?? null;
  if (has('subtasks')) task.subtasks = (patch.subtasks as string | null) ?? null;
  if (has('task_type') && isTaskTypeKey(patch.task_type)) task.task_type = patch.task_type;
  return { link, task };
}

// ─── Positions ──────────────────────────────────────────────────────────────

/** The board column a status sits in: every done status shares Done. */
export const columnOf = (status: string): string => (isDoneStatus(status) ? 'done' : status);

/** A sort key above every live card in `status`'s column (0 when it is empty). */
export function topPosition(links: readonly VersionTask[], status: string): number {
  const column = columnOf(status);
  const positions = links
    .filter((l) => !l.deleted_at && columnOf(l.status) === column)
    .map((l) => l.position)
    .filter((p) => typeof p === 'number' && Number.isFinite(p));
  return positions.length > 0 ? Math.min(...positions) - 1 : 0;
}

// ─── Create ─────────────────────────────────────────────────────────────────

export type NewTask = Omit<Task, keyof SyncFields>;
export type NewLink = Omit<VersionTask, keyof SyncFields>;

export interface CreateContext {
  projectId: string;
  versionId: string;
  /** preferences.default_task_type, when set. */
  defaultTaskType?: TaskTypeKey | null;
  /** The version's live links, for "top of the column" when the draft has no position. */
  links: readonly VersionTask[];
}

/** The task row and the link row (minus the task id) a new card writes. */
export function planCreate(
  draft: CardRecord,
  ctx: CreateContext
): { task: NewTask; link: Omit<NewLink, 'task'> } {
  const status = isStatusKey(draft.status) ? draft.status : DEFAULT_STATUS;
  const drafted = Number(draft.position);
  const position =
    draft.position !== undefined && draft.position !== null && draft.position !== '' && Number.isFinite(drafted)
      ? drafted
      : topPosition(ctx.links, status);
  return {
    task: {
      project: ctx.projectId,
      title: String(draft.title ?? '').trim(),
      task_type: isTaskTypeKey(draft.task_type)
        ? draft.task_type
        : (ctx.defaultTaskType ?? DEFAULT_TASK_TYPE),
      description: typeof draft.description === 'string' && draft.description !== '' ? draft.description : null,
      priority: toPriority(draft.priority),
      subtasks: typeof draft.subtasks === 'string' && draft.subtasks !== '' ? draft.subtasks : null,
    },
    link: { version: ctx.versionId, status, position },
  };
}

// ─── Delete ─────────────────────────────────────────────────────────────────

/**
 * Delete a card: the link always, and the task too when no OTHER live link
 * schedules it (a task bumped through three versions keeps its history).
 * `links` must include the task's links in every version.
 */
export function planDelete(
  linkId: string,
  links: readonly VersionTask[]
): { deleteLink: string; deleteTask: boolean; taskId: string | null } {
  const link = links.find((l) => l.id === linkId);
  if (!link) return { deleteLink: linkId, deleteTask: false, taskId: null };
  const others = links.some((l) => l.id !== linkId && !l.deleted_at && l.task === link.task);
  return { deleteLink: linkId, deleteTask: !others, taskId: link.task };
}

// ─── Bump (D1) and complete (D5) ────────────────────────────────────────────

export type BumpTarget = { version: Version } | { create: string };

export interface BumpItem {
  /** The link being bumped: patched to `bumped`. */
  oldLinkId: string;
  /** An existing live link for the task in the target version, reused instead of duplicated. */
  reuseLinkId: string | null;
  /** The target link's values (for a reused link: patch status + position). */
  newLink: { task: string; status: 'todo'; position: number };
}

export interface BumpPlan {
  patchOld: { status: 'bumped' };
  target: BumpTarget;
  items: BumpItem[];
}

/**
 * Where bumping from `from` goes: the next incomplete version above it, or a
 * new one numbered by a minor bump that isn't taken yet.
 */
export function bumpTargetFor(from: Version, versions: readonly Version[]): BumpTarget {
  const next = nextVersionAfter(versions, from);
  if (next) return { version: next };
  const live = versions.filter((v) => !v.deleted_at);
  const highest = live.reduce<string>(
    (max, v) => (compareVersions(v.number, max) > 0 ? v.number : max),
    from.number
  );
  return { create: suggestNextNumber(highest, live.map((v) => v.number)) };
}

/**
 * Bump several links of ONE version to the same target. They land at the top
 * of the target's TODO column, keeping their relative order (in-progress work
 * first, then TODO, each by position).
 *
 * `allLinks` must include the target version's links (and may include more).
 */
export function planBumpMany(
  links: readonly VersionTask[],
  from: Version,
  versions: readonly Version[],
  allLinks: readonly VersionTask[]
): BumpPlan {
  const target = bumpTargetFor(from, versions);
  const targetId = 'version' in target ? target.version.id : null;
  const inTarget = targetId ? allLinks.filter((l) => !l.deleted_at && l.version === targetId) : [];
  const moving = [...links].sort(
    (a, b) => rank(a.status) - rank(b.status) || a.position - b.position
  );
  const reused = new Set<string>();
  const found = moving.map((link) => {
    const existing = inTarget.find((l) => l.task === link.task && !reused.has(l.id));
    if (existing) reused.add(existing.id);
    return existing ?? null;
  });
  // Top of TODO, computed without the links being reused (they are moving).
  const top = topPosition(inTarget.filter((l) => !reused.has(l.id)), 'todo');
  const items = moving.map((link, i) => ({
    oldLinkId: link.id,
    reuseLinkId: found[i]?.id ?? null,
    newLink: { task: link.task, status: 'todo' as const, position: top - (moving.length - 1) + i },
  }));
  return { patchOld: { status: 'bumped' }, target, items };
}

const rank = (status: string) => (status === 'in_progress' ? 0 : status === 'todo' ? 1 : 2);

/** D1: bump one link. See planBumpMany. */
export function planBump(
  link: VersionTask,
  from: Version,
  versions: readonly Version[],
  allLinks: readonly VersionTask[]
): BumpPlan {
  return planBumpMany([link], from, versions, allLinks);
}

/** Links of `version` with open work (todo / in progress). */
export function openLinksOf(versionId: string, links: readonly VersionTask[]): VersionTask[] {
  return links.filter(
    (l) => !l.deleted_at && l.version === versionId && (l.status === 'todo' || l.status === 'in_progress')
  );
}

/**
 * D5: what completing `version` involves. With open links the UI offers "Bump
 * N open tasks to <target> and complete", "Complete anyway" and Cancel.
 */
export function planComplete(
  version: Version,
  links: readonly VersionTask[],
  versions: readonly Version[] = []
): { openLinks: VersionTask[]; todo: number; inProgress: number; target: BumpTarget } {
  const openLinks = openLinksOf(version.id, links);
  return {
    openLinks,
    todo: openLinks.filter((l) => l.status === 'todo').length,
    inProgress: openLinks.filter((l) => l.status === 'in_progress').length,
    target: bumpTargetFor(version, versions),
  };
}

// ─── Subtasks ───────────────────────────────────────────────────────────────

const TASK_ITEM = /^\s*(?:>\s*)*(?:[-*+]|\d{1,9}[.)])\s+\[([ xX])\](?:\s|$)/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;

/** Checked and total GFM task-list items in `md`, ignoring fenced code. */
export function subtaskProgress(md: string | null | undefined): { done: number; total: number } {
  let done = 0;
  let total = 0;
  let fence: string | null = null;
  for (const line of (md ?? '').split(/\r?\n/)) {
    const opener = FENCE.exec(line);
    if (fence) {
      if (opener && opener[1]![0] === fence[0] && opener[1]!.length >= fence.length && line.trim() === opener[1]) {
        fence = null;
      }
      continue;
    }
    if (opener) {
      fence = opener[1]!;
      continue;
    }
    const item = TASK_ITEM.exec(line);
    if (!item) continue;
    total += 1;
    if (item[1] !== ' ') done += 1;
  }
  return { done, total };
}
