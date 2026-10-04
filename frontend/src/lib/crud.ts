/**
 * Small pure helpers shared by the generated CRUD pages.
 */
import type { Project, Task } from './db/types';
import { PRIORITY_VALUES } from './db/types';

/** A project's display label: its name, or its description for unnamed (pre-v3) projects. */
export function projectLabel(project: Pick<Project, 'name' | 'description'> | undefined): string {
  if (!project) return '';
  return (project.name ?? '').trim() || project.description || '';
}

/** A task's display label: its title, or its description for untitled (pre-v3) tasks. */
export function taskLabel(task: Pick<Task, 'title' | 'description'> | undefined): string {
  if (!task) return '';
  return (task.title ?? '').trim() || task.description || '';
}

/** "Urgent" for 1 … "Low" for 4; anything else is shown as the raw number. */
export function priorityLabel(priority: number): string {
  return PRIORITY_VALUES.find((p) => p.value === priority)?.label ?? String(priority);
}

/**
 * The subset of `values` that differs from `original` (by strict equality).
 *
 * An edit form should patch only what the user changed. patch() stamps every
 * field it is given, so saving an untouched field would give it a fresh stamp
 * and silently beat a concurrent edit to that same field on another device.
 */
export function changedFields<T extends object>(original: T, values: T): Partial<T> {
  const out: Partial<T> = {};
  for (const key of Object.keys(values) as (keyof T)[]) {
    if (!Object.is(original[key], values[key])) out[key] = values[key];
  }
  return out;
}
