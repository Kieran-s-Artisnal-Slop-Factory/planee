/**
 * Board operations, executed through repo.ts. Each one re-reads the rows it
 * needs FRESH (never trusting the board's snapshot), asks adapter.ts what to
 * write, and writes it: `put(withSyncFields(...))` for new rows, `patch` with
 * only the changed fields for existing ones, `softDelete` for removals.
 *
 * Every function throws when the thing it was asked to change is gone (deleted
 * on another device), so KanbanBoard shows the card as failed with Retry/Undo
 * instead of quietly doing nothing.
 */
import {
  all,
  byIndex,
  get,
  getSingleton,
  patch,
  put,
  softDelete,
  withSyncFields,
} from '../db/repo';
import type {
  Preferences,
  Project,
  StatusTypeKey,
  SyncFields,
  Task,
  Version,
  VersionTask,
} from '../db/types';
import type { CardRecord } from '../kanban/types';
import {
  planBumpMany,
  planComplete,
  planCreate,
  planDelete,
  splitPatch,
  toCards,
  topPosition,
  type BoardCard,
  type BumpPlan,
  type TaskChanges,
} from './adapter';

/** The first version a new project gets. */
export const FIRST_VERSION_NUMBER = '0.1.0';

class GoneError extends Error {
  constructor(what: string) {
    super(`This ${what} was deleted — reload to see the current board.`);
  }
}

async function mustGet<T extends SyncFields>(store: string, id: string, what: string): Promise<T> {
  const row = await get<T>(store, id);
  if (!row) throw new GoneError(what);
  return row;
}

async function mustPatch<T extends SyncFields>(
  store: string,
  id: string,
  changes: Partial<Omit<T, keyof SyncFields>>,
  what: string
): Promise<T> {
  const row = await patch<T>(store, id, changes);
  if (!row) throw new GoneError(what);
  return row;
}

// ─── Projects and versions ──────────────────────────────────────────────────

/** A new project, with its first version (0.1.0) so the board has somewhere to start. */
export async function createProject(name: string): Promise<{ project: Project; version: Version }> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('A project needs a name.');
  const project = await put<Project>('project', withSyncFields({ name: trimmed, description: '' }));
  const version = await createVersion(project.id, FIRST_VERSION_NUMBER);
  return { project, version };
}

export async function createVersion(projectId: string, number: string): Promise<Version> {
  const trimmed = number.trim();
  if (!trimmed) throw new Error('A version needs a number.');
  return put<Version>(
    'version',
    withSyncFields<Omit<Version, keyof SyncFields>>({
      number: trimmed,
      project: projectId,
      description: null,
      completed: false,
    })
  );
}

export function reopenVersion(versionId: string): Promise<Version> {
  return mustPatch<Version>('version', versionId, { completed: false }, 'version');
}

export function patchVersion(
  versionId: string,
  changes: Partial<Pick<Version, 'description' | 'number'>>
): Promise<Version> {
  return mustPatch<Version>('version', versionId, changes, 'version');
}

export function patchTask(taskId: string, changes: TaskChanges): Promise<Task> {
  return mustPatch<Task>('task', taskId, changes, 'task');
}

/** Every live link of every version of a project. */
async function projectLinks(versions: readonly Version[]): Promise<VersionTask[]> {
  const lists = await Promise.all(versions.map((v) => byIndex<VersionTask>('version_task', 'version', v.id)));
  return lists.flat();
}

// ─── Cards ──────────────────────────────────────────────────────────────────

export interface CardContext {
  projectId: string;
  versionId: string;
}

/**
 * KanbanBoard's onCreate: a task, then its link. Returns the stored card so
 * the board adopts it straight away.
 */
export async function createCard(draft: CardRecord, ctx: CardContext): Promise<BoardCard> {
  const version = await mustGet<Version>('version', ctx.versionId, 'version');
  if (version.completed) throw new Error('This version is complete — reopen it to add cards.');
  const [prefs, links] = await Promise.all([
    getSingleton<Preferences>('preferences'),
    byIndex<VersionTask>('version_task', 'version', ctx.versionId),
  ]);
  const plan = planCreate(draft, { ...ctx, defaultTaskType: prefs?.default_task_type, links });
  const task = await put<Task>('task', withSyncFields(plan.task));
  const link = await put<VersionTask>('version_task', withSyncFields({ ...plan.link, task: task.id }));
  return toCards([link], [task])[0]!;
}

/**
 * KanbanBoard's onUpdate: status/position patch the link, everything else
 * patches the task. A side with nothing in it is not written at all.
 */
export async function updateCard(linkId: string, cardPatch: CardRecord): Promise<void> {
  const { link, task } = splitPatch(cardPatch);
  const current = await mustGet<VersionTask>('version_task', linkId, 'card');
  if (Object.keys(link).length > 0) await mustPatch<VersionTask>('version_task', linkId, link, 'card');
  if (Object.keys(task).length > 0) await mustPatch<Task>('task', current.task, task, 'task');
}

/** KanbanBoard's onDelete: the link, and the task when nothing else schedules it. */
export async function deleteCard(linkId: string): Promise<void> {
  const link = await get<VersionTask>('version_task', linkId);
  if (!link) return; // already gone: the delete the reader asked for has happened
  const taskLinks = await byIndex<VersionTask>('version_task', 'task', link.task);
  const plan = planDelete(linkId, [link, ...taskLinks.filter((l) => l.id !== linkId)]);
  await softDelete('version_task', plan.deleteLink);
  if (plan.deleteTask && plan.taskId) await softDelete('task', plan.taskId);
}

/** Schedule an unscheduled task in a version, at the top of TODO. */
export async function addTaskToVersion(taskId: string, versionId: string): Promise<VersionTask> {
  await mustGet<Task>('task', taskId, 'task');
  const links = await byIndex<VersionTask>('version_task', 'version', versionId);
  const existing = links.find((l) => l.task === taskId);
  if (existing) return existing;
  return put<VersionTask>(
    'version_task',
    withSyncFields({ version: versionId, task: taskId, status: 'todo' as const, position: topPosition(links, 'todo') })
  );
}

// ─── Bump (D1), resolution (D2), complete (D5) ──────────────────────────────

/**
 * Asked for the number when a bump has to create the next version. Return the
 * number to use, or null to cancel the whole operation.
 */
export type ChooseNumber = (suggested: string) => string | null | Promise<string | null>;

async function executeBump(plan: BumpPlan, from: Version, chooseNumber?: ChooseNumber): Promise<Version | null> {
  let target: Version;
  if ('version' in plan.target) {
    target = plan.target.version;
  } else {
    const number = chooseNumber ? await chooseNumber(plan.target.create) : plan.target.create;
    if (number === null || number.trim() === '') return null;
    target = await createVersion(from.project, number);
  }
  for (const item of plan.items) {
    await mustPatch<VersionTask>('version_task', item.oldLinkId, plan.patchOld, 'card');
    if (item.reuseLinkId) {
      await mustPatch<VersionTask>(
        'version_task',
        item.reuseLinkId,
        { status: item.newLink.status, position: item.newLink.position },
        'card'
      );
    } else {
      await put<VersionTask>('version_task', withSyncFields({ ...item.newLink, version: target.id }));
    }
  }
  return target;
}

async function bumpContext(versionId: string) {
  const from = await mustGet<Version>('version', versionId, 'version');
  const versions = await byIndex<Version>('version', 'project', from.project);
  const links = await projectLinks(versions);
  return { from, versions, links };
}

/**
 * D1: mark the link `bumped` and schedule its task as TODO in the next
 * incomplete version — creating that version (numbered by `chooseNumber`, or
 * the suggestion) when there isn't one. Returns the target, or null when
 * `chooseNumber` cancelled.
 */
export async function bumpLink(linkId: string, chooseNumber?: ChooseNumber): Promise<Version | null> {
  const link = await mustGet<VersionTask>('version_task', linkId, 'card');
  const { from, versions, links } = await bumpContext(link.version);
  return executeBump(planBumpMany([link], from, versions, links), from, chooseNumber);
}

/**
 * D2: switch a Done card between the resolutions. `bumped` is a bump (it has
 * to schedule the task somewhere); every other status is a plain patch.
 */
export async function setResolution(
  linkId: string,
  status: StatusTypeKey,
  chooseNumber?: ChooseNumber
): Promise<void> {
  if (status === 'bumped') {
    await bumpLink(linkId, chooseNumber);
    return;
  }
  await mustPatch<VersionTask>('version_task', linkId, { status }, 'card');
}

/**
 * D5: mark a version complete. With `bumpOpen`, its todo/in-progress links are
 * bumped to the next version first (created when needed). Returns false when
 * `chooseNumber` cancelled, in which case nothing was written.
 */
export async function completeVersion(
  versionId: string,
  { bumpOpen = false, chooseNumber }: { bumpOpen?: boolean; chooseNumber?: ChooseNumber } = {}
): Promise<boolean> {
  if (bumpOpen) {
    const { from, versions, links } = await bumpContext(versionId);
    const { openLinks } = planComplete(from, links, versions);
    if (openLinks.length > 0) {
      const target = await executeBump(planBumpMany(openLinks, from, versions, links), from, chooseNumber);
      if (!target) return false;
    }
  }
  await mustPatch<Version>('version', versionId, { completed: true }, 'version');
  return true;
}

// ─── Reads the board page shares ────────────────────────────────────────────

export interface ProjectData {
  project: Project;
  versions: Version[];
  tasks: Task[];
  /** Live links in any live version of the project. */
  links: VersionTask[];
}

export async function loadProjectData(projectId: string): Promise<ProjectData | null> {
  const project = await get<Project>('project', projectId);
  if (!project) return null;
  const [versions, tasks] = await Promise.all([
    byIndex<Version>('version', 'project', projectId),
    byIndex<Task>('task', 'project', projectId),
  ]);
  return { project, versions, tasks, links: await projectLinks(versions) };
}

export const loadProjects = () => all<Project>('project');
