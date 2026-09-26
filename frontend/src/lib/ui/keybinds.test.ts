import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chordsOf,
  dispatchKey,
  displayChords,
  findKeybind,
  keybindStatuses,
  parseBadgeAttr,
  registerKeyHandlers,
  resetKeybindsForTests,
  type DispatchContext,
  type DispatchEnvironment,
} from './keybinds';
import { KEYMAP, keybind, type KeyScope } from './keymap';

type Ev = Partial<KeyboardEvent>;
const ev = (e: Ev) => {
  const event = {
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    key: '',
    code: '',
    isComposing: false,
    defaultPrevented: false,
    target: null,
    ...e,
    preventDefault: vi.fn(function (this: { defaultPrevented: boolean }) {
      this.defaultPrevented = true;
    }),
    stopPropagation: vi.fn(),
  };
  return event as unknown as KeyboardEvent & { preventDefault: ReturnType<typeof vi.fn>; stopPropagation: ReturnType<typeof vi.fn> };
};

const ctrl = (code: string, extra: Ev = {}) => ev({ ctrlKey: true, code, key: code.replace(/^(Key|Digit)/, ''), ...extra });

/** Every id of the given scopes registered and enabled, unless overridden. */
function ctx(scopes: KeyScope[], over: Partial<DispatchContext> = {}, disabled: string[] = []): DispatchContext {
  const handlers = new Map<string, boolean>();
  for (const k of KEYMAP) if (scopes.includes(k.scope) && !k.id.startsWith('palette')) handlers.set(k.id, !disabled.includes(k.id));
  return { typing: false, modal: false, scopes: new Set(scopes), handlers, ...over };
}

describe('findKeybind', () => {
  it('maps chords to ids across the scopes', () => {
    const all = ctx(['global', 'home', 'card']);
    expect(findKeybind(ctrl('Digit1'), all)?.keybind.id).toBe('column.todo.new');
    expect(findKeybind(ctrl('Digit1', { shiftKey: true, key: '!' }), all)?.keybind.id).toBe('column.todo.focus');
    expect(findKeybind(ctrl('Digit4'), all)?.keybind.id).toBe('board.project');
    expect(findKeybind(ctrl('KeyC', { shiftKey: true }), all)?.keybind.id).toBe('version.complete');
    expect(findKeybind(ctrl('KeyE', { shiftKey: true }), all)?.keybind.id).toBe('version.edit');
    expect(findKeybind(ctrl('Enter'), all)?.keybind.id).toBe('fab.open');
    expect(findKeybind(ctrl('KeyV', { shiftKey: true }), all)?.keybind.id).toBe('create.version');
    expect(findKeybind(ev({ code: 'Tab', key: 'Tab' }), all)?.keybind.id).toBe('card.next');
    expect(findKeybind(ev({ code: 'PageUp', key: 'PageUp' }), all)?.keybind.id).toBe('card.prev');
    expect(findKeybind(ev({ code: 'Tab', key: 'Tab', shiftKey: true }), all)?.keybind.id).toBe('card.prev');
    expect(findKeybind(ctrl('ArrowRight'), all)?.keybind.id).toBe('card.right');
    expect(findKeybind(ctrl('KeyE'), all)?.keybind.id).toBe('card.edit');
  });

  it('answers to the primary chord AND the fallback (D25)', () => {
    const g = ctx(['global']);
    expect(findKeybind(ctrl('KeyN'), g)?.keybind.id).toBe('create.task');
    expect(findKeybind(ev({ altKey: true, code: 'KeyN', key: 'n' }), g)?.keybind.id).toBe('create.task');
    expect(findKeybind(ev({ altKey: true, code: 'KeyN', key: '˜' }), g)?.keybind.id).toBe('create.task'); // macOS Option
    expect(findKeybind(ctrl('KeyP', { shiftKey: true }), g)?.keybind.id).toBe('create.project');
    expect(findKeybind(ev({ altKey: true, shiftKey: true, code: 'KeyP', key: 'P' }), g)?.keybind.id).toBe('create.project');
  });

  it('only considers live scopes: card keys need a focused card, home keys the board', () => {
    expect(findKeybind(ev({ code: 'Tab', key: 'Tab' }), ctx(['global', 'home']))).toBeNull();
    expect(findKeybind(ctrl('ArrowUp'), ctx(['global', 'home']))).toBeNull();
    expect(findKeybind(ctrl('Digit1'), ctx(['global']))).toBeNull();
    // Onboarding: nothing registered at all.
    expect(findKeybind(ctrl('Enter'), ctx([]))).toBeNull();
  });

  it('needs a registered handler even in a live scope', () => {
    const c = ctx(['home']);
    (c.handlers as Map<string, boolean>).delete('board.project');
    expect(findKeybind(ctrl('Digit4'), c)).toBeNull();
  });

  it('a modal owns the keyboard: nothing fires, not even whileTyping keys', () => {
    const modal = ctx(['global', 'home', 'card'], { modal: true });
    expect(findKeybind(ctrl('Digit1'), modal)).toBeNull();
    expect(findKeybind(ev({ altKey: true, code: 'KeyN', key: 'n' }), modal)).toBeNull();
    expect(findKeybind(ctrl('Enter'), modal)).toBeNull();
    expect(findKeybind(ev({ code: 'Tab', key: 'Tab' }), modal)).toBeNull();
  });

  it('while typing only whileTyping keys fire (D24: Ctrl+Shift+V stays paste-as-plain-text)', () => {
    const typing = ctx(['global', 'home'], { typing: true });
    expect(findKeybind(ctrl('KeyV', { shiftKey: true }), typing)).toBeNull();
    expect(findKeybind(ctrl('Enter'), typing)).toBeNull(); // a form's Ctrl+Enter submit
    expect(findKeybind(ctrl('Digit1'), typing)).toBeNull();
    expect(findKeybind(ctrl('KeyN'), typing)?.keybind.id).toBe('create.task');
    expect(findKeybind(ev({ altKey: true, shiftKey: true, code: 'KeyP', key: 'P' }), typing)?.keybind.id).toBe(
      'create.project'
    );
  });

  it('reports a disabled handler as a match that must not run', () => {
    const readOnly = ctx(['home', 'card'], {}, ['column.todo.new', 'card.up']);
    expect(findKeybind(ctrl('Digit1'), readOnly)).toMatchObject({ enabled: false });
    expect(findKeybind(ctrl('ArrowUp'), readOnly)).toMatchObject({ enabled: false });
    expect(findKeybind(ctrl('Digit1', { shiftKey: true }), readOnly)).toMatchObject({ enabled: true });
  });

  it('never claims modifier supersets, IME composition, or keys already handled', () => {
    const all = ctx(['global', 'home', 'card']);
    expect(findKeybind(ctrl('Digit1', { altKey: true }), all)).toBeNull();
    expect(findKeybind(ctrl('KeyE', { altKey: true }), all)).toBeNull();
    expect(findKeybind(ctrl('Digit1', { isComposing: true }), all)).toBeNull();
    expect(findKeybind(ctrl('Digit1', { defaultPrevented: true }), all)).toBeNull();
    expect(findKeybind(ctrl('KeyK'), all)).toBeNull(); // the palette's own listener has it
  });
});

describe('displayChords', () => {
  const tab = { installed: false, mac: false };
  const app = { installed: true, mac: false };

  it('shows the fallback in a browser tab and the primary in an installed app (D25)', () => {
    expect(displayChords(keybind('create.task'), tab)).toEqual(['Alt+N']);
    expect(displayChords(keybind('create.task'), app)).toEqual(['Ctrl+N']);
    expect(displayChords(keybind('create.project'), tab)).toEqual(['Alt+Shift+P']);
    expect(displayChords(keybind('create.project'), app)).toEqual(['Ctrl+Shift+P']);
  });

  it('shows Cmd on a Mac and Ctrl elsewhere for a Ctrl/Meta pair', () => {
    expect(displayChords(keybind('palette.open'), tab)).toEqual(['Ctrl+K']);
    expect(displayChords(keybind('palette.open'), { installed: false, mac: true })).toEqual(['Meta+K']);
  });

  it('keeps every chord of a multi-key keybind', () => {
    expect(displayChords(keybind('card.next'), tab)).toEqual(['Tab', 'PageDown']);
    expect(displayChords(keybind('column.todo.focus'), tab)).toEqual(['Ctrl+Shift+1']);
  });

  it('chordsOf lists keys then the fallback', () => {
    expect(chordsOf(keybind('create.task'))).toEqual(['Ctrl+N', 'Alt+N']);
  });
});

describe('parseBadgeAttr', () => {
  it('reads ids with optional placements', () => {
    expect(parseBadgeAttr('card.edit card.up@top  card.down@bottom card.left@nope')).toEqual([
      { id: 'card.edit', placement: 'corner' },
      { id: 'card.up', placement: 'top' },
      { id: 'card.down', placement: 'bottom' },
      { id: 'card.left', placement: 'corner' },
    ]);
    expect(parseBadgeAttr(null)).toEqual([]);
    expect(parseBadgeAttr('  ')).toEqual([]);
  });
});

describe('registry and dispatch', () => {
  afterEach(() => resetKeybindsForTests());

  const env = (over: Partial<{ typing: boolean; modal: boolean }> = {}): DispatchEnvironment => ({
    typing: () => over.typing ?? false,
    modal: () => over.modal ?? false,
  });

  it('refuses unknown ids and ids of another scope', () => {
    expect(() => registerKeyHandlers('home', { 'column.nope.new': () => {} })).toThrow(/No keybind/);
    expect(() => registerKeyHandlers('global', { 'card.up': () => {} })).toThrow(/card keybind/);
  });

  it('runs the handler and claims the event', () => {
    const run = vi.fn();
    registerKeyHandlers('home', { 'column.todo.new': run });
    const event = ctrl('Digit1');
    expect(dispatchKey(event, env())).toBe(true);
    expect(run).toHaveBeenCalledOnce();
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
  });

  it('leaves unbound keys alone', () => {
    registerKeyHandlers('home', { 'column.todo.new': () => {} });
    const event = ctrl('KeyA');
    expect(dispatchKey(event, env())).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('swallows a disabled keybind without running it', () => {
    const run = vi.fn();
    registerKeyHandlers('home', { 'column.todo.new': { run, enabled: () => false } });
    const event = ctrl('Digit1');
    expect(dispatchKey(event, env())).toBe(true);
    expect(run).not.toHaveBeenCalled();
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it('a handler returning false declines: nothing prevented (Tab at the last card)', () => {
    registerKeyHandlers('card', { 'card.next': () => false });
    const event = ev({ code: 'Tab', key: 'Tab' });
    expect(dispatchKey(event, env())).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('card handlers apply only while their scope is active', () => {
    let focused = false;
    const run = vi.fn();
    registerKeyHandlers('card', { 'card.up': run }, { active: () => focused });
    expect(dispatchKey(ctrl('ArrowUp'), env())).toBe(false);
    focused = true;
    expect(dispatchKey(ctrl('ArrowUp'), env())).toBe(true);
    expect(run).toHaveBeenCalledOnce();
  });

  it('modal and typing gates come from the environment', () => {
    const run = vi.fn();
    registerKeyHandlers('global', { 'create.version': run, 'create.task': run });
    expect(dispatchKey(ctrl('KeyV', { shiftKey: true }), env({ modal: true }))).toBe(false);
    expect(dispatchKey(ctrl('KeyV', { shiftKey: true }), env({ typing: true }))).toBe(false);
    expect(dispatchKey(ev({ altKey: true, code: 'KeyN', key: 'n' }), env({ typing: true }))).toBe(true);
    expect(run).toHaveBeenCalledOnce();
  });

  it('unregistering removes the handlers; the latest live registration wins', () => {
    const first = vi.fn();
    const second = vi.fn();
    const stopFirst = registerKeyHandlers('home', { 'board.project': first });
    const stopSecond = registerKeyHandlers('home', { 'board.project': second });
    dispatchKey(ctrl('Digit4'), env());
    expect(second).toHaveBeenCalledOnce();
    stopSecond();
    dispatchKey(ctrl('Digit4'), env());
    expect(first).toHaveBeenCalledOnce();
    stopFirst();
    expect(dispatchKey(ctrl('Digit4'), env())).toBe(false);
  });

  it('keybindStatuses lists registered keybinds plus the palette, dimming what is unavailable', () => {
    let focused = false;
    registerKeyHandlers('global', { 'create.version': () => {}, 'create.task': () => {} });
    registerKeyHandlers('home', { 'column.todo.new': { run: () => {}, enabled: () => false } });
    registerKeyHandlers('card', { 'card.up': () => {} }, { active: () => focused });
    const byId = (typing: boolean) => Object.fromEntries(keybindStatuses(typing).map((s) => [s.keybind.id, s.available]));
    expect(byId(false)).toEqual({
      'palette.open': true,
      'create.task': true,
      'create.version': true,
      'column.todo.new': false,
      'card.up': false,
    });
    focused = true;
    expect(byId(false)['card.up']).toBe(true);
    // Typing dims what does not work there; whileTyping keys stay.
    expect(byId(true)).toMatchObject({ 'palette.open': true, 'create.task': true, 'create.version': false });
  });
});
