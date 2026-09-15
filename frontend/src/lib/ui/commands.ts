/**
 * App-wide UI commands, decoupled from the components that fulfil them.
 *
 * The FAB owns the "New Task / New Version / New Project" dialogs and the
 * command palette can trigger them; a window event keeps the two islands
 * independent (each page mounts separate client:only roots, so there is no
 * shared component tree to pass callbacks through).
 */

export type CreateKind = 'task' | 'version' | 'project';

export const OPEN_CREATE_EVENT = 'planee-open-create';
export const OPEN_PALETTE_EVENT = 'planee-open-palette';

export interface OpenCreateDetail {
  kind: CreateKind;
}

export function openCreate(kind: CreateKind): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<OpenCreateDetail>(OPEN_CREATE_EVENT, { detail: { kind } }));
}

export function openPalette(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(OPEN_PALETTE_EVENT));
}
