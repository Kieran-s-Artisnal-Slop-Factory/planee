<!-- Ported from retoken (af25bc6) -->
<script lang="ts">
  /**
   * A drag-and-drop board over a list of your own objects:
   *
   *   <KanbanBoard cards={tasks} onUpdate={save} onCreate={add} onDelete={drop} />
   *
   * The cards are yours — plain objects in whatever shape your storage already
   * uses. A `schema` says which key plays which part (`{ headline: 'title',
   * state: 'status', deadline: 'due' }`), and with no schema at all the obvious
   * spellings are found in the data. Every card carries a title, one of the
   * three statuses, a due date, a priority, and a markdown description that is
   * rendered at rest and edited behind a pencil.
   *
   * ── Storage is yours too ───────────────────────────────────────────────────
   * Three callbacks — `onCreate`, `onUpdate`, `onDelete` — report what the
   * reader did, in your keys and your values. Nothing else talks to storage, so
   * the same board sits on top of an array in memory, IndexedDB, or a REST API.
   *
   * Changes apply immediately and are reported after, so the board works
   * whether or not you feed the change back through `cards`: pass an updated
   * array and it takes over, ignore it and the board keeps showing its own
   * copy. An async callback that rejects leaves the card where the reader put
   * it, marked failed, with Retry and Undo — rather than losing the work.
   * `lib/kanban/board.ts` has the reconciliation rules, and they are
   * unit-tested.
   *
   * ── Moving cards ───────────────────────────────────────────────────────────
   * Drag with a mouse from anywhere on a card, or from its ⠿ grip on a touch
   * screen (where a drag from the body has to stay a scroll). The keyboard can
   * do all of it too: Space on the grip picks a card up, the arrow keys move it
   * between columns and positions, Space drops it and Escape puts it back, with
   * every step announced.
   *
   * Positions are fractional sort keys, so a drop is one number written to your
   * ordering field. With no ordering field in the data, the board keeps the
   * position locally and reports only the status — there is nowhere to put it.
   * A drop reports `status` only when the card changes COLUMN, so reordering
   * inside a column that claims several spellings (planee's Done claims
   * `wontfix`, `out_of_scope` and `bumped`) never rewrites them.
   *
   * ── Extending it (planee) ──────────────────────────────────────────────────
   * All optional; the board works without any of them.
   *   cardBadges(card)            extra pills in each card's badge row (and the dialog's)
   *   dialogBody(card)            replaces the dialog's description render
   *   dialogActions(card, close)  extra buttons in the dialog's action row
   *   formFields                  which fields the inline/dialog editor shows
   *   createDefaults              starting values for the composer (board vocabulary)
   *   resolveImage, previewNonce  passed through to MarkdownPreview
   *   openCardId                  open that card's dialog from outside (a deep link)
   *   onDialogOpen, onDialogClose the dialog opened (any way) / closed
   *   keyboard                    focusable cards + the methods below (D23)
   * `readonly` disables drag (mouse, touch, keyboard), the composer, editing and
   * delete; the snippets still render and the host decides what they show.
   *
   * ── Focusable cards (planee, `keyboard`) ───────────────────────────────────
   * Each card is a focus target of its own (tabindex -1, a ring), and the host
   * binds keys to these methods (planee: lib/ui/keybinds.ts, Board.svelte):
   *   focusedCardId()            the card that has focus, or null
   *   focusFirstCard(status)     focus a column's top card (flashes an empty column)
   *   focusNeighbourCard(1|-1)   next/previous card in reading order; false at the ends
   *   moveFocusedCard(direction) up/down in the column, left/right to the top of
   *                              the neighbouring column - through the SAME commit
   *                              as a drop (planDrop -> change -> onUpdate), so
   *                              ordering, optimistic state, Retry/Undo and the
   *                              announcement behave exactly like a drag
   *   editFocusedCard()          open the card's dialog with its editor
   * Focus stays on a moved card (it is found again by id after it re-renders).
   * Enter on a focused card opens its dialog; closing a dialog opened from the
   * card puts focus back on the card. Cards and column heads carry
   * `data-keybind` for the Ctrl overlay's badges.
   *
   * ── Known gaps (inherited from retoken) ────────────────────────────────────
   *  - No swimlanes: one row of status columns only.
   *  - A drop into a column the search has emptied lands at the END of that
   *    column — there is no visible card to anchor the position to.
   *  - "Show more" on a card is measured with a ResizeObserver, so in a
   *    background tab it can appear late (after the tab is shown again).
   */
  import { tick, type Snippet } from 'svelte';
  import KanbanCard from './KanbanCard.svelte';
  import CardDialog from './CardDialog.svelte';
  import CardForm from './CardForm.svelte';
  import {
    applyPending,
    columnsOf,
    draftEntry,
    dropIndexFor,
    fieldsOf,
    filterEntries,
    isNoMove,
    nextLocalId,
    normalizeEntries,
    planDrop,
    planMove,
    prunePending,
    sortKeyOf,
    toCardDraft,
    toCardPatch,
    toInsertIndex,
    type Entry,
    type PatchFields,
    type Pending,
    type PendingCreate,
    type PendingPatch,
  } from '../../lib/kanban/board';
  import { dueFromDay } from '../../lib/kanban/dates';
  import {
    firstCard,
    neighbourCard,
    planKeyboardMove,
    type CardDirection,
    type ColumnCards,
  } from '../../lib/board/keyboard';
  import {
    normalizeSchema,
    sampleKeys,
    type CardRecord,
    type FieldRole,
    type KanbanSchema,
  } from '../../lib/kanban/types';

  type Awaitable<T> = T | Promise<T>;

  let {
    cards = [],
    schema = {},
    onCreate = undefined,
    onUpdate = undefined,
    onDelete = undefined,
    readonly = false,
    addable = true,
    editable = true,
    deletable = true,
    confirmDelete = true,
    searchable = true,
    search = $bindable(''),
    markdown = true,
    descriptionLines = 5,
    soonDays = 3,
    locale = undefined,
    columnWidth = '19rem',
    columnHeight = '32rem',
    dense = false,
    busy = false,
    empty = 'Nothing here.',
    headingLevel = 3,
    preview = true,
    onCardClick = undefined,
    now = Date.now(),
    cardBadges = undefined,
    dialogBody = undefined,
    dialogActions = undefined,
    formFields = undefined,
    createDefaults = undefined,
    resolveImage = undefined,
    previewNonce = 0,
    openCardId = null,
    onDialogOpen = undefined,
    onDialogClose = undefined,
    keyboard = false,
  }: {
    /** Your objects, in your own shape. Never mutated. */
    cards?: CardRecord[];
    /** Which of your keys plays which part. See `lib/kanban/types.ts`. */
    schema?: KanbanSchema;
    /**
     * A card was added. Gets a draft in your keys, with no id — return the
     * stored object (or its id) and the board adopts it; return nothing and it
     * keeps its own copy until an equivalent card arrives in `cards`.
     */
    onCreate?: ((draft: CardRecord) => Awaitable<CardRecord | string | number | void>) | undefined;
    /**
     * A card changed. Gets the id as your data spells it, a patch of only what
     * changed in your keys and values, and the original object.
     */
    onUpdate?: ((id: unknown, patch: CardRecord, card: CardRecord) => Awaitable<void>) | undefined;
    onDelete?: ((id: unknown, card: CardRecord) => Awaitable<void>) | undefined;
    /** Look, don't touch: no dragging, no editing, no adding. */
    readonly?: boolean;
    addable?: boolean;
    editable?: boolean;
    deletable?: boolean;
    /** Ask before deleting. Turn it off if you have your own confirmation. */
    confirmDelete?: boolean;
    searchable?: boolean;
    /** The search term. Bindable, so a page can drive or read it. */
    search?: string;
    /**
     * Render descriptions as markdown. `false` shows them as plain text and
     * leaves the markdown pipeline out of your bundle.
     */
    markdown?: boolean;
    /** Lines of description shown before "Show more". */
    descriptionLines?: number;
    /** How many days ahead counts as due soon. */
    soonDays?: number;
    /** BCP 47 tag for the dates. Defaults to the browser's. */
    locale?: string;
    columnWidth?: string;
    /** A CSS length, or `auto` to let the columns grow with the page. */
    columnHeight?: string;
    dense?: boolean;
    /** Show that something upstream is in flight. */
    busy?: boolean;
    /** What an empty column says. */
    empty?: string;
    /**
     * Heading level for the column names, so the board fits your document's
     * outline instead of imposing one. Cards sit one level below.
     */
    headingLevel?: 1 | 2 | 3 | 4 | 5;
    /**
     * Clicking a card's title opens it in full, in a dialog that can edit and
     * delete it like the card itself can. Turn it off to make the title a
     * plain click that only reports through `onCardClick`.
     */
    preview?: boolean;
    /** A card's title was clicked. Fires whether or not `preview` is on. */
    onCardClick?: ((card: CardRecord, entry: Entry) => void) | undefined;
    /** The moment "today" means. Pass a fixed one to freeze the due badges. */
    now?: number;
    /**
     * Extra pills in each card's badge row, and in the dialog's. Give them
     * `class="kb-pill tone-muted|info|success|warning|danger|primary"` to match
     * the built-in ones. A `<select>` or button in here does not start a drag.
     */
    cardBadges?: Snippet<[card: CardRecord]> | undefined;
    /**
     * Rendered in the dialog INSTEAD of the description — e.g. a markdown field
     * with its own Edit/Save/Cancel. Renders on read-only boards too.
     */
    dialogBody?: Snippet<[card: CardRecord]> | undefined;
    /** Extra buttons in the dialog's action row. Renders on read-only boards too. */
    dialogActions?: Snippet<[card: CardRecord, close: () => void]> | undefined;
    /**
     * Which fields the card editor (inline, dialog and composer) shows. The
     * title is always shown. Defaults to title, status, due, priority and
     * description.
     */
    formFields?: readonly FieldRole[] | undefined;
    /**
     * Starting values for a new card in the composer, in the board's own
     * vocabulary (status/priority ids, `YYYY-MM-DD`). The column it was opened
     * in always sets the status.
     */
    createDefaults?: PatchFields | undefined;
    /** Passed through to MarkdownPreview for image sources. */
    resolveImage?: ((src: string) => string | undefined) | undefined;
    /** Passed through to MarkdownPreview; bump it to re-render descriptions. */
    previewNonce?: number;
    /**
     * Open this card's dialog (the id as your data spells it), e.g. from a deep
     * link. Applied once per value, as soon as the card is on the board: the
     * reader closing the dialog does not reopen it while the prop still holds
     * the same id, so clear it in `onDialogClose` to be able to ask again.
     */
    openCardId?: string | number | null;
    /** A card's dialog opened — by a title click or by `openCardId`. */
    onDialogOpen?: ((card: CardRecord) => void) | undefined;
    /** The dialog closed (the reader closed it, or its card went away). */
    onDialogClose?: ((card: CardRecord | undefined) => void) | undefined;
    /**
     * Focusable cards and the keyboard methods (see the header): each card is
     * a focus target, and cards and column heads carry `data-keybind`.
     */
    keyboard?: boolean;
  } = $props();

  const model = $derived(normalizeSchema(schema, sampleKeys(cards)));
  /** The cards as given — what a pending change is measured against. */
  const incoming = $derived(normalizeEntries(cards, model));
  const sourceById = $derived(new Map(incoming.map((entry) => [entry.id, entry])));

  /** Changes made here that the source may not have caught up with yet. */
  let pending = $state<Record<string, Pending>>({});
  let creates = $state<PendingCreate[]>([]);

  const view = $derived(applyPending(incoming, pending, creates));
  const visible = $derived(searchable ? filterEntries(view, search) : view);
  const columns = $derived(columnsOf(visible, model));
  /**
   * The same columns with nothing filtered out. A search decides what is on
   * SCREEN; it must never decide what a sort key is computed against, or a drop
   * made while filtering would be ordered against a fraction of the column.
   */
  const allColumns = $derived(searchable && search.trim() ? columnsOf(view, model) : columns);
  const entryById = $derived(new Map(view.map((entry) => [entry.id, entry])));
  const hidden = $derived(view.length - visible.length);

  /**
   * Let go of the changes the source has caught up with. In an effect rather
   * than in the derivation because it settles state that the derivation reads;
   * it is idempotent, so it runs at most once more after it changes anything.
   */
  $effect(() => {
    const settled = prunePending(incoming, pending, creates, model);
    if (!settled.changed) return;
    pending = settled.pending;
    creates = settled.creates;
  });

  let editingId = $state<string | null>(null);
  let composerIn = $state<string | null>(null);
  /** The card shown in full, if any, and whether that view is editing it. */
  let openId = $state<string | null>(null);
  let openEditing = $state(false);
  let announcement = $state('');
  let failure = $state('');

  /**
   * Heading ids, unique when two boards share a page. `$props.id()` rather than
   * a counter, so a server render and its hydration agree on the value.
   */
  const uid = $props.id();

  // ── Pending changes ────────────────────────────────────────────────────────

  const patchOf = (id: string): PendingPatch | null => {
    const change = pending[id];
    return change?.kind === 'patch' ? change : null;
  };

  /** A card the board added itself keeps its state in `creates`, not `pending`. */
  const createOf = (id: string) => creates.find((item) => item.entry.id === id);

  const isBusy = (id: string) => {
    const change = pending[id] ?? createOf(id);
    return !!change && !change.done && !change.error;
  };

  const errorOf = (id: string) => pending[id]?.error ?? createOf(id)?.error;

  const message = (error: unknown) =>
    error instanceof Error ? error.message : String(error ?? 'failed');

  /** Show a failure AND say it: a banner nobody can see is not a report. */
  const reportFailure = (text: string) => {
    failure = text;
    say(text);
  };

  /** Merge a change into whatever is already pending for that card. */
  function stage(entry: Entry, fields: PatchFields): PendingPatch {
    const previous = patchOf(entry.id);
    // `before` is always the SOURCE value, never the value already showing, so
    // a second change to the same card still knows what the owner has.
    const base = fieldsOf(sourceById.get(entry.id) ?? entry);
    const before: PatchFields = { ...previous?.before };
    const carry = <K extends keyof PatchFields>(key: K) => {
      if (before[key] === undefined) before[key] = base[key];
    };
    for (const key of Object.keys(fields) as (keyof PatchFields)[]) carry(key);
    return { kind: 'patch', fields: { ...previous?.fields, ...fields }, before, done: false };
  }

  const setPending = (id: string, change: Pending | null) => {
    const next = { ...pending };
    if (change) next[id] = change;
    else delete next[id];
    pending = next;
  };

  /** Edit the board's own copy of a card the storage has not confirmed. */
  function amendCreate(id: string, fields: PatchFields) {
    creates = creates.map((item) =>
      item.entry.id === id
        ? {
            ...item,
            entry: {
              ...item.entry,
              status: fields.status ?? item.entry.status,
              order: fields.order ?? item.entry.order,
              title: fields.title ?? item.entry.title,
              due: fields.due === undefined ? item.entry.due : dueFromDay(fields.due),
              priority: fields.priority === undefined ? item.entry.priority : fields.priority,
              description: fields.description ?? item.entry.description,
              card: { ...item.entry.card, ...toCardPatch(fields, item.entry, model) },
            },
          }
        : item
    );
  }

  /** Apply a change, then report it. The card shows it either way. */
  async function change(entry: Entry, fields: PatchFields) {
    if (Object.keys(fields).length === 0) return;
    // A card the board is still holding on its own has no id the storage would
    // recognise, so there is nobody to report to yet: edit the local copy and
    // let the create carry the result. Returning the stored object from
    // `onCreate` is what ends this state.
    if (createOf(entry.id)) {
      amendCreate(entry.id, fields);
      return;
    }
    const staged = stage(entry, fields);
    setPending(entry.id, staged);
    await report(entry.id);
  }

  /**
   * How many `onUpdate` calls for a card have yet to come back. A patch is only
   * settled when the LAST of them does: marking it done while another is still
   * in flight would let the pruning decide that a field the storage has not
   * seen yet was one the owner declined to keep.
   */
  const flights = new Map<string, number>();

  /** Send whatever is pending for a card to `onUpdate`. Also the Retry path. */
  async function report(id: string) {
    const staged = patchOf(id);
    if (!staged) return;
    const source = sourceById.get(id) ?? entryById.get(id);
    if (!source) return;
    const patch = toCardPatch(staged.fields, source, model);
    // A local-only reorder (no ordering field in the data) has nothing to say.
    if (!onUpdate || Object.keys(patch).length === 0) {
      setPending(id, { ...staged, done: true, error: undefined });
      return;
    }
    setPending(id, { ...staged, done: false, error: undefined });
    flights.set(id, (flights.get(id) ?? 0) + 1);
    try {
      await onUpdate(source.cardId, patch, source.card);
      settleReport(id, undefined);
    } catch (error) {
      reportFailure(`Couldn't save "${source.title}": ${message(error)}`);
      settleReport(id, message(error));
    }
  }

  /**
   * Close the loop on a reported change. Re-reads what is pending rather than
   * writing back the copy it started with: the reader may have edited the card
   * again, or undone it entirely, while the callback was in flight.
   */
  function settleReport(id: string, error: string | undefined) {
    const latest = patchOf(id);
    if (!latest) return;
    const left = (flights.get(id) ?? 1) - 1;
    if (left > 0) {
      flights.set(id, left);
      // A failure still has to reach the card even while another call is out.
      if (error) setPending(id, { ...latest, error });
      return;
    }
    flights.delete(id);
    setPending(id, { ...latest, done: true, error });
  }

  /** `ask` is false on a retry — the reader already said yes once. */
  async function remove(entry: Entry, ask = true) {
    if (ask && confirmDelete && typeof confirm === 'function') {
      if (!confirm(`Delete "${entry.title || 'this card'}"?`)) return;
    }
    editingId = null;
    // A card the storage has not confirmed is only ours to throw away; there
    // is no id it would recognise to delete it by.
    if (createOf(entry.id)) {
      discardCreate(entry);
      return;
    }
    setPending(entry.id, { kind: 'delete', done: !onDelete });
    say(`Deleted ${entry.title}.`);
    void focusColumn(entry.status);
    if (!onDelete) return;
    const source = sourceById.get(entry.id) ?? entry;
    const settle = (error: string | undefined) => {
      // Only if the delete is still the pending change: an Undo while the
      // callback was in flight must not be quietly reversed.
      if (pending[entry.id]?.kind === 'delete') {
        setPending(entry.id, { kind: 'delete', done: true, error });
      }
    };
    try {
      await onDelete(source.cardId, source.card);
      settle(undefined);
    } catch (error) {
      reportFailure(`Couldn't delete "${entry.title}": ${message(error)}`);
      settle(message(error));
    }
  }

  /** `fallback` is the column the composer was opened in, if the form said nothing. */
  async function add(fallback: string, fields: PatchFields) {
    // The composer has its own status picker, so what it says wins over the
    // column it was opened in — otherwise the control would do nothing.
    const status = fields.status || fallback;
    const column = columns.find((entry) => entry.status.id === status);
    const others = (allColumns.find((item) => item.status.id === status)?.entries ?? []).map(
      (item) => ({ id: item.id, key: sortKeyOf(item) })
    );
    const id = nextLocalId();
    // New cards land at the top, where the composer is.
    const withPlace = { ...fields, status, order: planMove(others, 0, id).key };
    const draft = draftEntry(withPlace, model, incoming.length, id);
    const create: PendingCreate = {
      entry: draft,
      known: incoming.map((entry) => entry.id),
      done: !onCreate,
    };
    creates = [...creates, create];
    composerIn = null;
    say(`Added ${draft.title} to ${column?.status.label ?? status}.`);
    if (!onCreate) return;

    // Adoption renames the card, so the settle below has to follow it.
    let key = id;
    const settle = (update: Partial<PendingCreate>) => {
      creates = creates.map((item) => (item.entry.id === key ? { ...item, ...update } : item));
    };
    const rename = (entry: Entry) => {
      settle({ entry });
      // An editor or a dialog open on the card follows it to its new id.
      if (editingId === key) editingId = entry.id;
      if (openId === key) openId = entry.id;
      key = entry.id;
    };
    try {
      const stored = await onCreate(toCardDraft(withPlace, model));
      // Whatever the reader did to the card while the storage thought about it
      // is what should be kept — `creates` holds it, `draft` does not.
      const local = createOf(key)?.entry ?? draft;
      if (stored && typeof stored === 'object') {
        // The storage handed the whole card back: show that, not our guess.
        const [adopted] = normalizeEntries([stored as CardRecord], model);
        if (adopted) rename({ ...adopted, index: local.index, optimistic: true });
      } else if (typeof stored === 'string' || typeof stored === 'number') {
        rename({
          ...local,
          id: String(stored),
          cardId: stored,
          card: { ...local.card, [model.fields.id]: stored },
        });
      }
      settle({ done: true, error: undefined });
    } catch (error) {
      reportFailure(`Couldn't add "${draft.title}": ${message(error)}`);
      settle({ done: true, error: message(error) });
    }
  }

  /** Retry a create that failed, with everything it was given. */
  async function retryCreate(entry: Entry) {
    const create = creates.find((item) => item.entry.id === entry.id);
    if (!create) return;
    creates = creates.filter((item) => item.entry.id !== entry.id);
    await add(entry.status ?? model.statuses[0]!.id, fieldsOf(entry));
  }

  const discardCreate = (entry: Entry) => {
    creates = creates.filter((item) => item.entry.id !== entry.id);
  };

  function retry(entry: Entry) {
    failure = '';
    const current = pending[entry.id];
    if (current?.kind === 'delete') void remove(entry, false);
    else if (entry.optimistic) void retryCreate(entry);
    else void report(entry.id);
  }

  function dismiss(entry: Entry) {
    failure = '';
    if (entry.optimistic) discardCreate(entry);
    else setPending(entry.id, null);
  }

  // ── Dragging ───────────────────────────────────────────────────────────────

  interface Drag {
    mode: 'pointer' | 'keyboard';
    id: string;
    fromStatus: string;
    fromIndex: number;
    pointerId?: number;
    /** The element the pointer captured, to hand the capture back on drop. */
    card?: HTMLElement | null;
    /** Where in the card the pointer took hold, so the ghost stays under it. */
    dx: number;
    dy: number;
    width: number;
  }

  /** Where a drop would land: a column, a slot, and where to draw the line. */
  interface Target {
    status: string;
    /** Index among the column's other cards — what `planMove` takes. */
    index: number;
    /** Offset of the insertion line inside the list. */
    top: number;
  }

  /** How far a pointer must travel before it means "drag" and not "click". */
  const THRESHOLD = 4;
  /** Distance from a scroller's edge at which a drag starts scrolling it. */
  const EDGE = 56;

  let drag = $state<Drag | null>(null);
  let target = $state<Target | null>(null);
  let ghost = $state({ x: 0, y: 0 });
  /** A pointer is down on a card, but hasn't travelled far enough to be a drag. */
  let held: {
    entry: Entry;
    status: string;
    index: number;
    x: number;
    y: number;
    card: HTMLElement | null;
  } | null = null;
  let pointer = { x: 0, y: 0 };
  let scroller = $state<HTMLDivElement | undefined>();
  let listUnderPointer: HTMLElement | null = null;
  let frame = 0;

  // A drag left running when the board goes away would keep asking for frames.
  $effect(() => () => cancelAnimationFrame(frame));

  const dragEntry = $derived(drag ? entryById.get(drag.id) : undefined);

  const columnEl = (status: string): HTMLElement | null =>
    scroller?.querySelector(`[data-kanban-column="${CSS.escape(status)}"]`) ?? null;

  /**
   * Put focus back on a card's own control after the DOM around it changed.
   * A card that moves to another column is destroyed and rebuilt, so without
   * this a keyboard drop drops the reader on `document.body` too.
   */
  async function focusCard(id: string, control: '.kb-grip' | '.kb-pencil' | '.kb-title-btn') {
    await tick();
    scroller
      ?.querySelector<HTMLElement>(`[data-kanban-card][data-id="${CSS.escape(id)}"] ${control}`)
      ?.focus();
  }

  /** Where focus goes when the card it was on is gone: the column's own Add. */
  async function focusColumn(status: string | null) {
    await tick();
    (status ? columnEl(status) : scroller)?.querySelector<HTMLElement>('.kb-add')?.focus();
  }

  const listEl = (status: string): HTMLElement | null =>
    columnEl(status)?.querySelector('[data-kanban-list]') ?? null;

  const cardRects = (list: HTMLElement) =>
    Array.from(list.querySelectorAll<HTMLElement>('[data-kanban-card]')).map((card) =>
      card.getBoundingClientRect()
    );

  /** Where the insertion line goes, in the list's own coordinates. */
  function lineTop(list: HTMLElement, rects: DOMRect[], slot: number): number {
    const box = list.getBoundingClientRect();
    const local = (y: number) => y - box.top + list.scrollTop;
    if (rects.length === 0) return 6;
    const at = rects[Math.min(slot, rects.length - 1)]!;
    return slot >= rects.length ? local(at.bottom) + 3 : local(at.top) - 3;
  }

  /** Recompute the drop target from where the pointer is. */
  function aimAt(x: number, y: number) {
    if (!drag) return;
    const under = document.elementFromPoint(x, y) as HTMLElement | null;
    const column = under?.closest<HTMLElement>('[data-kanban-column]');
    const list = column?.querySelector<HTMLElement>('[data-kanban-list]');
    // Off the board entirely: keep aiming wherever it was last, so letting go
    // over the page margin does the obvious thing instead of nothing. A column
    // belonging to ANOTHER board on the same page counts as off the board —
    // its statuses are not ours to write.
    if (!column || !list || !scroller?.contains(column)) return;
    listUnderPointer = list;

    const status = column.dataset.kanbanColumn!;
    const rects = cardRects(list);
    const slot = dropIndexFor(rects, y);
    const source = status === drag.fromStatus ? drag.fromIndex : null;
    target = { status, index: toInsertIndex(slot, source), top: lineTop(list, rects, slot) };
  }

  /** Draw the line for a keyboard move, which has no pointer to measure from. */
  function aimKeyboard(status: string, index: number) {
    const list = listEl(status);
    if (!list) {
      target = { status, index, top: 6 };
      return;
    }
    const rects = cardRects(list);
    // Back from "index among the others" to a slot among the cards on screen.
    const source = drag && status === drag.fromStatus ? drag.fromIndex : null;
    const slot = source !== null && index >= source ? index + 1 : index;
    target = { status, index, top: lineTop(list, rects, slot) };
    const behavior: ScrollBehavior = matchMedia('(prefers-reduced-motion: reduce)').matches
      ? 'auto'
      : 'smooth';
    list.scrollTo({ top: Math.max(0, target.top - list.clientHeight / 2), behavior });
    columnEl(status)?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior });
  }

  function grab(event: PointerEvent, entry: Entry, status: string, index: number) {
    // Only the primary button, and never while another drag is going: a
    // right-click on a card is a context menu, not the start of a move.
    if (drag || readonly || event.button !== 0 || !event.isPrimary) return;
    held = {
      entry,
      status,
      index,
      x: event.clientX,
      y: event.clientY,
      // Remembered now: once the pointer is moving, what it is over is no
      // longer reliably the card it started on.
      card: (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-kanban-card]') ?? null,
    };
  }

  function beginDrag(event: PointerEvent) {
    if (!held) return;
    const card = held.card;
    const box = card?.getBoundingClientRect();
    // Capturing keeps the move and up events coming even when the pointer
    // leaves the window — they still bubble to the window listeners. It throws
    // for a pointer that is no longer down, which is a race worth surviving:
    // the drag still works, it just ends early if the pointer leaves.
    try {
      card?.setPointerCapture(event.pointerId);
    } catch {
      /* not capturable — carry on uncaptured */
    }
    drag = {
      mode: 'pointer',
      id: held.entry.id,
      fromStatus: held.status,
      fromIndex: held.index,
      pointerId: event.pointerId,
      card,
      dx: box ? held.x - box.left : 0,
      dy: box ? held.y - box.top : 0,
      width: box?.width ?? 240,
    };
    ghost = { x: event.clientX - drag.dx, y: event.clientY - drag.dy };
    aimAt(event.clientX, event.clientY);
    frame = requestAnimationFrame(edgeScroll);
  }

  function onPointerMove(event: PointerEvent) {
    pointer = { x: event.clientX, y: event.clientY };
    if (held && !drag) {
      // A card held down whose release never arrived — a cancelled gesture, a
      // context menu, a lost pointerup — must not become a drag the next time
      // the pointer happens to cross the board.
      if (event.buttons === 0) {
        held = null;
        return;
      }
      if (Math.hypot(event.clientX - held.x, event.clientY - held.y) < THRESHOLD) return;
      beginDrag(event);
    }
    if (!drag || drag.mode !== 'pointer') return;
    // A second finger moving is not this drag.
    if (drag.pointerId !== undefined && event.pointerId !== drag.pointerId) return;
    event.preventDefault();
    ghost = { x: event.clientX - drag.dx, y: event.clientY - drag.dy };
    aimAt(event.clientX, event.clientY);
  }

  function onPointerUp(event: PointerEvent) {
    if (!drag || drag.mode !== 'pointer') {
      held = null;
      return;
    }
    const { card, pointerId } = drag;
    if (pointerId !== undefined && event.pointerId !== pointerId) return;
    held = null;
    if (pointerId !== undefined && card?.hasPointerCapture(pointerId)) {
      card.releasePointerCapture(pointerId);
    }
    drop();
  }

  /** Nudge a scroller whose edge the drag is hovering over. */
  function edgeScroll() {
    if (!drag || drag.mode !== 'pointer') return;
    // Clamped: past the edge the distance goes negative, and an unclamped ramp
    // would scroll faster the further outside the board the pointer strays.
    const speed = (distance: number) =>
      Math.min(14, Math.max(2, Math.ceil(((EDGE - distance) / EDGE) * 14)));
    let moved = false;

    const list = listUnderPointer;
    if (list && list.scrollHeight > list.clientHeight) {
      const box = list.getBoundingClientRect();
      if (pointer.y < box.top + EDGE && list.scrollTop > 0) {
        list.scrollTop -= speed(pointer.y - box.top);
        moved = true;
      } else if (pointer.y > box.bottom - EDGE) {
        list.scrollTop += speed(box.bottom - pointer.y);
        moved = true;
      }
    }

    if (scroller && scroller.scrollWidth > scroller.clientWidth) {
      const box = scroller.getBoundingClientRect();
      if (pointer.x < box.left + EDGE && scroller.scrollLeft > 0) {
        scroller.scrollLeft -= speed(pointer.x - box.left);
        moved = true;
      } else if (pointer.x > box.right - EDGE) {
        scroller.scrollLeft += speed(box.right - pointer.x);
        moved = true;
      }
    }

    // Everything moved under the pointer, so the answer may have changed.
    if (moved) aimAt(pointer.x, pointer.y);
    frame = requestAnimationFrame(edgeScroll);
  }

  function endDrag() {
    cancelAnimationFrame(frame);
    frame = 0;
    drag = null;
    target = null;
    held = null;
    listUnderPointer = null;
  }

  /** Commit wherever the drag is aiming. */
  function drop() {
    const entry = dragEntry;
    const to = target;
    const from = drag;
    endDrag();
    if (!entry || !to || !from) return;
    if (isNoMove(from.fromStatus, from.fromIndex, to.status, to.index)) {
      say(`${entry.title} stayed where it was.`);
      return;
    }

    if (!commitMove(entry, from.fromStatus, to.status, to.index)) return;
    // The card was rebuilt in its new column, taking the focused grip with it.
    if (from.mode === 'keyboard') void focusCard(entry.id, '.kb-grip');
  }

  /**
   * Write a move: `index` is the card's place among the destination column's
   * OTHER visible cards. The one commit path for a pointer drop, a grip drop
   * and a keyboard move (moveFocusedCard). False when the status has no column.
   */
  function commitMove(entry: Entry, fromStatus: string, toStatus: string, index: number): boolean {
    const column = columns.find((item) => item.status.id === toStatus);
    // Nothing on this board answers to that status: there is no move to make.
    if (!column) return false;
    const seen = column.entries.filter((item) => item.id !== entry.id);
    const others = (allColumns.find((item) => item.status.id === toStatus)?.entries ?? [])
      .filter((item) => item.id !== entry.id)
      .map((item) => ({ id: item.id, key: sortKeyOf(item) }));
    // The reader aimed at what they could see; `planDrop` anchors that to the
    // real column, and only sends a status when the card changed column.
    const plan = planDrop(entry.id, fromStatus, toStatus, others, seen, index);

    void change(entry, plan.fields);
    // A renumbered column means every other card in it moved too.
    for (const slot of plan.reindex) {
      const other = entryById.get(slot.id);
      if (other) void change(other, { order: slot.key });
    }

    say(`${entry.title} moved to ${column.status.label}, position ${index + 1}.`);
    return true;
  }

  // ── Moving a card from the keyboard ────────────────────────────────────────

  /**
   * A live region only speaks when its text CHANGES, and two moves in a row can
   * land on the same words ("position 1 of 3" twice, at the top of a column).
   * The alternating trailing space is what makes the second one a change.
   */
  let spoken = 0;
  const say = (text: string) => (announcement = `${text}${++spoken % 2 ? '' : ' '}`);

  const columnOf = (status: string) => columns.find((item) => item.status.id === status);

  /** How many slots a column has for a card arriving from somewhere else. */
  function slots(status: string, movingId: string): number {
    const entries = columnOf(status)?.entries ?? [];
    return entries.filter((entry) => entry.id !== movingId).length;
  }

  function lift(entry: Entry, status: string, index: number) {
    if (readonly) return;
    if (drag) {
      endDrag();
      return;
    }
    drag = { mode: 'keyboard', id: entry.id, fromStatus: status, fromIndex: index, dx: 0, dy: 0, width: 0 };
    aimKeyboard(status, index);
    const label = columnOf(status)?.status.label ?? status;
    say(
      `Picked up ${entry.title}. ${label}, position ${index + 1} of ${slots(status, entry.id) + 1}. ` +
        `Arrow keys move it, space drops it, escape puts it back.`
    );
  }

  function nudge(deltaIndex: number, deltaColumn: number) {
    if (!drag || !target) return;
    const order = columns.map((column) => column.status.id);
    let { status, index } = target;
    if (deltaColumn !== 0) {
      const at = order.indexOf(status);
      const next = Math.min(Math.max(0, at + deltaColumn), order.length - 1);
      if (next === at) return;
      status = order[next]!;
      index = Math.min(index, slots(status, drag.id));
    } else {
      index = Math.min(Math.max(0, index + deltaIndex), slots(status, drag.id));
    }
    aimKeyboard(status, index);
    const label = columnOf(status)?.status.label ?? status;
    say(`${label}, position ${index + 1} of ${slots(status, drag.id) + 1}.`);
  }

  function cancelDrag() {
    const entry = dragEntry;
    const from = drag;
    endDrag();
    if (entry && from) {
      say(`Cancelled. ${entry.title} is back in ${columnOf(from.fromStatus)?.status.label ?? ''}.`);
    }
  }

  function onKeyDown(event: KeyboardEvent) {
    if (!drag || drag.mode !== 'keyboard') return;
    switch (event.key) {
      case 'ArrowUp':
        nudge(-1, 0);
        break;
      case 'ArrowDown':
        nudge(1, 0);
        break;
      case 'ArrowLeft':
        nudge(0, -1);
        break;
      case 'ArrowRight':
        nudge(0, 1);
        break;
      case ' ':
      case 'Enter':
        drop();
        break;
      case 'Escape':
        cancelDrag();
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  // ── Focusable cards (D23) ──────────────────────────────────────────────────

  /** The columns as shown: what "next card" and "move right" are measured against. */
  const shownCards = (): ColumnCards[] =>
    columns.map((column) => ({ status: column.status.id, ids: column.entries.map((entry) => entry.id) }));

  const cardEl = (id: string): HTMLElement | null =>
    scroller?.querySelector<HTMLElement>(`[data-kanban-card][data-id="${CSS.escape(id)}"]`) ?? null;

  /** The card whose dialog should hand focus back to the card itself on close. */
  let returnToCard: string | null = null;
  /** A column flashing because a key asked for its first card and it has none. */
  let flashing = $state<string | null>(null);
  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => () => clearTimeout(flashTimer));

  function focusCardEl(id: string): boolean {
    const el = cardEl(id);
    if (!el) return false;
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    return document.activeElement === el;
  }

  /** Focus a card by id once the DOM has caught up (it may just have moved). */
  async function refocusCard(id: string) {
    await tick();
    focusCardEl(id);
  }

  /** The id of the card that has keyboard focus (the card itself, not a control in it). */
  export function focusedCardId(): string | null {
    const active = typeof document === 'undefined' ? null : document.activeElement;
    if (!(active instanceof HTMLElement) || !active.matches('[data-kanban-card]')) return null;
    if (!scroller?.contains(active)) return null;
    const id = active.dataset.id ?? null;
    return id && entryById.has(id) ? id : null;
  }

  /** Focus a column's top card. An empty column flashes instead and says so; returns false. */
  export function focusFirstCard(status: string): boolean {
    const id = firstCard(shownCards(), status);
    const label = columnOf(status)?.status.label ?? status;
    if (!id) {
      clearTimeout(flashTimer);
      flashing = status;
      flashTimer = setTimeout(() => (flashing = null), 700);
      say(`${label} has no cards.`);
      return false;
    }
    return focusCardEl(id);
  }

  /** Focus the next (1) or previous (-1) card in reading order; false at either end. */
  export function focusNeighbourCard(delta: 1 | -1): boolean {
    const id = focusedCardId();
    if (!id) return false;
    const next = neighbourCard(shownCards(), id, delta);
    return next ? focusCardEl(next) : false;
  }

  /**
   * Move the focused card one place up/down, or to the top of the column to
   * its left/right (Done -> In Progress whatever its resolution). Returns
   * whether it moved; at an edge it says so instead.
   */
  export function moveFocusedCard(direction: CardDirection): boolean {
    const id = focusedCardId();
    if (!id || readonly || drag) return false;
    const entry = entryById.get(id);
    if (!entry) return false;
    const plan = planKeyboardMove(shownCards(), id, direction);
    if (!plan) {
      const edge = { up: 'at the top', down: 'at the bottom', left: 'in the first column', right: 'in the last column' };
      say(`${entry.title} is already ${edge[direction]}.`);
      return false;
    }
    if (!commitMove(entry, plan.fromStatus, plan.toStatus, plan.index)) return false;
    void refocusCard(id);
    return true;
  }

  /** Open the focused card's dialog with its editor showing (the "edit modal"). */
  export function editFocusedCard(): boolean {
    const id = focusedCardId();
    const entry = id ? entryById.get(id) : undefined;
    if (!entry || readonly || !editable) return false;
    show(entry);
    returnToCard = entry.id;
    // The editor a tick later, from an unfocused page: the dialog focuses
    // itself as it mounts, and Svelte's `autofocus` (CardForm's title) only
    // takes focus from <body> — as it does when the dialog's Edit button,
    // clicked, goes away.
    void tick().then(() => {
      if (openId !== entry.id) return;
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      openEditing = true;
    });
    return true;
  }

  /** Enter on a focused card: its dialog, focus coming back to the card after. */
  function openFromCard(entry: Entry) {
    open(entry);
    if (openId === entry.id) returnToCard = entry.id;
  }

  /** What a column head's badges say it answers to (planee's keymap ids). */
  const columnKeybinds = (status: string) => `column.${status}.new column.${status}.focus`;
  const CARD_KEYBINDS = 'card.edit card.up@top card.down@bottom card.left@left card.right@right';

  /** The insertion line for a column, when the drag is aiming at it. */
  const lineIn = (status: string) => (drag && target?.status === status ? target : null);

  /**
   * A board that turns read-only mid-edit (a version completed on another
   * device, say) drops whatever it was in the middle of: nothing it could save.
   */
  $effect(() => {
    if (!readonly) return;
    editingId = null;
    composerIn = null;
    openEditing = false;
    if (drag) endDrag();
  });

  const startComposer = (status: string) => {
    editingId = null;
    composerIn = status;
  };

  // ── The card, in full ──────────────────────────────────────────────────────

  /** The entry the dialog is showing, or nothing when it is closed. */
  const openEntry = $derived(openId ? entryById.get(openId) : undefined);

  /**
   * A card that has gone — deleted here, or dropped upstream — takes its dialog
   * with it. Without this the dialog would sit there holding an id nothing
   * answers to.
   */
  $effect(() => {
    if (openId && !openEntry) close();
  });

  function open(entry: Entry) {
    onCardClick?.(entry.card, entry);
    if (!preview) return;
    show(entry);
  }

  function show(entry: Entry) {
    // The card behind the dialog stops editing: two editors on one card would
    // fight over the focus and over which one's Save wins.
    editingId = null;
    composerIn = null;
    openEditing = false;
    returnToCard = null;
    openId = entry.id;
    onDialogOpen?.(entry.card);
  }

  function close() {
    const id = openId;
    const card = id ? (entryById.get(id)?.card ?? lastOpenCard) : undefined;
    openId = null;
    openEditing = false;
    const toCard = returnToCard === id;
    returnToCard = null;
    // Back to where the reader was: the title that opened it, or the card
    // itself when it was opened from the keyboard on a focused card.
    if (id) {
      if (toCard) void refocusCard(id);
      else void focusCard(id, '.kb-title-btn');
      onDialogClose?.(card);
    }
  }

  /** The open card as last seen, for `onDialogClose` when the card itself is gone. */
  let lastOpenCard: CardRecord | undefined;
  $effect(() => {
    if (openEntry) lastOpenCard = openEntry.card;
  });

  /** The `openCardId` value already acted on (see the prop). */
  let appliedOpenCardId: string | null = null;
  $effect(() => {
    const wanted = openCardId === null || openCardId === undefined ? null : String(openCardId);
    if (wanted === null) {
      appliedOpenCardId = null;
      return;
    }
    if (wanted === appliedOpenCardId) return;
    const entry = entryById.get(wanted);
    // Not on the board (yet): wait for `cards` to bring it.
    if (!entry || !preview) return;
    appliedOpenCardId = wanted;
    if (openId !== wanted) show(entry);
  });
</script>

<svelte:window
  onpointermove={onPointerMove}
  onpointerup={onPointerUp}
  onpointercancel={(event) => {
    if (drag?.mode === 'pointer' && drag.pointerId !== undefined) {
      if (event.pointerId !== drag.pointerId) return;
      endDrag();
      return;
    }
    held = null;
  }}
  onkeydown={onKeyDown}
/>

<div class="kb" class:dense class:dragging={!!drag}>
  {#if searchable || busy || failure}
    <div class="row kb-toolbar">
      {#if searchable}
        <label class="kb-search">
          <span class="visually-hidden">Search cards</span>
          <input type="search" placeholder="Search cards…" bind:value={search} />
        </label>
        {#if hidden > 0}
          <span class="muted small">{hidden} hidden by the search</span>
        {/if}
      {/if}
      <span class="kb-count muted small">
        {#if busy}<span class="kb-busy" aria-hidden="true"></span>{/if}
        {view.length}
        {view.length === 1 ? 'card' : 'cards'}
      </span>
    </div>
  {/if}

  {#if failure}
    <p class="banner banner-danger kb-failure">
      {failure}
      <button type="button" class="btn btn-sm" onclick={() => (failure = '')}>Dismiss</button>
    </p>
  {/if}

  <div class="kb-columns" bind:this={scroller} style={`--kb-col: ${columnWidth}`}>
    {#each columns as column (column.status.id)}
      {@const line = lineIn(column.status.id)}
      <section
        class="kb-column"
        class:aiming={!!line}
        class:flash={flashing === column.status.id}
        data-kanban-column={column.status.id}
        aria-labelledby={`${uid}-${column.status.id}`}
      >
        <header class="kb-column-head" data-keybind={keyboard ? columnKeybinds(column.status.id) : undefined}>
          <svelte:element this={`h${headingLevel}`} id={`${uid}-${column.status.id}`}>
            {column.status.label}
          </svelte:element>
          <span
            class="kb-tally"
            class:over={column.over}
            title={column.status.limit
              ? `${column.entries.length} of a ${column.status.limit}-card limit`
              : undefined}
          >
            {column.entries.length}{column.status.limit ? `/${column.status.limit}` : ''}
            <!-- The amber is a hint; the word is what carries. -->
            {#if column.over}<span class="visually-hidden"> — over the limit</span>{/if}
          </span>
          {#if addable && !readonly}
            <button
              type="button"
              class="kb-add"
              title={`Add a card to ${column.status.label}`}
              aria-label={`Add a card to ${column.status.label}`}
              onclick={() => startComposer(column.status.id)}
            >
              <span aria-hidden="true">＋</span>
            </button>
          {/if}
        </header>

        <!-- Focusable when read-only, so a keyboard can still scroll a long column. -->
        <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
        <ul
          class="kb-list"
          data-kanban-list
          tabindex={readonly ? 0 : undefined}
          style={columnHeight === 'auto' ? undefined : `max-height: ${columnHeight}`}
        >
          {#if line}
            <!-- Absolutely placed, so nothing on the board reflows while a card
                 is in the air and the target can't flicker between two slots. -->
            <li class="kb-line" style={`top: ${line.top}px`} aria-hidden="true"></li>
          {/if}

          {#if composerIn === column.status.id}
            <li class="kb-composer">
              <CardForm
                {model}
                mode="create"
                fields={{
                  priority: null,
                  due: null,
                  ...createDefaults,
                  status: column.status.id,
                }}
                {formFields}
                onSave={(fields) => add(column.status.id, fields)}
                onCancel={() => (composerIn = null)}
              />
            </li>
          {/if}

          {#each column.entries as entry, index (entry.id)}
            <KanbanCard
              {entry}
              {model}
              {index}
              {locale}
              {now}
              {soonDays}
              {markdown}
              {descriptionLines}
              headingLevel={headingLevel + 1}
              editable={editable && !readonly}
              deletable={deletable && !readonly}
              editing={editingId === entry.id}
              dragging={drag?.id === entry.id}
              lifted={drag?.mode === 'keyboard' && drag.id === entry.id}
              busy={isBusy(entry.id)}
              error={errorOf(entry.id)}
              onEdit={() => {
                composerIn = null;
                editingId = entry.id;
              }}
              onCancelEdit={() => {
                editingId = null;
                void focusCard(entry.id, '.kb-pencil');
              }}
              onSave={(changed) => {
                editingId = null;
                void change(entry, changed);
                void focusCard(entry.id, '.kb-pencil');
              }}
              onDelete={() => remove(entry)}
              onGrab={readonly
                ? undefined
                : (event) => grab(event, entry, column.status.id, index)}
              onLift={() => lift(entry, column.status.id, index)}
              onLiftCancel={cancelDrag}
              onRetry={errorOf(entry.id) || entry.optimistic ? () => retry(entry) : undefined}
              onDismiss={errorOf(entry.id) || entry.optimistic ? () => dismiss(entry) : undefined}
              onOpen={preview || onCardClick ? () => open(entry) : undefined}
              {formFields}
              badges={cardBadges}
              {resolveImage}
              {previewNonce}
              focusable={keyboard}
              keybinds={keyboard ? CARD_KEYBINDS : undefined}
              onEnter={preview || onCardClick ? () => openFromCard(entry) : undefined}
            />
          {/each}

          {#if column.entries.length === 0 && composerIn !== column.status.id}
            <li class="kb-empty muted small">{empty}</li>
          {/if}
        </ul>
      </section>
    {/each}
  </div>

  <!-- Every drag step, for a reader who is listening rather than looking. -->
  <div class="visually-hidden" aria-live="assertive" aria-atomic="true">{announcement}</div>
</div>

{#if drag?.mode === 'pointer' && dragEntry}
  <div
    class="kb-ghost"
    style={`transform: translate(${ghost.x}px, ${ghost.y}px); width: ${drag.width}px`}
    aria-hidden="true"
  >
    <ul class="kb-ghost-list">
      <KanbanCard entry={dragEntry} {model} index={0} {locale} {now} {soonDays} ghost />
    </ul>
  </div>
{/if}

{#if openEntry}
  <!-- The card in full. Outside the board's own box, because a dialog belongs
       to the page rather than to the column its card happens to sit in. -->
  <CardDialog
    entry={openEntry}
    {model}
    {locale}
    {now}
    {soonDays}
    {markdown}
    editable={editable && !readonly}
    deletable={deletable && !readonly}
    editing={openEditing}
    busy={isBusy(openEntry.id)}
    error={errorOf(openEntry.id)}
    onEdit={() => (openEditing = true)}
    onCancelEdit={() => (openEditing = false)}
    onSave={(changed) => {
      openEditing = false;
      void change(openEntry, changed);
    }}
    onDelete={() => remove(openEntry)}
    onRetry={errorOf(openEntry.id) ? () => retry(openEntry) : undefined}
    onDismiss={errorOf(openEntry.id) ? () => dismiss(openEntry) : undefined}
    onClose={close}
    {formFields}
    badges={cardBadges}
    body={dialogBody}
    actions={dialogActions}
    {resolveImage}
    {previewNonce}
  />
{/if}

<style>
  .kb {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .kb.dragging {
    /* A drag must not turn into a text selection halfway across a card. */
    user-select: none;
    cursor: grabbing;
  }

  .kb-toolbar {
    gap: var(--space-2);
  }

  .kb-search {
    margin: 0;
  }

  .kb-search input {
    width: auto;
    min-width: 12rem;
    padding: var(--space-1) var(--space-3);
    font-size: var(--font-size-sm);
  }

  .kb-count {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    white-space: nowrap;
  }

  .kb-busy {
    width: 0.7em;
    height: 0.7em;
    border: 2px solid var(--border-color);
    border-top-color: var(--color-primary);
    border-radius: var(--radius-full);
    animation: kb-spin 0.7s linear infinite;
  }

  @keyframes kb-spin {
    to {
      transform: rotate(360deg);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .kb-busy {
      animation-duration: 3s;
    }
  }

  .kb-failure {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    flex-wrap: wrap;
    margin: 0;
  }

  .kb-columns {
    display: grid;
    grid-auto-flow: column;
    grid-auto-columns: minmax(var(--kb-col, 19rem), 1fr);
    gap: var(--space-3);
    overflow-x: auto;
    padding-bottom: var(--space-2);
  }

  .kb-column {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-2);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-lg);
    background: var(--surface-raised-color);
    min-width: 0;
  }

  .kb-column.aiming {
    border-color: var(--color-primary);
  }

  /* A key asked for this column's first card and it has none. */
  .kb-column.flash {
    animation: kb-flash 0.7s ease-out;
  }

  @keyframes kb-flash {
    0%,
    40% {
      border-color: var(--color-warning);
      box-shadow: 0 0 0 3px var(--color-warning-soft);
    }
    100% {
      box-shadow: 0 0 0 0 transparent;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .kb-column.flash {
      animation: none;
      border-color: var(--color-warning);
    }
  }

  .kb-column-head {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: 0 var(--space-1);
  }

  .kb-column-head :global(:is(h1, h2, h3, h4, h5, h6)) {
    flex: 1;
    min-width: 0;
    margin: 0;
    font-size: var(--font-size-base);
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted-color);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .kb-tally {
    font-size: var(--font-size-sm);
    font-variant-numeric: tabular-nums;
    color: var(--text-muted-color);
    padding: 0 var(--space-2);
    border-radius: var(--radius-full);
    background: var(--surface-color);
  }

  /* Past its WIP limit — the count says so rather than the board refusing. */
  .kb-tally.over {
    color: var(--color-warning);
    background: var(--color-warning-soft);
    font-weight: 700;
  }

  .kb-add {
    background: none;
    border: none;
    padding: 0 var(--space-1);
    font-size: var(--font-size-lg);
    line-height: 1;
    color: var(--text-muted-color);
    cursor: pointer;
    border-radius: var(--radius-sm);
  }

  .kb-add:hover {
    color: var(--color-primary-strong);
    background: var(--color-primary-soft);
  }

  .kb-list {
    position: relative;
    list-style: none;
    margin: 0;
    padding: var(--space-1);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    overflow-y: auto;
    /* Room to aim at, so an empty column is still somewhere to drop. */
    min-height: 4rem;
    /* Grow to the height of the tallest column, up to `columnHeight`: the
       columns line up, and a short one is still a target across its whole
       height rather than only where its cards happen to reach. */
    flex: 1;
  }

  .kb-line {
    position: absolute;
    left: var(--space-1);
    right: var(--space-1);
    height: 3px;
    border-radius: var(--radius-full);
    background: var(--color-primary);
    box-shadow: 0 0 0 3px var(--color-primary-soft);
  }

  .kb-composer {
    list-style: none;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--color-primary);
    border-radius: var(--radius-md);
    background: var(--surface-color);
  }

  .kb-empty {
    list-style: none;
    padding: var(--space-4) var(--space-2);
    border: 1px dashed var(--border-color);
    border-radius: var(--radius-md);
    text-align: center;
  }

  /* The card under the pointer. It sits above everything and is deliberately
     transparent to hit-testing, so what is UNDER it is what gets aimed at. */
  .kb-ghost {
    position: fixed;
    top: 0;
    left: 0;
    z-index: 60;
    pointer-events: none;
  }

  .kb-ghost-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .dense .kb-list {
    gap: var(--space-1);
  }

  .muted {
    color: var(--text-muted-color);
  }

  .small {
    font-size: var(--font-size-sm);
  }

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
  }
</style>
