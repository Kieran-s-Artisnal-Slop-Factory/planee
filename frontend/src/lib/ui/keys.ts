/**
 * Key chords: how a keybind is written, matched against a KeyboardEvent, and
 * shown to a person. Shared by the app keymap (lib/ui/keymap.ts), the Ctrl
 * overlay, and the markdown editor's rebindable tool keys.
 *
 * A chord is written `Mod+Mod+Key` with modifiers in the fixed order
 * Ctrl, Alt, Shift, Meta — `Ctrl+Shift+1`, `Ctrl+ArrowUp`, `Shift+Tab`,
 * `PageDown`. Keys: A–Z, 0–9, F1–F12, and the named keys in NAMED_KEYS.
 *
 * Matching uses `event.code` first and `event.key` only as a fallback:
 * Shift+1 reports `key: '!'` and macOS Option rewrites letters (Alt+F is
 * `ƒ`), but the physical code says which key was hit whatever the layout and
 * modifiers do to it (ported from notey's shortcuts.ts). Every modifier is
 * compared, including the ones a chord does not want, so Ctrl+Shift+1 never
 * fires Ctrl+1's action.
 *
 * Pure: nothing here touches the DOM beyond the event fields it is handed.
 */

export const MODIFIERS = ['Ctrl', 'Alt', 'Shift', 'Meta'] as const;
export type Modifier = (typeof MODIFIERS)[number];

/** Non-character keys a chord may end in, spelled as `KeyboardEvent.key` spells them. */
export const NAMED_KEYS = [
  'Enter',
  'Tab',
  'Escape',
  'Space',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'PageUp',
  'PageDown',
  'Home',
  'End',
] as const;

export interface Chord {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  key: string;
}

const CHAR_KEY = /^(?:[A-Z0-9]|F[1-9]|F1[0-2])$/;

function normaliseKeyName(name: string): string | null {
  const upper = name.length === 1 ? name.toUpperCase() : name;
  if (CHAR_KEY.test(upper)) return upper;
  const named = NAMED_KEYS.find((k) => k.toLowerCase() === name.toLowerCase());
  return named ?? null;
}

/** `KeyF` → `F`, `Digit1`/`Numpad1` → `1`, `NumpadEnter` → `Enter`, `ArrowUp` → `ArrowUp`. */
export function keyNameOfCode(code: string): string | null {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1]!;
  const digit = /^(?:Digit|Numpad)([0-9])$/.exec(code);
  if (digit) return digit[1]!;
  if (/^F(?:[1-9]|1[0-2])$/.test(code)) return code;
  if (code === 'NumpadEnter') return 'Enter';
  return (NAMED_KEYS as readonly string[]).includes(code) ? code : null;
}

function keyNameOfKey(key: string): string | null {
  if (key === ' ') return 'Space';
  return normaliseKeyName(key);
}

/** The parts of a chord, or null when the text is not one. */
export function parseChord(text: unknown): Chord | null {
  if (typeof text !== 'string') return null;
  const parts = text
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean);
  const last = parts.pop();
  if (!last) return null;
  const key = normaliseKeyName(last);
  if (!key) return null;
  const chord: Chord = { ctrl: false, alt: false, shift: false, meta: false, key };
  for (const part of parts) {
    const found = MODIFIERS.find((m) => m.toLowerCase() === part.toLowerCase());
    if (!found) return null;
    if (found === 'Ctrl') chord.ctrl = true;
    if (found === 'Alt') chord.alt = true;
    if (found === 'Shift') chord.shift = true;
    if (found === 'Meta') chord.meta = true;
  }
  return chord;
}

export function formatChord(chord: Chord): string {
  const parts: string[] = [];
  if (chord.ctrl) parts.push('Ctrl');
  if (chord.alt) parts.push('Alt');
  if (chord.shift) parts.push('Shift');
  if (chord.meta) parts.push('Meta');
  parts.push(chord.key);
  return parts.join('+');
}

/** A chord tidied into its one spelling, or null if unusable. */
export function normaliseChord(text: unknown): string | null {
  const chord = parseChord(text);
  return chord ? formatChord(chord) : null;
}

/** Does this keypress ask for this chord? Every modifier must match exactly. */
export function matchesChord(event: KeyboardEvent, chordText: string): boolean {
  const wanted = parseChord(chordText);
  if (!wanted) return false;
  if (event.ctrlKey !== wanted.ctrl) return false;
  if (event.altKey !== wanted.alt) return false;
  if (event.shiftKey !== wanted.shift) return false;
  if (event.metaKey !== wanted.meta) return false;
  const byCode = keyNameOfCode(event.code ?? '');
  if (byCode) return byCode === wanted.key;
  return keyNameOfKey(event.key ?? '') === wanted.key;
}

/** The chord a keypress would make (for rebinding UIs), or null for a lone modifier. */
export function chordOf(event: KeyboardEvent): string | null {
  const key = keyNameOfCode(event.code ?? '') ?? keyNameOfKey(event.key ?? '');
  if (!key) return null;
  return formatChord({ ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey, meta: event.metaKey, key });
}

const GLYPHS: Record<string, string> = {
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  PageUp: 'PgUp',
  PageDown: 'PgDn',
  Escape: 'Esc',
  Enter: 'Enter',
  Meta: 'Cmd',
};

/** The chord as separate display parts, e.g. `['Ctrl', 'Shift', '1']`, `['Ctrl', '↑']`. */
export function chordParts(chordText: string): string[] {
  const chord = parseChord(chordText);
  if (!chord) return [chordText];
  return formatChord(chord)
    .split('+')
    .map((part) => GLYPHS[part] ?? part);
}

/** One-line display, e.g. `Ctrl+Shift+1`, `Ctrl+↑`. */
export function chordLabel(chordText: string): string {
  return chordParts(chordText).join('+');
}

/**
 * True when a keypress is going into something the user is typing in: a text
 * input, a textarea, a select, or a contenteditable surface (Milkdown's
 * canvas, CodeMirror's `.cm-content`).
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).closest !== 'function') return false;
  const el = target as HTMLElement;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = ((el as HTMLInputElement).type || 'text').toLowerCase();
    return !['button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'color', 'file', 'image'].includes(type);
  }
  return el.closest('[contenteditable=""], [contenteditable="true"], .cm-content, math-field') !== null;
}

/**
 * True when running as an installed app window (Chrome/Edge "Install app",
 * a PWA). Browsers reserve some chords (Ctrl+N, Firefox's Ctrl+Shift+P) in a
 * normal tab but hand them to an installed app, which is when a keybind's
 * primary chord can be shown instead of its fallback.
 */
export function isInstalledApp(): boolean {
  try {
    return (
      typeof matchMedia === 'function' &&
      (matchMedia('(display-mode: standalone)').matches ||
        matchMedia('(display-mode: window-controls-overlay)').matches ||
        matchMedia('(display-mode: minimal-ui)').matches)
    );
  } catch {
    return false;
  }
}
