import { describe, expect, it } from 'vitest';
import type { Project, Task, Version, VersionTask } from '../db/types';
import {
  activityLabel,
  createdAtOf,
  looksUnedited,
  recentIssues,
  recentIssuesCount,
  relativeTime,
  statusLabel,
} from './recentIssues';

const T0 = Date.parse('2026-09-01T12:00:00.000Z');
const at = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();
const MIN = 60_000;

const sync = (id: string, updated_at: string) => ({ id, updated_at, deleted_at: null, server_seq: null });

const project = (id: string, name = id, deleted_at: string | null = null): Project => ({
  ...sync(id, at(0)),
  name,
  description: '',
  deleted_at,
});

const version = (id: string, number: string, completed = false, projectId = 'p'): Version => ({
  ...sync(id, at(0)),
  number,
  project: projectId,
  description: null,
  completed,
});

/** A task created at `created` (every field stamped then) and last written at `updated`. */
const task = (id: string, created: number, updated = created, extra: Partial<Task> = {}): Task => ({
  ...sync(id, at(updated)),
  project: 'p',
  title: id.toUpperCase(),
  task_type: 'feature',
  description: null,
  priority: 4,
  subtasks: null,
  field_updated_at: {
    project: at(created),
    title: at(updated),
    task_type: at(created),
    description: at(created),
    priority: at(created),
    subtasks: at(created),
    deleted_at: at(created),
  },
  ...extra,
});

const link = (id: string, versionId: string, taskId: string, status: VersionTask['status'] = 'todo'): VersionTask => ({
  ...sync(id, at(0)),
  version: versionId,
  task: taskId,
  status,
  position: 0,
});

const base = {
  projects: [project('p', 'Planee')],
  versions: [version('v1', '0.1.0', true), version('v2', '0.2.0')],
  links: [] as VersionTask[],
  views: [],
  limit: 6,
};

describe('createdAtOf / looksUnedited', () => {
  it('uses the oldest field stamp', () => {
    expect(createdAtOf(task('a', 0, 5 * MIN))).toBe(at(0));
  });

  it('falls back to updated_at when there are no stamps', () => {
    const row = task('a', 0, 5 * MIN, { field_updated_at: {} });
    expect(createdAtOf(row)).toBe(at(5 * MIN));
    expect(looksUnedited(row)).toBe(true);
    expect(looksUnedited(task('a', 0, 5 * MIN, { field_updated_at: undefined }))).toBe(true);
  });

  it('allows a second of slack between creation and the last write', () => {
    expect(looksUnedited(task('a', 0, 900))).toBe(true);
    expect(looksUnedited(task('a', 0, 1001))).toBe(false);
  });
});

describe('recentIssues', () => {
  it('labels added, updated and viewed and sorts by activity', () => {
    const items = recentIssues({
      ...base,
      tasks: [task('added', 10 * MIN), task('updated', 0, 20 * MIN), task('viewed', 0)],
      views: [{ id: 'viewed', at: at(30 * MIN) }],
    });
    expect(items.map((i) => [i.taskId, i.reason])).toEqual([
      ['viewed', 'viewed'],
      ['updated', 'updated'],
      ['added', 'added'],
    ]);
    expect(items[0]!.activityAt).toBe(at(30 * MIN));
  });

  it('a status change on a link (drag, resolution, bump) counts as an update; a reorder does not', () => {
    const moved = { ...link('l1', 'v2', 'moved', 'done'), field_updated_at: { status: at(40 * MIN), position: at(40 * MIN) } };
    const reordered = {
      ...link('l2', 'v2', 'reordered'),
      updated_at: at(50 * MIN),
      field_updated_at: { status: at(0), position: at(50 * MIN) },
    };
    const items = recentIssues({
      ...base,
      tasks: [task('moved', 0), task('reordered', 5 * MIN)],
      links: [moved, reordered],
    });
    expect(items.map((i) => [i.taskId, i.reason, i.activityAt])).toEqual([
      ['moved', 'updated', at(40 * MIN)],
      ['reordered', 'added', at(5 * MIN)],
    ]);
  });

  it('a link created with its task does not make the task read as updated', () => {
    const created = { ...link('l1', 'v2', 'a'), field_updated_at: { status: at(10 * MIN + 200) } };
    const [item] = recentIssues({ ...base, tasks: [task('a', 10 * MIN)], links: [created] });
    expect(item!.reason).toBe('added');
  });

  it('an edit after the view wins over the view', () => {
    const [item] = recentIssues({
      ...base,
      tasks: [task('a', 0, 20 * MIN)],
      views: [{ id: 'a', at: at(10 * MIN) }],
    });
    expect(item!.reason).toBe('updated');
    expect(item!.activityAt).toBe(at(20 * MIN));
  });

  it('a view older than an unedited creation still reads as added', () => {
    const [item] = recentIssues({
      ...base,
      tasks: [task('a', 20 * MIN)],
      views: [{ id: 'a', at: at(10 * MIN) }],
    });
    expect(item!.reason).toBe('added');
  });

  it('takes the newest view when a task appears twice in the history', () => {
    const [item] = recentIssues({
      ...base,
      tasks: [task('a', 0)],
      views: [
        { id: 'a', at: at(5 * MIN) },
        { id: 'a', at: at(9 * MIN) },
      ],
    });
    expect(item!.activityAt).toBe(at(9 * MIN));
  });

  it('respects the limit, and 0 shows nothing', () => {
    const tasks = Array.from({ length: 10 }, (_, i) => task(`t${i}`, i * MIN));
    expect(recentIssues({ ...base, tasks, limit: 6 }).map((i) => i.taskId)).toEqual([
      't9',
      't8',
      't7',
      't6',
      't5',
      't4',
    ]);
    expect(recentIssues({ ...base, tasks, limit: 0 })).toEqual([]);
  });

  it('skips deleted tasks and tasks of deleted or missing projects, across projects', () => {
    const items = recentIssues({
      ...base,
      projects: [project('p', 'Planee'), project('q', 'Other'), project('gone', 'Gone', at(0))],
      tasks: [
        task('a', 0),
        task('b', MIN, MIN, { project: 'q' }),
        task('c', 2 * MIN, 2 * MIN, { deleted_at: at(3 * MIN) }),
        task('d', 3 * MIN, 3 * MIN, { project: 'gone' }),
        task('e', 4 * MIN, 4 * MIN, { project: 'nowhere' }),
      ],
    });
    expect(items.map((i) => [i.taskId, i.projectName])).toEqual([
      ['b', 'Other'],
      ['a', 'Planee'],
    ]);
  });

  it('shows the version the card opens in, with that link status', () => {
    const items = recentIssues({
      ...base,
      tasks: [task('a', 0), task('b', MIN), task('c', 2 * MIN, 2 * MIN, { title: '  ' })],
      links: [
        link('l1', 'v1', 'a', 'bumped'),
        link('l2', 'v2', 'a', 'in_progress'),
        link('l3', 'v1', 'b', 'wontfix'),
      ],
    });
    const byId = Object.fromEntries(items.map((i) => [i.taskId, i]));
    expect(byId.a!.version).toEqual({ id: 'v2', number: '0.2.0', completed: false });
    expect(byId.a!.status).toBe('in_progress');
    expect(byId.b!.version?.completed).toBe(true);
    expect(byId.b!.status).toBe('wontfix');
    expect(byId.c!.version).toBeUndefined();
    expect(byId.c!.status).toBeUndefined();
    expect(byId.c!.title).toBe('Untitled');
  });
});

describe('labels', () => {
  const narrow = new Intl.RelativeTimeFormat('en', { numeric: 'auto', style: 'narrow' });
  const now = T0 + 10 * 24 * 3600_000;
  const ago = (msAgo: number) => new Date(now - msAgo).toISOString();

  it('picks the largest whole unit', () => {
    expect(relativeTime(ago(30_000), now, 'en')).toBe('just now');
    expect(relativeTime(ago(-60_000), now, 'en')).toBe('just now');
    expect(relativeTime(ago(5 * MIN), now, 'en')).toBe(narrow.format(-5, 'minute'));
    expect(relativeTime(ago(2 * 3600_000 + 5 * MIN), now, 'en')).toBe(narrow.format(-2, 'hour'));
    expect(relativeTime(ago(30 * 3600_000), now, 'en')).toBe('yesterday');
    expect(relativeTime(ago(8 * 24 * 3600_000), now, 'en')).toBe(narrow.format(-1, 'week'));
  });

  it('prefixes the reason', () => {
    expect(activityLabel({ reason: 'added', activityAt: ago(30 * 3600_000) }, now, 'en')).toBe('Added yesterday');
    expect(activityLabel({ reason: 'viewed', activityAt: ago(1000) }, now, 'en')).toBe('Viewed just now');
    expect(activityLabel({ reason: 'updated', activityAt: ago(5 * MIN) }, now, 'en')).toBe(
      `Updated ${narrow.format(-5, 'minute')}`
    );
  });

  it('names statuses the way the board does', () => {
    expect(statusLabel('todo')).toBe('TODO');
    expect(statusLabel('in_progress')).toBe('In Progress');
    expect(statusLabel('wontfix')).toBe("Won't fix");
  });

  it('normalises the preference', () => {
    expect(recentIssuesCount(undefined, 6)).toBe(6);
    expect(recentIssuesCount('3', 6)).toBe(6);
    expect(recentIssuesCount(-1, 6)).toBe(6);
    expect(recentIssuesCount(0, 6)).toBe(0);
    expect(recentIssuesCount(12, 6)).toBe(12);
  });
});
