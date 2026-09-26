/**
 * Where things open. Home IS the board (D17), so projects, versions and tasks
 * all deep-link into `/` with query params; the one exception is a task that
 * isn't scheduled in any version, which has no card to open and goes to the
 * Task overview page's editor instead (D18).
 *
 *   /?project=<id>&version=<id>            the board for that version
 *   /?project=<id>&version=<id>&task=<id>  …with that task's card dialog open
 *   /task/?edit=<task id>                  the Task page's edit form
 *
 * The pure pickers take plain rows so they are unit-testable; resolveTaskHref
 * wires them to IndexedDB.
 */
import { href } from '../paths';
import { compareVersions } from '../versions';
import type { Task, Version, VersionTask } from '../db/types';

export interface BoardTarget {
  project?: string | null;
  version?: string | null;
  task?: string | null;
}

/** The last board selection, remembered by the board (per device). */
export const BOARD_LAST_KEY = 'planee-board-last';

export function boardHref(target: BoardTarget = {}): string {
  const params = new URLSearchParams();
  if (target.project) params.set('project', target.project);
  if (target.version) params.set('version', target.version);
  if (target.task) params.set('task', target.task);
  const query = params.toString();
  return href('/') + (query ? '?' + query : '');
}

export function taskEditHref(taskId: string): string {
  return href('/task/') + '?edit=' + encodeURIComponent(taskId);
}

/**
 * The version a task's card should open in: among its live links whose
 * version is live, the OLDEST incomplete version (where it is being worked on
 * now — matching the board's "current version" rule), else the NEWEST
 * completed one. Undefined when the task is unscheduled.
 */
export function pickTaskVersion(
  taskId: string,
  links: readonly Pick<VersionTask, 'version' | 'task' | 'deleted_at'>[],
  versions: readonly Pick<Version, 'id' | 'number' | 'completed' | 'deleted_at'>[]
): Pick<Version, 'id' | 'number' | 'completed'> | undefined {
  const byId = new Map(versions.filter((v) => !v.deleted_at).map((v) => [v.id, v]));
  const candidates = links
    .filter((l) => l.task === taskId && !l.deleted_at)
    .map((l) => byId.get(l.version))
    .filter((v): v is NonNullable<typeof v> => v !== undefined);
  const open = candidates.filter((v) => !v.completed).sort((a, b) => compareVersions(a.number, b.number));
  if (open.length > 0) return open[0];
  return candidates.sort((a, b) => compareVersions(b.number, a.number))[0];
}

/** Pure form of resolveTaskHref. */
export function taskHrefFrom(
  task: Pick<Task, 'id' | 'project'>,
  links: readonly Pick<VersionTask, 'version' | 'task' | 'deleted_at'>[],
  versions: readonly Pick<Version, 'id' | 'number' | 'completed' | 'deleted_at'>[]
): string {
  const version = pickTaskVersion(task.id, links, versions);
  return version
    ? boardHref({ project: task.project, version: version.id, task: task.id })
    : taskEditHref(task.id);
}

/** Resolve a task id to the URL that opens it (reads IndexedDB). */
export async function resolveTaskHref(taskId: string): Promise<string> {
  const { get, byIndex, all } = await import('../db/repo');
  const task = await get<Task>('task', taskId);
  if (!task) return taskEditHref(taskId);
  const [links, versions] = await Promise.all([
    byIndex<VersionTask>('version_task', 'task', taskId),
    all<Version>('version'),
  ]);
  return taskHrefFrom(task, links, versions);
}

export function projectHref(projectId: string): string {
  return boardHref({ project: projectId });
}

export function versionHref(version: Pick<Version, 'id' | 'project'>): string {
  return boardHref({ project: version.project, version: version.id });
}

/**
 * The board context for prefilling "New Task"/"New Version": the selection in
 * the current URL when on the board, else the last remembered selection.
 */
export function currentBoardContext(): { project: string | null; version: string | null } {
  try {
    const params = new URLSearchParams(location.search);
    const project = params.get('project');
    if (project) return { project, version: params.get('version') };
  } catch {
    // no location (SSR) — fall through
  }
  try {
    const last = JSON.parse(localStorage.getItem(BOARD_LAST_KEY) ?? 'null') as {
      project?: string;
      version?: string;
    } | null;
    if (last?.project) return { project: last.project, version: last.version ?? null };
  } catch {
    // storage blocked or corrupt
  }
  return { project: null, version: null };
}
