// Ported from notey src/lib/notebook/shortcuts.test.ts; the reserved keys are
// planee's (every app keybind in lib/ui/keymap.ts, plus Ctrl/Cmd+S), and the
// per-device storage is new.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appChords } from '../ui/keymap';
import { normaliseChord } from '../ui/keys';
import {
  DEFAULT_SHORTCUTS,
  SHORTCUTS_EVENT,
  SHORTCUTS_KEY,
  TOOLS,
  bindOf,
  bindRefusal,
  loadShortcuts,
  matches,
  onShortcutsChange,
  parseBind,
  readShortcuts,
  reservedChords,
  resetShortcuts,
  saveShortcuts,
  toolFor,
} from './shortcuts';

/** Just the fields the rules read, so no DOM is needed. */
const press = (over: Partial<KeyboardEvent>): KeyboardEvent =>
  ({
    code: '',
    key: '',
    altKey: false,
    ctrlKey: false,
    shiftKey: false,
    metaKey: false,
    ...over,
  }) as KeyboardEvent;

describe('reading a keypress', () => {
  it('matches on the physical key, not the character it produced', () => {
    // macOS turns Alt+F into "ƒ" and Alt+0 into "º".
    expect(matches(press({ code: 'KeyF', key: 'ƒ', altKey: true }), 'Alt+F')).toBe(true);
    expect(matches(press({ code: 'Digit0', key: 'º', altKey: true }), 'Alt+0')).toBe(true);
  });

  it('falls back to the character when there is no useful code', () => {
    expect(matches(press({ code: '', key: 'f', altKey: true }), 'Alt+F')).toBe(true);
  });

  it('takes the numeric keypad for the digit it is', () => {
    expect(matches(press({ code: 'Numpad0', key: '0', altKey: true }), 'Alt+0')).toBe(true);
  });

  it('will not fire on extra modifiers, nor on the bare key', () => {
    expect(matches(press({ code: 'KeyF', altKey: true, ctrlKey: true }), 'Alt+F')).toBe(false);
    expect(matches(press({ code: 'KeyF', altKey: true, shiftKey: true }), 'Alt+F')).toBe(false);
    expect(matches(press({ code: 'KeyF', key: 'f' }), 'Alt+F')).toBe(false);
  });

  it('is false for a bind it cannot read, rather than throwing', () => {
    expect(matches(press({ code: 'KeyF', altKey: true }), '')).toBe(false);
    expect(matches(press({ code: 'KeyF', altKey: true }), 'nonsense')).toBe(false);
  });
});

describe('which tool a keypress opens', () => {
  it('finds each of the four defaults', () => {
    const got = (code: string) => toolFor(press({ code, altKey: true }), DEFAULT_SHORTCUTS);
    expect(got('KeyF')).toBe('formula');
    expect(got('KeyM')).toBe('diagram');
    expect(got('KeyE')).toBe('drawing');
    expect(got('Digit0')).toBe('footnotes');
  });

  it('is null for anything else', () => {
    expect(toolFor(press({ code: 'KeyQ', altKey: true }), DEFAULT_SHORTCUTS)).toBeNull();
    expect(toolFor(press({ code: 'KeyF' }), DEFAULT_SHORTCUTS)).toBeNull();
  });

  it('follows a rebind rather than the default', () => {
    const mine = { ...DEFAULT_SHORTCUTS, formula: 'Ctrl+Alt+2' };
    expect(toolFor(press({ code: 'Digit2', ctrlKey: true, altKey: true }), mine)).toBe('formula');
    expect(toolFor(press({ code: 'KeyF', altKey: true }), mine)).toBeNull();
  });

  it('ignores an unbound tool', () => {
    expect(toolFor(press({ code: 'KeyF', altKey: true }), { ...DEFAULT_SHORTCUTS, formula: '' })).toBeNull();
  });
});

describe('setting a bind from a keypress', () => {
  it('writes the modifiers in one order, whatever order they were pressed', () => {
    expect(bindOf(press({ code: 'KeyF', altKey: true, ctrlKey: true, shiftKey: true }))).toBe('Ctrl+Alt+Shift+F');
  });

  it('refuses a key with no modifier, so typing cannot set one off', () => {
    expect(bindOf(press({ code: 'KeyF', key: 'f' }))).toBeNull();
    expect(bindOf(press({ code: 'KeyF', key: 'F', shiftKey: true }))).toBeNull();
  });

  it('refuses a modifier on its own: there is nothing to bind yet', () => {
    expect(bindOf(press({ code: 'AltLeft', key: 'Alt', altKey: true }))).toBeNull();
  });

  it('takes letters, digits and function keys, and nothing else', () => {
    expect(bindOf(press({ code: 'KeyZ', altKey: true }))).toBe('Alt+Z');
    expect(bindOf(press({ code: 'Digit7', altKey: true }))).toBe('Alt+7');
    expect(bindOf(press({ code: 'F5', key: 'F5', altKey: true }))).toBe('Alt+F5');
    expect(bindOf(press({ code: 'BracketLeft', key: '[', altKey: true }))).toBeNull();
    expect(bindOf(press({ code: 'ArrowUp', key: 'ArrowUp', altKey: true }))).toBeNull();
  });
});

describe('tidying a written bind', () => {
  it('accepts the spellings a person types', () => {
    expect(parseBind('alt+f')).toBe('Alt+F');
    expect(parseBind(' Shift + Ctrl + k ')).toBe('Ctrl+Shift+K');
  });

  it('rejects what could not be a shortcut', () => {
    for (const bad of ['', 'F', 'Shift+F', 'Hyper+F', 'Alt', 'Alt+[', 'Alt+Enter', null, 7]) {
      expect(parseBind(bad as never), String(bad)).toBeNull();
    }
  });
});

describe('the keys the app keeps', () => {
  it('reserves every app keybind, fallbacks included, and Ctrl/Cmd+S', () => {
    const reserved = reservedChords();
    for (const chord of appChords()) expect(reserved.has(normaliseChord(chord)!), chord).toBe(true);
    expect(reserved.get('Ctrl+S')).toBe('Save');
    expect(reserved.get('Meta+S')).toBe('Save');
    expect(reserved.has('Alt+N')).toBe(true);
    expect(reserved.has('Alt+Shift+P')).toBe(true);
  });

  it('leaves the four defaults free', () => {
    const reserved = reservedChords();
    for (const tool of TOOLS) expect(reserved.has(DEFAULT_SHORTCUTS[tool.id]), tool.id).toBe(false);
  });
});

describe('refusing a bind', () => {
  it('explains a key another tool already has', () => {
    expect(bindRefusal('Alt+M', 'formula', DEFAULT_SHORTCUTS)).toBe('Alt+M already opens diagram.');
  });

  it('lets a tool keep the key it already has', () => {
    expect(bindRefusal('Alt+F', 'formula', DEFAULT_SHORTCUTS)).toBeNull();
  });

  it('keeps the app keybinds and Save to themselves', () => {
    expect(bindRefusal('Alt+N', 'formula', DEFAULT_SHORTCUTS)).toBe('Alt+N is taken by New task.');
    expect(bindRefusal('Alt+Shift+P', 'formula', DEFAULT_SHORTCUTS)).toBe('Alt+Shift+P is taken by New project.');
    expect(bindRefusal('Ctrl+K', 'formula', DEFAULT_SHORTCUTS)).toBe('Ctrl+K is taken by Command palette.');
    expect(bindRefusal('Ctrl+S', 'formula', DEFAULT_SHORTCUTS)).toBe('Ctrl+S is taken by Save.');
    expect(bindRefusal('Meta+S', 'formula', DEFAULT_SHORTCUTS)).toBe('Cmd+S is taken by Save.');
  });

  it('says what a usable bind looks like', () => {
    expect(bindRefusal('F', 'formula', DEFAULT_SHORTCUTS)).toContain('Ctrl, Alt or Cmd');
  });

  it('allows a free key', () => {
    expect(bindRefusal('Ctrl+Alt+1', 'formula', DEFAULT_SHORTCUTS)).toBeNull();
  });
});

describe('reading stored shortcuts', () => {
  it('fills in everything that was never set', () => {
    expect(readShortcuts(undefined)).toEqual(DEFAULT_SHORTCUTS);
    expect(readShortcuts({ formula: 'Alt+Q' })).toEqual({ ...DEFAULT_SHORTCUTS, formula: 'Alt+Q' });
  });

  it('drops a stored value it cannot read', () => {
    expect(readShortcuts({ formula: 'Shift+F' }).formula).toBe('Alt+F');
    expect(readShortcuts('garbage').formula).toBe('Alt+F');
  });

  it('never lets two tools end up on one key', () => {
    const out = readShortcuts({ formula: 'Alt+M' });
    expect(out.formula).toBe('Alt+M');
    expect(out.diagram).not.toBe('Alt+M');
    const binds = TOOLS.map((tool) => out[tool.id]).filter(Boolean);
    expect(new Set(binds).size).toBe(binds.length);
  });

  it('will not hand over a key the app keeps for itself', () => {
    expect(readShortcuts({ formula: 'Alt+N' }).formula).toBe('Alt+F');
    expect(readShortcuts({ formula: 'Ctrl+S' }).formula).toBe('Alt+F');
  });
});

describe('keeping them per device', () => {
  const store = new Map<string, string>();
  const fakeStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };

  afterEach(() => {
    store.clear();
    vi.unstubAllGlobals();
  });

  it('reads the defaults when nothing is stored, or storage is blocked', () => {
    vi.stubGlobal('localStorage', fakeStorage);
    expect(loadShortcuts()).toEqual(DEFAULT_SHORTCUTS);
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
    });
    expect(loadShortcuts()).toEqual(DEFAULT_SHORTCUTS);
  });

  it('saves, announces and resets', () => {
    vi.stubGlobal('localStorage', fakeStorage);
    const target = new EventTarget();
    vi.stubGlobal('window', target);
    const seen: unknown[] = [];
    const stop = onShortcutsChange((next) => seen.push(next));

    const saved = saveShortcuts({ ...DEFAULT_SHORTCUTS, formula: 'alt+q' });
    expect(saved.formula).toBe('Alt+Q');
    expect(JSON.parse(store.get(SHORTCUTS_KEY)!)).toEqual(saved);
    expect(loadShortcuts().formula).toBe('Alt+Q');

    expect(resetShortcuts()).toEqual(DEFAULT_SHORTCUTS);
    expect(store.has(SHORTCUTS_KEY)).toBe(false);
    expect(seen).toEqual([saved, DEFAULT_SHORTCUTS]);

    stop();
    target.dispatchEvent(new CustomEvent(SHORTCUTS_EVENT, { detail: saved }));
    expect(seen).toHaveLength(2);
  });
});
