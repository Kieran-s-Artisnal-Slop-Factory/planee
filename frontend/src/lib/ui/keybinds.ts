/**
 * App keybinds at runtime (D23–D28). One capture-phase keydown listener on
 * window, installed by Layout on every page, turns keypresses into keybind ids
 * from lib/ui/keymap.ts and runs whatever the mounted components registered
 * for them. Layout owns the listening; components own the behaviour:
 *
 *   Fab.svelte           global: fab.open and the create keys. Onboarding has
 *                        no FAB, so it has no create keys either.
 *   Board.svelte         home: the column, project and version keys; card: the
 *                        focused-card keys (scope active while a card has focus)
 *   CommandPalette       palette.open, through its own capture listener. It is
 *                        listed here (the overlay shows it) but never dispatched.
 *
 * The rules (findKeybind, pure and unit-tested):
 *   - A modal owning the keyboard (anything `[aria-modal="true"]`, an open
 *     `<dialog>`, or `[data-keybind-modal]`) stops every keybind: the palette,
 *     the FAB's create dialog, a card dialog, the complete and edit-version
 *     dialogs, the markdown editor's own dialogs.
 *   - Keys mid-IME-composition, or already handled (`defaultPrevented`), are
 *     left alone.
 *   - Typing — a text field, select, contenteditable, editor, or anywhere
 *     inside a `<form>` (where Enter, Ctrl+Enter and Escape belong to the
 *     form) — stops a keybind unless it is `whileTyping`.
 *   - A scope counts only while something registered for it AND that
 *     registration's `active()` holds (card: a board card has focus).
 *   - Precedence card > home > global.
 *   - A match whose handler is disabled (`enabled()` false: a read-only
 *     version, no version at all) is SWALLOWED — preventDefault, nothing runs.
 *     The app owns that chord on this page, and Ctrl+1 on a completed version
 *     must not switch browser tabs instead.
 *   - A handler returning `false` declines: nothing is prevented, so e.g. Tab
 *     on the last card moves focus the normal way.
 *   - Anything handled gets preventDefault + stopPropagation, which suppresses
 *     the browser's own action where a page may (Ctrl+E address-bar search,
 *     Ctrl+Shift+C inspect, Ctrl+4 tab switch). Ctrl+N and Firefox's
 *     Ctrl+Shift+P never reach a page in a normal tab — hence the fallbacks
 *     (D25), shown by the overlay via displayChords.
 *
 * The registry lives on globalThis, so an island and Layout's script share it
 * even if a bundler ever duplicated this module.
 */
import { KEYMAP, type KeyScope, type Keybind } from './keymap';
import { isEditableTarget, matchesChord, parseChord } from './keys';

// ─── Pure rules ─────────────────────────────────────────────────────────────

/** Every chord a keybind answers to: its keys, then its fallback. */
export function chordsOf(keybind: Keybind): string[] {
  return [...keybind.keys, ...(keybind.fallback ? [keybind.fallback] : [])];
}

export interface DispatchContext {
  /** Focus is somewhere the user types (see isTypingTarget). */
  typing: boolean;
  /** A modal owns the keyboard (see isModalOpen). */
  modal: boolean;
  /** Scopes with a live registration: registered, and its `active()` holds. */
  scopes: ReadonlySet<KeyScope>;
  /** Keybind ids with a live handler → whether it is enabled right now. */
  handlers: ReadonlyMap<string, boolean>;
}

export interface KeyMatch {
  keybind: Keybind;
  /** False: in scope and owned by the page, but a no-op right now (swallowed). */
  enabled: boolean;
}

type KeyEventLike = Pick<
  KeyboardEvent,
  'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey' | 'key' | 'code' | 'isComposing' | 'defaultPrevented'
>;

const SCOPE_ORDER: readonly KeyScope[] = ['card', 'home', 'global'];

/** Which keybind (if any) a keypress asks for, under the rules above. */
export function findKeybind(
  event: KeyEventLike,
  ctx: DispatchContext,
  keymap: readonly Keybind[] = KEYMAP
): KeyMatch | null {
  if (event.isComposing || event.defaultPrevented || ctx.modal) return null;
  for (const scope of SCOPE_ORDER) {
    if (!ctx.scopes.has(scope)) continue;
    for (const keybind of keymap) {
      if (keybind.scope !== scope) continue;
      const enabled = ctx.handlers.get(keybind.id);
      if (enabled === undefined) continue;
      if (!chordsOf(keybind).some((chord) => matchesChord(event as KeyboardEvent, chord))) continue;
      if (ctx.typing && !keybind.whileTyping) continue;
      return { keybind, enabled };
    }
  }
  return null;
}

export interface DisplayOptions {
  /** Running as an installed app window (keys.ts isInstalledApp). */
  installed: boolean;
  /** Apple platform: Cmd rather than Ctrl where a keybind has both. */
  mac: boolean;
}

/**
 * The chords to SHOW for a keybind (lib/ui/keys.ts spelling; format with
 * chordLabel). D25: a browser-reserved chord shows its fallback unless the app
 * runs as an installed window. A keybind bound to both Ctrl+X and Meta+X
 * (the palette) shows Cmd on a Mac and Ctrl elsewhere.
 */
export function displayChords(keybind: Keybind, opts: DisplayOptions): string[] {
  if (keybind.fallback && !opts.installed) return [keybind.fallback];
  const parsed = keybind.keys.map((text) => ({ text, chord: parseChord(text) }));
  const twin = (a: ReturnType<typeof parseChord>, b: ReturnType<typeof parseChord>) =>
    !!a && !!b && a.key === b.key && a.alt === b.alt && a.shift === b.shift && a.ctrl !== b.ctrl && a.meta !== b.meta;
  return parsed
    .filter(({ chord }) => {
      if (!chord) return true;
      const other = parsed.find((p) => twin(p.chord, chord));
      if (!other) return true;
      return opts.mac ? chord.meta : chord.ctrl;
    })
    .map(({ text }) => text);
}

/**
 * Where a badge sits on the element that carries it:
 *   corner  straddling the top edge, right-aligned with the right edge (default)
 *   top / bottom / left / right  centred on that edge
 *   beside  outside, to the left (the FAB, its menu)
 */
export type BadgePlacement = 'corner' | 'top' | 'bottom' | 'left' | 'right' | 'beside';
const PLACEMENTS: readonly BadgePlacement[] = ['corner', 'top', 'bottom', 'left', 'right', 'beside'];

/**
 * Parse an element's `data-keybind`: space-separated ids, each optionally
 * `@placement` — e.g. `"card.edit card.up@top card.down@bottom"`.
 */
export function parseBadgeAttr(attr: string | null | undefined): { id: string; placement: BadgePlacement }[] {
  if (!attr) return [];
  return attr
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => {
      const [id = '', where] = token.split('@');
      const placement = PLACEMENTS.find((p) => p === where) ?? 'corner';
      return { id, placement };
    })
    .filter((item) => item.id !== '');
}

// ─── The registry ───────────────────────────────────────────────────────────

/** Run a keybind. Return `false` to decline (nothing is prevented). */
export type KeyHandler = (event: KeyboardEvent) => boolean | void;

export interface KeyAction {
  run: KeyHandler;
  /** False: the keybind is a no-op right now — swallowed, and dimmed in the overlay. */
  enabled?: () => boolean;
}

export interface ScopeOptions {
  /** Whether these handlers apply right now (card: a card has focus). Default: always. */
  active?: () => boolean;
}

interface Registration {
  scope: KeyScope;
  handlers: Map<string, KeyAction>;
  active?: () => boolean;
}

interface RegistryState {
  registrations: Registration[];
  uninstall: (() => void) | null;
}

const STATE_KEY = '__planeeKeybinds';

function state(): RegistryState {
  const g = globalThis as unknown as Record<string, RegistryState | undefined>;
  return (g[STATE_KEY] ??= { registrations: [], uninstall: null });
}

/** Keybinds handled somewhere else but still part of every page (the overlay lists them). */
export const EXTERNAL_KEYBINDS: ReadonlySet<string> = new Set(['palette.open']);

/**
 * Register what keybinds do while a component is mounted. Returns the
 * unregister function (hand it back from onMount). A later registration of the
 * same id wins while it is live. Throws for an id that is not in KEYMAP or
 * belongs to another scope — a typo there would otherwise be a silent no-op.
 */
export function registerKeyHandlers(
  scope: KeyScope,
  handlers: Record<string, KeyHandler | KeyAction>,
  options: ScopeOptions = {}
): () => void {
  const map = new Map<string, KeyAction>();
  for (const [id, handler] of Object.entries(handlers)) {
    const keybind = KEYMAP.find((k) => k.id === id);
    if (!keybind) throw new Error('No keybind ' + id);
    if (keybind.scope !== scope) throw new Error(`${id} is a ${keybind.scope} keybind, not ${scope}`);
    map.set(id, typeof handler === 'function' ? { run: handler } : handler);
  }
  const registration: Registration = { scope, handlers: map, active: options.active };
  state().registrations.push(registration);
  return () => {
    const list = state().registrations;
    const at = list.indexOf(registration);
    if (at >= 0) list.splice(at, 1);
  };
}

const holds = (test: (() => boolean) | undefined, fallback = true): boolean => {
  if (!test) return fallback;
  try {
    return test();
  } catch {
    return false;
  }
};

/** Live handlers by id (latest live registration wins) and the scopes they make live. */
function liveHandlers(): { actions: Map<string, KeyAction>; scopes: Set<KeyScope> } {
  const actions = new Map<string, KeyAction>();
  const scopes = new Set<KeyScope>();
  for (const registration of state().registrations) {
    if (!holds(registration.active)) continue;
    scopes.add(registration.scope);
    for (const [id, action] of registration.handlers) actions.set(id, action);
  }
  return { actions, scopes };
}

/** Every registered id, live or not (the overlay dims the ones that aren't). */
function registeredIds(): Set<string> {
  const ids = new Set<string>();
  for (const registration of state().registrations) for (const id of registration.handlers.keys()) ids.add(id);
  return ids;
}

// ─── The DOM side ───────────────────────────────────────────────────────────

/** What counts as "a modal owns the keyboard". */
export const MODAL_SELECTOR = '[aria-modal="true"], dialog[open], [data-keybind-modal]';

export function isModalOpen(root: ParentNode | null = typeof document === 'undefined' ? null : document): boolean {
  return !!root?.querySelector(MODAL_SELECTOR);
}

/** Typing: an editable target (keys.ts isEditableTarget), or anywhere inside a form. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (isEditableTarget(target)) return true;
  const el = target as Element | null;
  return typeof el?.closest === 'function' && el.closest('form') !== null;
}

export interface DispatchEnvironment {
  typing(target: EventTarget | null): boolean;
  modal(): boolean;
}

const domEnvironment: DispatchEnvironment = { typing: isTypingTarget, modal: () => isModalOpen() };

/**
 * Handle one keydown: find the keybind under the rules, run it (unless it is
 * disabled), and claim the event. Returns whether the event was claimed.
 */
export function dispatchKey(event: KeyboardEvent, env: DispatchEnvironment = domEnvironment): boolean {
  if (event.isComposing || event.defaultPrevented) return false;
  const { actions, scopes } = liveHandlers();
  if (actions.size === 0) return false;
  const handlers = new Map<string, boolean>();
  for (const [id, action] of actions) handlers.set(id, holds(action.enabled));
  const match = findKeybind(event, { typing: env.typing(event.target), modal: env.modal(), scopes, handlers });
  if (!match) return false;
  if (match.enabled && actions.get(match.keybind.id)!.run(event) === false) return false;
  event.preventDefault();
  event.stopPropagation();
  return true;
}

/** Install the one window listener (idempotent). Returns the uninstall. */
export function installKeybinds(target: Window | undefined = typeof window === 'undefined' ? undefined : window): () => void {
  const s = state();
  if (s.uninstall) return s.uninstall;
  if (!target) return () => {};
  const listener = (event: Event) => void dispatchKey(event as KeyboardEvent);
  target.addEventListener('keydown', listener, { capture: true });
  s.uninstall = () => {
    target.removeEventListener('keydown', listener, { capture: true });
    s.uninstall = null;
  };
  return s.uninstall;
}

// ─── What the overlay shows ─────────────────────────────────────────────────

export interface KeybindStatus {
  keybind: Keybind;
  /** Usable right now: scope live, handler enabled, not blocked by typing. */
  available: boolean;
}

/**
 * The keybinds this page has, in KEYMAP order: every registered one (live or
 * not) plus the external ones (the palette). `typing` is whether focus is in
 * a typing context now, which dims the keybinds that don't work there.
 */
export function keybindStatuses(typing = typeof document !== 'undefined' && isTypingTarget(document.activeElement)): KeybindStatus[] {
  const { actions } = liveHandlers();
  const registered = registeredIds();
  const out: KeybindStatus[] = [];
  for (const keybind of KEYMAP) {
    const external = EXTERNAL_KEYBINDS.has(keybind.id);
    if (!external && !registered.has(keybind.id)) continue;
    const action = actions.get(keybind.id);
    const live = external || (!!action && holds(action.enabled));
    out.push({ keybind, available: live && (!typing || !!keybind.whileTyping) });
  }
  return out;
}

/** Tests only: forget every registration and the listener. */
export function resetKeybindsForTests(): void {
  const s = state();
  s.uninstall?.();
  s.registrations = [];
}
