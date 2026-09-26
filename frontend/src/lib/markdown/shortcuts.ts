/**
 * The editor's four tools, the keys that open them, and where those keys are
 * kept (D22).
 *
 * Everything on the editor toolbar is reachable without it: a formula, a
 * diagram, a drawing and a footnote each have a key, each appears in the
 * command palette while an editor is open, and each key can be changed in
 * Settings — per device, in localStorage, like the other things that are
 * about this keyboard rather than the synced data.
 *
 * Ported from notey src/lib/notebook/shortcuts.ts. Changed:
 *  - Matching and spelling delegate to the shared chord library
 *    (lib/ui/keys.ts), which reads `event.code` first for the same reason
 *    notey did: macOS Option turns Alt+F into `ƒ` and Alt+0 into `º`.
 *  - A tool can't take any app keybind (lib/ui/keymap.ts `appChords()`,
 *    fallbacks included) nor Ctrl/Cmd+S, which saves the markdown field.
 *    notey reserved only its palette key.
 *  - The keys live in localStorage[`planee-editor-shortcuts`] (notey kept
 *    them in its preferences file); `saveShortcuts` announces a change on
 *    `window` so an open editor and the palette pick it up at once.
 */
import { appChords, KEYMAP } from '../ui/keymap';
import { chordLabel, chordOf, matchesChord, normaliseChord, parseChord } from '../ui/keys';

export type ToolId = 'formula' | 'drawing' | 'diagram' | 'footnotes';

export interface Tool {
  id: ToolId;
  /** On the toolbar button. */
  glyph: string;
  label: string;
  /** The row in the command palette. */
  command: string;
  /** What that row says about it. */
  hint: string;
}

/** Toolbar order, palette order, Settings order — one list, so they agree. */
export const TOOLS: readonly Tool[] = [
  { id: 'formula', glyph: '∑', label: 'Formula', command: 'Insert a formula', hint: 'maths, written as it looks' },
  { id: 'diagram', glyph: '◇', label: 'Diagram', command: 'Insert a diagram', hint: 'mermaid, with templates' },
  { id: 'drawing', glyph: '✏', label: 'Draw', command: 'Insert a drawing', hint: 'an Excalidraw canvas' },
  { id: 'footnotes', glyph: '⁋', label: 'Footnotes', command: 'Insert a footnote', hint: 'cites at the cursor' },
];

export type Shortcuts = Record<ToolId, string>;

/**
 * Alt and the initial, except for footnotes, which had Alt+0 before any of
 * this and keeps it. (Alt+D would have been the drawing's initial and is the
 * browser's own address-bar key on Windows, so drawings get Alt+E.)
 */
export const DEFAULT_SHORTCUTS: Shortcuts = {
  formula: 'Alt+F',
  diagram: 'Alt+M',
  drawing: 'Alt+E',
  footnotes: 'Alt+0',
};

/** Where this device keeps its choices. */
export const SHORTCUTS_KEY = 'planee-editor-shortcuts';
/** Dispatched on `window` (detail: the new Shortcuts) when they change. */
export const SHORTCUTS_EVENT = 'planee-editor-shortcuts';

/** `A`–`Z`, `0`–`9`, `F1`–`F12`: what a tool key may end in. */
const KEY_NAME = /^(?:[A-Z0-9]|F[1-9]|F1[0-2])$/;

/** A chord a tool can use: a letter, digit or F-key, with Ctrl, Alt or Meta. */
function usable(chord: string | null): chord is string {
  const parsed = chord ? parseChord(chord) : null;
  if (!parsed || !KEY_NAME.test(parsed.key)) return false;
  // Shift alone is not enough: a tool bound to Shift+F would open while you
  // typed a capital F.
  return parsed.ctrl || parsed.alt || parsed.meta;
}

/**
 * The keys the app keeps for itself, with what they do: every chord in
 * lib/ui/keymap.ts (primary and fallback) and the markdown field's
 * Ctrl/Cmd+S. Rebinding a tool onto one would take it away wherever the
 * editor has focus, which is most of the time.
 */
export function reservedChords(): Map<string, string> {
  const reserved = new Map<string, string>([
    ['Ctrl+S', 'Save'],
    ['Meta+S', 'Save'],
  ]);
  for (const chord of appChords()) {
    const tidy = normaliseChord(chord);
    if (!tidy || reserved.has(tidy)) continue;
    const owner = KEYMAP.find(
      (k) => k.keys.some((key) => normaliseChord(key) === tidy) || normaliseChord(k.fallback) === tidy
    );
    reserved.set(tidy, owner?.label ?? 'another shortcut');
  }
  return reserved;
}

/**
 * The bind a keypress would set, or null if it could not be one: a modifier
 * on its own (nothing to bind yet), a plain or Shift-only key, or anything
 * that is not a letter, a digit or a function key.
 */
export function bindOf(event: KeyboardEvent): string | null {
  if (!event.altKey && !event.ctrlKey && !event.metaKey) return null;
  const chord = chordOf(event);
  return usable(chord) ? chord : null;
}

/** Read a stored or typed bind, tidied into the one spelling. Null if unusable. */
export function parseBind(text: unknown): string | null {
  const tidy = normaliseChord(text);
  return usable(tidy) ? tidy : null;
}

/** Does this keypress ask for this bind? Every modifier must match. */
export function matches(event: KeyboardEvent, bind: string): boolean {
  return bind !== '' && matchesChord(event, bind);
}

/** Which tool a keypress opens, or null. */
export function toolFor(event: KeyboardEvent, shortcuts: Shortcuts): ToolId | null {
  for (const tool of TOOLS) {
    if (matches(event, shortcuts[tool.id])) return tool.id;
  }
  return null;
}

/** The key as a person reads it (`Alt+F`, `Cmd+E`), or '' when there is none. */
export function shortcutLabel(bind: string): string {
  return bind ? chordLabel(bind) : '';
}

/** Why `bind` cannot be given to `id`, in one line for a person, or null when it can. */
export function bindRefusal(bind: string, id: ToolId, shortcuts: Shortcuts): string | null {
  const tidy = parseBind(bind);
  if (!tidy) return 'That needs Ctrl, Alt or Cmd and a letter, a digit or an F-key.';
  const reserved = reservedChords().get(tidy);
  if (reserved) return `${chordLabel(tidy)} is taken by ${reserved}.`;
  const taken = TOOLS.find((tool) => tool.id !== id && parseBind(shortcuts[tool.id]) === tidy);
  return taken ? `${chordLabel(tidy)} already opens ${taken.label.toLowerCase()}.` : null;
}

/**
 * Stored values into a usable set: anything missing, unreadable, reserved or
 * clashing falls back to the default for that tool, so a hand-edited value
 * can never leave a tool unreachable (and a default that has since become
 * an app key is dropped rather than fought over).
 */
export function readShortcuts(value: unknown): Shortcuts {
  const stored = (value && typeof value === 'object' ? value : {}) as Partial<Record<ToolId, unknown>>;
  const reserved = reservedChords();
  const out = { ...DEFAULT_SHORTCUTS };
  const used = new Set<string>();
  for (const tool of TOOLS) {
    const wanted = parseBind(stored[tool.id]);
    if (wanted && !reserved.has(wanted) && !used.has(wanted)) {
      out[tool.id] = wanted;
      used.add(wanted);
      continue;
    }
    // The default is only safe if nobody else has taken it.
    const fallback = DEFAULT_SHORTCUTS[tool.id];
    out[tool.id] = used.has(fallback) || reserved.has(fallback) ? '' : fallback;
    if (out[tool.id]) used.add(out[tool.id]);
  }
  return out;
}

/** This device's keys. Never throws: blocked storage means the defaults. */
export function loadShortcuts(): Shortcuts {
  try {
    const raw = localStorage.getItem(SHORTCUTS_KEY);
    return readShortcuts(raw ? JSON.parse(raw) : undefined);
  } catch {
    return readShortcuts(undefined);
  }
}

function announce(next: Shortcuts): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<Shortcuts>(SHORTCUTS_EVENT, { detail: next }));
}

/** Keep `next` (tidied) for this device and tell anything listening. */
export function saveShortcuts(next: Shortcuts): Shortcuts {
  const tidy = readShortcuts(next);
  try {
    localStorage.setItem(SHORTCUTS_KEY, JSON.stringify(tidy));
  } catch {
    // Storage blocked: the change lasts as long as the page.
  }
  announce(tidy);
  return tidy;
}

/** Back to the defaults. */
export function resetShortcuts(): Shortcuts {
  try {
    localStorage.removeItem(SHORTCUTS_KEY);
  } catch {
    // Storage blocked: nothing was kept anyway.
  }
  const next = readShortcuts(undefined);
  announce(next);
  return next;
}

/**
 * Call `listener` with the keys whenever they change — on this page
 * (`saveShortcuts`) or in another tab (the `storage` event). Returns the
 * unsubscribe.
 */
export function onShortcutsChange(listener: (next: Shortcuts) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const local = (event: Event) => listener((event as CustomEvent<Shortcuts>).detail ?? loadShortcuts());
  const other = (event: StorageEvent) => {
    if (event.key === SHORTCUTS_KEY || event.key === null) listener(loadShortcuts());
  };
  window.addEventListener(SHORTCUTS_EVENT, local);
  window.addEventListener('storage', other);
  return () => {
    window.removeEventListener(SHORTCUTS_EVENT, local);
    window.removeEventListener('storage', other);
  };
}
