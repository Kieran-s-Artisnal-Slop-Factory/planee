/**
 * App-wide UI commands, decoupled from the components that fulfil them.
 *
 * The FAB owns the "New Task / New Version / New Project" dialogs and the
 * command palette can trigger them; a window event keeps the two islands
 * independent (each page mounts separate client:only roots, so there is no
 * shared component tree to pass callbacks through).
 */
import type { StatusTypeKey } from '../db/types';

export type CreateKind = 'task' | 'version' | 'project';

export const OPEN_CREATE_EVENT = 'planee-open-create';
export const OPEN_PALETTE_EVENT = 'planee-open-palette';
export const OPEN_FAB_EVENT = 'planee-open-fab';

/**
 * What a create dialog starts from, instead of the board context the FAB
 * would read itself (links.ts currentBoardContext). The board's Ctrl+1/2/3
 * pass the column's status plus the board's project and version (D26).
 */
export interface CreatePrefill {
  /** New Task: the status of the link(s) it creates. */
  status?: StatusTypeKey;
  project?: string | null;
  version?: string | null;
}

export interface OpenCreateDetail {
  kind: CreateKind;
  prefill?: CreatePrefill;
}

export function openCreate(kind: CreateKind, prefill?: CreatePrefill): void {
  if (typeof window === 'undefined') return;
  const detail: OpenCreateDetail = prefill ? { kind, prefill } : { kind };
  window.dispatchEvent(new CustomEvent<OpenCreateDetail>(OPEN_CREATE_EVENT, { detail }));
}

export function openPalette(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(OPEN_PALETTE_EVENT));
}

/** Open the FAB's "+" menu with its first item focused (Ctrl+Enter). */
export function openFab(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(OPEN_FAB_EVENT));
}

/* ── Markdown editor tools (10c-E, D22) ─────────────────────────────── */

/**
 * The markdown editor's tools, as the palette names them. The same ids as
 * lib/markdown/shortcuts.ts `ToolId`, restated here so this module stays
 * free of the editor's imports.
 */
export type EditorToolId = 'formula' | 'diagram' | 'drawing' | 'footnotes';

export const OPEN_EDITOR_TOOL_EVENT = 'planee-open-editor-tool';

export interface OpenEditorToolDetail {
  tool: EditorToolId;
}

/** One mounted MarkdownEditor, as the palette sees it. */
export interface EditorHandle {
  /** False in Preview, where there is nothing to insert into. */
  canInsert(): boolean;
}

/**
 * Every mounted editor, least recently focused first. Module state is shared
 * by every island on a page (one module instance per page), which is what
 * lets the palette — its own island in Layout — see the board's editors.
 */
const editors: EditorHandle[] = [];

/** Called by a MarkdownEditor on mount; returns the unregister for its destroy. */
export function registerEditor(handle: EditorHandle): () => void {
  editors.push(handle);
  return () => {
    const at = editors.indexOf(handle);
    if (at !== -1) editors.splice(at, 1);
  };
}

/** Called when an editor takes focus: the most recently focused one gets palette tools. */
export function touchEditor(handle: EditorHandle): void {
  const at = editors.indexOf(handle);
  if (at === -1 || at === editors.length - 1) return;
  editors.splice(at, 1);
  editors.push(handle);
}

/** The editor a palette tool row would open in: the most recently focused one. */
export function activeEditor(): EditorHandle | null {
  return editors[editors.length - 1] ?? null;
}

/** Whether the palette should offer the editor tools right now. */
export function canOpenEditorTool(): boolean {
  return activeEditor()?.canInsert() ?? false;
}

/** Ask the active editor to open `tool`; editors listen for OPEN_EDITOR_TOOL_EVENT. */
export function openEditorTool(tool: EditorToolId): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<OpenEditorToolDetail>(OPEN_EDITOR_TOOL_EVENT, { detail: { tool } }));
}
