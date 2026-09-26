/**
 * Home's "recent issues" strip (D16, D17): the tasks most recently added,
 * updated or viewed, across every project.
 *
 * Pure: the component hands in live rows plus this device's task views
 * (lib/ui/recent.ts) and gets back display-ready items, so the ranking rules
 * are unit-tested in node.
 *
 * Rules, per live task (whose project is live):
 *   activityAt = max(task.updated_at, viewedAt)
 *   reason     = 'viewed'  when the view is that max (a view at the same
 *                           instant as the edit counts as the view)
 *              = 'added'   else, when the row looks unedited since creation
 *              = 'updated' otherwise
 * There is no created_at column. A task is field-merged, so every column
 * carries a stamp once the row was written; the OLDEST stamp approximates its
 * creation time (`updated_at` when the map is empty). A task whose updated_at is
 * within ADDED_TOLERANCE_MS of that is "added".
 *
 * A STATUS change on any of the task's version links (moving the card to
 * another column, setting a resolution, bumping) also counts as an update, via
 * that link's per-field `status` stamp. Its `updated_at` is deliberately not
 * used: a reorder rewrites `position` on neighbouring cards too, and those
 * tasks weren't touched.
 */
import { RESOLUTION_LABELS } from '../board/adapter';
import { STATUS_TYPE_VALUES, TASK_TYPE_VALUES } from '../db/types';
import type { Project, StatusTypeKey, Task, TaskTypeKey, Version, VersionTask } from '../db/types';
import { pickTaskVersion } from './links';
import type { RecentView } from './recent';

export type RecentReason = 'added' | 'updated' | 'viewed';

/** How close updated_at may be to the oldest field stamp and still read as "added". */
export const ADDED_TOLERANCE_MS = 1000;

export interface RecentIssue {
  taskId: string;
  title: string;
  projectId: string;
  projectName: string;
  /** The version its card opens in (links.pickTaskVersion); undefined = unscheduled. */
  version: { id: string; number: string; completed: boolean } | undefined;
  /** The link's status in that version; undefined when unscheduled. */
  status: StatusTypeKey | undefined;
  taskType: TaskTypeKey;
  activityAt: string;
  reason: RecentReason;
}

export interface RecentIssuesInput {
  tasks: readonly Task[];
  links: readonly VersionTask[];
  versions: readonly Version[];
  projects: readonly Project[];
  /** Task views on this device, any order. */
  views: readonly RecentView[];
  limit: number;
}

const ms = (iso: string | null | undefined): number => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? 0 : t;
};

/** Approximate creation time: the oldest per-field stamp, else updated_at. */
export function createdAtOf(task: Pick<Task, 'updated_at' | 'field_updated_at'>): string {
  const stamps = Object.values(task.field_updated_at ?? {}).filter((s) => ms(s) > 0);
  if (stamps.length === 0) return task.updated_at;
  return stamps.reduce((min, s) => (ms(s) < ms(min) ? s : min));
}

export function looksUnedited(task: Pick<Task, 'updated_at' | 'field_updated_at'>): boolean {
  return Math.abs(ms(task.updated_at) - ms(createdAtOf(task))) <= ADDED_TOLERANCE_MS;
}

export function recentIssues(input: RecentIssuesInput): RecentIssue[] {
  const limit = Math.max(0, Math.floor(input.limit));
  if (limit === 0) return [];
  const projects = new Map(input.projects.filter((p) => !p.deleted_at).map((p) => [p.id, p]));
  const viewed = new Map<string, string>();
  for (const view of input.views) {
    const prior = viewed.get(view.id);
    if (!prior || ms(view.at) > ms(prior)) viewed.set(view.id, view.at);
  }
  const liveLinks = input.links.filter((l) => !l.deleted_at);
  const statusAt = new Map<string, string>();
  for (const link of liveLinks) {
    const at = link.field_updated_at?.status;
    if (!at) continue;
    const prior = statusAt.get(link.task);
    if (!prior || ms(at) > ms(prior)) statusAt.set(link.task, at);
  }

  const ranked = input.tasks
    .filter((task) => !task.deleted_at && projects.has(task.project))
    .map((task) => {
      const linkStatusAt = statusAt.get(task.id);
      const statusChanged =
        linkStatusAt !== undefined && ms(linkStatusAt) > ms(task.updated_at) + ADDED_TOLERANCE_MS;
      const updatedAt = statusChanged ? linkStatusAt : task.updated_at;
      const viewedAt = viewed.get(task.id);
      const isView = viewedAt !== undefined && ms(viewedAt) >= ms(updatedAt);
      const activityAt = isView ? viewedAt : updatedAt;
      const reason: RecentReason = isView
        ? 'viewed'
        : !statusChanged && looksUnedited(task)
          ? 'added'
          : 'updated';
      return { task, activityAt, reason };
    })
    // Newest first; ties by id byte order so every render agrees.
    .sort((a, b) => ms(b.activityAt) - ms(a.activityAt) || (a.task.id < b.task.id ? -1 : a.task.id > b.task.id ? 1 : 0))
    .slice(0, limit);

  return ranked.map(({ task, activityAt, reason }) => {
    const picked = pickTaskVersion(task.id, liveLinks, input.versions);
    const link = picked ? liveLinks.find((l) => l.task === task.id && l.version === picked.id) : undefined;
    return {
      taskId: task.id,
      title: task.title?.trim() || 'Untitled',
      projectId: task.project,
      projectName: projects.get(task.project)?.name?.trim() || 'Untitled project',
      version: picked ? { id: picked.id, number: picked.number, completed: !!picked.completed } : undefined,
      status: link?.status,
      taskType: task.task_type,
      activityAt,
      reason,
    };
  });
}

/** Normalise a stored preferences.recent_issues_count (absent/garbage → default). */
export function recentIssuesCount(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

// ─── Labels ─────────────────────────────────────────────────────────────────

export function statusLabel(status: StatusTypeKey): string {
  if (RESOLUTION_LABELS[status]) return RESOLUTION_LABELS[status];
  return STATUS_TYPE_VALUES.find((s) => s.key === status)?.label ?? status;
}

export function taskTypeLabel(type: string): string {
  return TASK_TYPE_VALUES.find((t) => t.key === type)?.label ?? type;
}

/** Pill tone per task type (the board's card badge uses the same). */
export const TASK_TYPE_TONES: Record<string, string> = {
  bug: 'danger',
  feature: 'primary',
  exploration: 'info',
  cleanup: 'muted',
};

export function statusTone(status: StatusTypeKey): string {
  switch (status) {
    case 'todo':
      return 'muted';
    case 'in_progress':
      return 'info';
    case 'done':
      return 'success';
    case 'bumped':
      return 'info';
    default:
      return 'warning';
  }
}

const REASON_VERBS: Record<RecentReason, string> = { added: 'Added', updated: 'Updated', viewed: 'Viewed' };

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600_000],
  ['month', 30 * 24 * 3600_000],
  ['week', 7 * 24 * 3600_000],
  ['day', 24 * 3600_000],
  ['hour', 3600_000],
  ['minute', 60_000],
];

/** "5m ago", "yesterday" — the largest whole unit; under a minute is "just now". */
export function relativeTime(at: string, now: number = Date.now(), locale?: string): string {
  const elapsed = now - ms(at);
  if (elapsed < 60_000) return 'just now'; // includes clock skew into the future
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'narrow' });
  for (const [unit, size] of UNITS) {
    if (elapsed >= size) return format.format(-Math.floor(elapsed / size), unit);
  }
  return 'just now';
}

/** "Viewed 5m ago" / "Updated 2h ago" / "Added yesterday". */
export function activityLabel(
  item: Pick<RecentIssue, 'reason' | 'activityAt'>,
  now: number = Date.now(),
  locale?: string
): string {
  return `${REASON_VERBS[item.reason]} ${relativeTime(item.activityAt, now, locale)}`;
}
