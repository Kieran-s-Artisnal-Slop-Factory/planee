/**
 * Every app-level keybind, as data (D21–D27). One list feeds the handlers,
 * the Ctrl-hold overlay (badges + cheat sheet), and the markdown editor's
 * RESERVED set — so a rebindable editor tool can never be put on a key the
 * app already uses.
 *
 * Scopes:
 *   global — every page (except where a page opts out, e.g. onboarding)
 *   home   — the board on `/`, when no dialog is open and focus isn't in a
 *            text field
 *   card   — while a board card has keyboard focus
 *
 * `fallback` is a second chord for keys a browser keeps for itself in a
 * normal tab (Ctrl+N opens a window everywhere; Firefox keeps Ctrl+Shift+P
 * for a private window). Both chords always work where the browser allows;
 * the overlay shows the fallback unless the app runs as an installed window
 * (lib/ui/keys.ts isInstalledApp).
 *
 * `whileTyping`: whether the chord still fires when focus is in a text field
 * or editor. Ctrl+Shift+V stays paste-as-plain-text there (D24).
 */

export type KeyScope = 'global' | 'home' | 'card';

export interface Keybind {
  id: string;
  scope: KeyScope;
  /** Primary chords (lib/ui/keys.ts spelling). */
  keys: readonly string[];
  /** Works in any browser tab; shown instead of keys[0] outside an installed app. */
  fallback?: string;
  label: string;
  whileTyping?: boolean;
}

export const KEYMAP: readonly Keybind[] = [
  // --- global
  { id: 'palette.open', scope: 'global', keys: ['Ctrl+K', 'Meta+K'], label: 'Command palette', whileTyping: true },
  { id: 'fab.open', scope: 'global', keys: ['Ctrl+Enter'], label: 'Open the + menu' },
  { id: 'create.task', scope: 'global', keys: ['Ctrl+N'], fallback: 'Alt+N', label: 'New task', whileTyping: true },
  {
    id: 'create.project',
    scope: 'global',
    keys: ['Ctrl+Shift+P'],
    fallback: 'Alt+Shift+P',
    label: 'New project',
    whileTyping: true,
  },
  { id: 'create.version', scope: 'global', keys: ['Ctrl+Shift+V'], label: 'New version' },

  // --- home (the board)
  { id: 'column.todo.new', scope: 'home', keys: ['Ctrl+1'], label: 'New task in TODO' },
  { id: 'column.todo.focus', scope: 'home', keys: ['Ctrl+Shift+1'], label: 'Focus first TODO card' },
  { id: 'column.in_progress.new', scope: 'home', keys: ['Ctrl+2'], label: 'New task in In Progress' },
  { id: 'column.in_progress.focus', scope: 'home', keys: ['Ctrl+Shift+2'], label: 'Focus first In Progress card' },
  { id: 'column.done.new', scope: 'home', keys: ['Ctrl+3'], label: 'New task in Done' },
  { id: 'column.done.focus', scope: 'home', keys: ['Ctrl+Shift+3'], label: 'Focus first Done card' },
  { id: 'board.project', scope: 'home', keys: ['Ctrl+4'], label: 'Choose project' },
  { id: 'version.complete', scope: 'home', keys: ['Ctrl+Shift+C'], label: 'Mark version complete' },
  { id: 'version.edit', scope: 'home', keys: ['Ctrl+Shift+E'], label: 'Edit version' },

  // --- a focused card
  { id: 'card.next', scope: 'card', keys: ['Tab', 'PageDown'], label: 'Next card' },
  { id: 'card.prev', scope: 'card', keys: ['Shift+Tab', 'PageUp'], label: 'Previous card' },
  { id: 'card.edit', scope: 'card', keys: ['Ctrl+E'], label: 'Edit card' },
  { id: 'card.up', scope: 'card', keys: ['Ctrl+ArrowUp'], label: 'Move card up' },
  { id: 'card.down', scope: 'card', keys: ['Ctrl+ArrowDown'], label: 'Move card down' },
  { id: 'card.left', scope: 'card', keys: ['Ctrl+ArrowLeft'], label: 'Move card to the previous column' },
  { id: 'card.right', scope: 'card', keys: ['Ctrl+ArrowRight'], label: 'Move card to the next column' },
];

export function keybind(id: string): Keybind {
  const found = KEYMAP.find((k) => k.id === id);
  if (!found) throw new Error('No keybind ' + id);
  return found;
}

/** Every chord the app itself uses, for editor-tool rebinding refusals. */
export function appChords(): string[] {
  return KEYMAP.flatMap((k) => [...k.keys, ...(k.fallback ? [k.fallback] : [])]);
}
