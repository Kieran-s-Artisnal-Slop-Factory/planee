// Ported from retoken (af25bc6)
/**
 * The board model: everything KanbanBoard does to data, as plain functions.
 *
 * Three jobs live here, and none of them touches the DOM or Svelte:
 *
 *  1. **Reading cards.** `normalizeEntries` turns the caller's objects into
 *     `Entry` records using the model from `types.ts` — canonical status and
 *     priority ids, a parsed due date, a sort key — while keeping the original
 *     object untouched for the callbacks to hand back.
 *
 *  2. **Moving cards.** Positions are fractional sort keys, so a drop between
 *     two cards is one number: the midpoint. `planMove` computes it, and falls
 *     back to renumbering the destination when the gap gets too small to split
 *     (which is also what happens when two cards share an order value).
 *
 *  3. **Optimistic updates.** The board applies a move or an edit immediately
 *     and reports it through a callback, so it works whether or not the caller
 *     feeds the change back through `cards`. `prunePending` is what keeps the
 *     two honest: a pending field is dropped once the source agrees with it,
 *     and also when the source has moved on its own — the source wins, and a
 *     caller who simply doesn't persist that field keeps the local value.
 *
 * Reading and writing the due dates themselves lives next door, in `dates.ts`.
 *
 * Pure and unit-tested (board.test.ts).
 */
import { dueFromDay, parseDue, writeDue, type Due } from './dates';
import {
  foldValue,
  priorityById,
  resolvePriority,
  resolveStatus,
  statusById,
  type CardRecord,
  type FieldRole,
  type KanbanModel,
  type Status,
} from './types';

/** One card, normalized. The caller's object rides along untouched. */
export interface Entry {
  /** Unique within the board. Deduplicated, so an `{#each}` key is safe. */
  id: string;
  /** The id as your data spells it — what the callbacks report. */
  cardId: unknown;
  /** Position in the source array, and the fallback sort key. */
  index: number;
  title: string;
  /** Canonical status id, or null when no column claims the value. */
  status: string | null;
  due: Due | null;
  /** Canonical priority id, or null for "no priority set". */
  priority: string | null;
  description: string;
  /** The ordering field, when it holds a number. */
  order: number | undefined;
  card: CardRecord;
  /** True when the card had no id and its position stood in for one. */
  synthetic: boolean;
  /** True for a card the board added and the storage hasn't confirmed. */
  optimistic?: boolean;
}

const asText = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return '';
  return String(value);
};

/**
 * Read the caller's cards into entries. Ids are deduplicated so an `{#each}`
 * key can never collide; a card with no id at all borrows its array position,
 * which is only as stable as the array — give your cards ids.
 */
export function normalizeEntries(cards: readonly CardRecord[], model: KanbanModel): Entry[] {
  const { fields, statuses, priorities } = model;
  const seen = new Set<string>();
  return cards.map((card, index) => {
    const source: CardRecord = card && typeof card === 'object' ? card : {};
    const rawId = source[fields.id];
    const synthetic = rawId === null || rawId === undefined || rawId === '';
    let id = synthetic ? `row-${index}` : String(rawId);
    if (seen.has(id)) {
      // Duplicate ids mean an update can't say which card it meant, but the
      // board still has to render; the copies get their own keys.
      let n = 2;
      while (seen.has(`${id}~${n}`)) n += 1;
      id = `${id}~${n}`;
    }
    seen.add(id);

    const rawOrder = source[fields.order];
    const order =
      typeof rawOrder === 'number' && Number.isFinite(rawOrder)
        ? rawOrder
        : typeof rawOrder === 'string' && rawOrder.trim() !== '' && Number.isFinite(Number(rawOrder))
          ? Number(rawOrder)
          : undefined;

    return {
      id,
      cardId: synthetic ? id : rawId,
      index,
      title: asText(source[fields.title]),
      status: resolveStatus(source[fields.status], statuses),
      due: parseDue(source[fields.due]),
      priority: resolvePriority(source[fields.priority], priorities),
      description: asText(source[fields.description]),
      order,
      card: source,
      synthetic,
    };
  });
}

/**
 * A card's place in its column. The ordering field when there is one, the
 * array position when there isn't — a half-filled order field mixes the two
 * scales, which is the one case where the result is only as sane as the data.
 */
export const sortKeyOf = (entry: Entry): number =>
  typeof entry.order === 'number' ? entry.order : entry.index;

/** Fields a pending change can carry, in the board's own vocabulary. */
export interface PatchFields {
  status?: string;
  order?: number;
  title?: string;
  /** `YYYY-MM-DD`, or null to clear the date. */
  due?: string | null;
  priority?: string | null;
  description?: string;
}

export interface PendingPatch {
  kind: 'patch';
  fields: PatchFields;
  /** What those fields held when the change was made. */
  before: PatchFields;
  /** True once the callback has resolved (or there was no callback). */
  done: boolean;
  /** Set when the callback rejected, to show the card as failed. */
  error?: string;
}

export interface PendingDelete {
  kind: 'delete';
  done: boolean;
  error?: string;
}

export type Pending = PendingPatch | PendingDelete;

/** A card the board added optimistically, waiting to be confirmed. */
export interface PendingCreate {
  entry: Entry;
  /** The ids that existed when it was added, to spot the stored copy. */
  known: string[];
  done: boolean;
  error?: string;
}

/** An entry's current values, in the same vocabulary a patch uses. */
export const fieldsOf = (entry: Entry): Required<PatchFields> => ({
  status: entry.status ?? '',
  order: sortKeyOf(entry),
  title: entry.title,
  due: entry.due?.day ?? null,
  priority: entry.priority,
  description: entry.description,
});

const FIELD_KEYS: (keyof PatchFields)[] = [
  'status',
  'order',
  'title',
  'due',
  'priority',
  'description',
];

/**
 * The fields `after` actually changes. What the card editor reports, so a
 * caller storing a patch is never handed fields nobody touched — and an edit
 * that changed nothing reports nothing.
 */
export function diffFields(before: PatchFields, after: PatchFields): PatchFields {
  const out: PatchFields = {};
  const take = <K extends keyof PatchFields>(key: K) => {
    out[key] = after[key];
  };
  const clearable = (key: keyof PatchFields) => key === 'due' || key === 'priority';
  for (const key of FIELD_KEYS) {
    if (after[key] === undefined) continue;
    // `before` may simply not mention a field. For the two that can be
    // cleared, not mentioned means not set, which is null rather than unknown.
    const was = before[key] === undefined && clearable(key) ? null : before[key];
    if (after[key] !== was) take(key);
  }
  return out;
}

/**
 * Overlay the pending changes on the source entries.
 *
 * A card the board added is dropped as soon as the source has one with the
 * same id: between the storage handing an id back and the pruning that clears
 * the local copy, showing both would put the same key on screen twice.
 */
export function applyPending(
  entries: readonly Entry[],
  pending: Readonly<Record<string, Pending>>,
  creates: readonly PendingCreate[] = []
): Entry[] {
  const out: Entry[] = [];
  for (const entry of entries) {
    const change = pending[entry.id];
    // A delete that FAILED brings its card back, marked: hiding a card whose
    // deletion was refused would lose it with nothing left to retry from.
    if (change?.kind === 'delete' && !change.error) continue;
    if (change?.kind !== 'patch') {
      out.push(entry);
      continue;
    }
    const { fields } = change;
    out.push({
      ...entry,
      status: fields.status ?? entry.status,
      order: fields.order ?? entry.order,
      title: fields.title ?? entry.title,
      due: fields.due === undefined ? entry.due : dueFromDay(fields.due),
      priority: fields.priority === undefined ? entry.priority : fields.priority,
      description: fields.description ?? entry.description,
    });
  }
  const known = new Set(out.map((entry) => entry.id));
  for (const create of creates) {
    // …and two creates that have adopted the same id are still one card.
    if (known.has(create.entry.id)) continue;
    known.add(create.entry.id);
    out.push(create.entry);
  }
  return out;
}

export interface PruneResult {
  pending: Record<string, Pending>;
  creates: PendingCreate[];
  changed: boolean;
}

/**
 * Drop the pending changes the source has caught up with.
 *
 * Per field, once the callback has resolved:
 *  - the source matches what we asked for → done, drop it;
 *  - the source holds something else, and it isn't what it held before → the
 *    owner changed it themselves, so the owner wins: drop it;
 *  - the source still holds the old value → the owner didn't persist this
 *    field, so keep showing ours.
 *
 * The ordering field is the exception: with no ordering field in the data there
 * is nothing to compare against, so a local position is kept for good.
 */
export function prunePending(
  entries: readonly Entry[],
  pending: Readonly<Record<string, Pending>>,
  creates: readonly PendingCreate[],
  model: KanbanModel
): PruneResult {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const next: Record<string, Pending> = {};
  let changed = false;

  for (const [id, change] of Object.entries(pending)) {
    const entry = byId.get(id);

    if (change.kind === 'delete') {
      // Gone from the source: the delete landed.
      if (!entry) {
        changed = true;
        continue;
      }
      next[id] = change;
      continue;
    }

    if (!entry) {
      // The card it patched is gone; there is nothing left to overlay.
      changed = true;
      continue;
    }
    if (!change.done || change.error) {
      next[id] = change;
      continue;
    }

    const current = fieldsOf(entry);
    const fields: PatchFields = {};
    const before: PatchFields = {};
    let kept = 0;
    const keep = <K extends keyof PatchFields>(key: K) => {
      fields[key] = change.fields[key];
      before[key] = change.before[key];
      kept += 1;
    };
    for (const key of FIELD_KEYS) {
      if (change.fields[key] === undefined) continue;
      // With no ordering field in the data there is nothing to compare a
      // position against, so the local one is kept for good.
      if (key === 'order' && !model.hasOrder) {
        keep('order');
        continue;
      }
      const settled = current[key] === change.fields[key];
      const movedOn = current[key] !== change.before[key];
      if (settled || movedOn) continue;
      keep(key);
    }
    if (kept === 0) {
      changed = true;
      continue;
    }
    if (kept !== Object.keys(change.fields).length) {
      changed = true;
      next[id] = { ...change, fields, before };
    } else {
      next[id] = change;
    }
  }

  const knownIds = new Set(byId.keys());
  const keptCreates = creates.filter((create) => {
    // The storage handed back an id and the card came round: ours is redundant.
    if (knownIds.has(create.entry.id)) return false;
    if (!create.done || create.error) return true;
    // No id came back, so match the one new card carrying the same title. It
    // is a guess, which is why `onCreate` returning the stored object is the
    // documented way to make this exact.
    const known = new Set(create.known);
    const title = foldValue(create.entry.title);
    return !entries.some((entry) => !known.has(entry.id) && foldValue(entry.title) === title);
  });
  if (keptCreates.length !== creates.length) changed = true;

  return { pending: next, creates: keptCreates, changed };
}

/** One column of the board. */
export interface BoardColumn {
  status: Status;
  entries: Entry[];
  /** True when a WIP limit is set and the column is past it. */
  over: boolean;
}

/**
 * Group entries into columns and order each one. A status no column claims
 * lands in the first column — the card stays visible and keeps its own value
 * until someone moves it, which is the only point a write would change it.
 */
export function columnsOf(entries: readonly Entry[], model: KanbanModel): BoardColumn[] {
  const columns = model.statuses.map((status) => ({ status, entries: [] as Entry[], over: false }));
  const byId = new Map(columns.map((column) => [column.status.id, column]));
  for (const entry of entries) {
    const column = (entry.status && byId.get(entry.status)) || columns[0];
    column?.entries.push(entry);
  }
  for (const column of columns) {
    column.entries.sort((a, b) => sortKeyOf(a) - sortKeyOf(b) || a.index - b.index);
    column.over = column.status.limit !== undefined && column.entries.length > column.status.limit;
  }
  return columns;
}

/** Cards whose title or description contains the term. Blank term matches all. */
export function filterEntries(entries: readonly Entry[], term: string): Entry[] {
  const needle = term.trim().toLowerCase();
  if (!needle) return [...entries];
  return entries.filter(
    (entry) =>
      entry.title.toLowerCase().includes(needle) ||
      entry.description.toLowerCase().includes(needle)
  );
}

/** A card's place in a column, as a sort key and its neighbours. */
export interface Slot {
  id: string;
  key: number;
}

export interface MovePlan {
  /** The moving card's new sort key. */
  key: number;
  /**
   * Set when the gap between neighbours was too small to split (or they shared
   * a key): the whole destination column renumbered, in order, moved card
   * included. Empty when the midpoint worked, which is almost always.
   */
  reindex: Slot[];
}

/**
 * The smallest gap worth halving. Doubles hold about 15 significant digits, so
 * this leaves a wide margin before a midpoint would land on a neighbour.
 */
const MIN_GAP = 1e-6;

/**
 * Where a card dropped at `toIndex` belongs, as a sort key.
 *
 * `others` is the destination column in order, WITHOUT the moving card, so
 * `toIndex` is simply the position it will take among them.
 */
export function planMove(
  others: readonly Slot[],
  toIndex: number,
  movingId: string
): MovePlan {
  const at = Math.min(Math.max(0, Math.trunc(toIndex)), others.length);
  const before = at > 0 ? others[at - 1]?.key : undefined;
  const after = at < others.length ? others[at]?.key : undefined;

  if (before !== undefined && after !== undefined) {
    const gap = after - before;
    if (gap > MIN_GAP) return { key: before + gap / 2, reindex: [] };
    // No room between them: renumber the column and place the card by index.
    const full = [...others.slice(0, at), { id: movingId, key: 0 }, ...others.slice(at)];
    const reindex = full.map((slot, index) => ({ id: slot.id, key: index }));
    return { key: at, reindex };
  }
  if (before !== undefined) return { key: before + 1, reindex: [] };
  if (after !== undefined) return { key: after - 1, reindex: [] };
  return { key: 0, reindex: [] };
}

/**
 * Which slot a pointer at `y` is over, given the cards' rectangles in visual
 * order: the number of cards whose middle is above it. Cards are measured
 * where they actually sit — the board marks the insertion point with a line
 * rather than opening a gap, so nothing reflows mid-drag and this can't
 * oscillate between two answers.
 */
export function dropIndexFor(
  rects: readonly { top: number; height: number }[],
  y: number
): number {
  let index = 0;
  for (const rect of rects) {
    if (y > rect.top + rect.height / 2) index += 1;
    else break;
  }
  return index;
}

/**
 * Convert a slot index measured over ALL the column's cards into an index
 * among the others, which is what `planMove` wants. The dragged card still
 * occupies its slot while it is being dragged, so every position past it is
 * one too high.
 */
export const toInsertIndex = (dropIndex: number, sourceIndex: number | null): number =>
  sourceIndex !== null && dropIndex > sourceIndex ? dropIndex - 1 : dropIndex;

/**
 * Turn a position among the cards a SEARCH left on screen into a position among
 * all of the column's cards, by anchoring to the visible card the drop landed
 * after.
 *
 * Without this, a drop made while filtering would take its sort key from
 * neighbours that are only some of the real ones — and a renumber would
 * renumber the visible cards on top of the hidden ones' keys. "After the card
 * I can see" is the only thing the reader actually asked for, and it is exactly
 * what an anchor preserves.
 */
export function anchorIndex(
  all: readonly { id: string }[],
  visible: readonly { id: string }[],
  index: number
): number {
  if (all.length === visible.length) return index;
  const before = index > 0 ? visible[index - 1] : undefined;
  if (before) {
    const at = all.findIndex((item) => item.id === before.id);
    if (at >= 0) return at + 1;
  }
  const after = visible[0];
  if (after) {
    const at = all.findIndex((item) => item.id === after.id);
    if (at >= 0) return at;
  }
  // The search left nothing in this column to aim relative to; the end is the
  // only position that can't be wrong about a card nobody can see.
  return all.length;
}

/** Whether a drop would leave the card exactly where it already is. */
export const isNoMove = (
  fromStatus: string | null,
  fromIndex: number,
  toStatus: string,
  insertIndex: number
): boolean => fromStatus === toStatus && insertIndex === fromIndex;

export interface DropPlan {
  /** What the moved card writes: always `order`, and `status` only across columns. */
  fields: PatchFields;
  /** The OTHER cards a renumber moved, with their new keys. Usually empty. */
  reindex: Slot[];
}

/**
 * What a drop writes.
 *
 * `status` is sent only when the card changes COLUMN — compared against the
 * column it was dragged out of, never against the card's own value. A column
 * can claim several spellings (planee's Done claims `wontfix`, `out_of_scope`
 * and `bumped`), and a reorder inside it must not rewrite any of them to the
 * column's own value. The same goes for a card no column claims, which sits in
 * the first column until someone actually moves it somewhere else.
 *
 * `others` is the destination column in order, without the moving card and
 * with nothing filtered out; `visible` is what the search left on screen, which
 * is what `index` was measured against.
 */
export function planDrop(
  movingId: string,
  fromStatus: string,
  toStatus: string,
  others: readonly Slot[],
  visible: readonly { id: string }[],
  index: number
): DropPlan {
  const plan = planMove(others, anchorIndex(others, visible, index), movingId);
  const fields: PatchFields = { order: plan.key };
  if (fromStatus !== toStatus) fields.status = toStatus;
  return { fields, reindex: plan.reindex.filter((slot) => slot.id !== movingId) };
}

/** The card editor's fields, in the order it lays them out. */
export const FORM_FIELDS: readonly FieldRole[] = ['title', 'status', 'due', 'priority', 'description'];

/**
 * The values a card editor opens with. A status no column claims comes through
 * as `''` and has to show as a real column in the select — and the editor
 * measures "changed" against THIS, so saving a title does not quietly move an
 * unclaimed card into the first column.
 */
export function formStart(fields: PatchFields, model: KanbanModel): PatchFields {
  return { ...fields, status: fields.status || model.statuses[0]?.id || '' };
}

/**
 * What a card editor reports on save. Only the fields it shows are reported at
 * all; adding reports every one of them, editing only the ones that changed
 * from `opened` (which should come from `formStart`).
 */
export function formResult(
  mode: 'edit' | 'create',
  opened: PatchFields,
  current: PatchFields,
  shown: readonly FieldRole[] = FORM_FIELDS
): PatchFields {
  const picked: PatchFields = {};
  for (const key of FIELD_KEYS) {
    // The title is what makes a card findable, so it is always part of the form.
    if (key !== 'title' && !shown.includes(key)) continue;
    if (current[key] !== undefined) (picked as Record<string, unknown>)[key] = current[key];
  }
  return mode === 'create' ? picked : diffFields(opened, picked);
}

/** Translate board fields into a patch in the caller's own keys and values. */
export function toCardPatch(fields: PatchFields, entry: Entry, model: KanbanModel): CardRecord {
  const patch: CardRecord = {};
  const keys = model.fields;
  if (fields.status !== undefined) {
    patch[keys.status] = statusById(fields.status, model.statuses)?.value ?? fields.status;
  }
  if (fields.title !== undefined) patch[keys.title] = fields.title;
  if (fields.description !== undefined) patch[keys.description] = fields.description;
  if (fields.priority !== undefined) {
    patch[keys.priority] =
      fields.priority === null
        ? null
        : (priorityById(fields.priority, model.priorities)?.value ?? fields.priority);
  }
  if (fields.due !== undefined) {
    patch[keys.due] = writeDue(fields.due, entry.card[keys.due], model.dueFormat);
  }
  // No ordering field means no place to put a position; the board keeps it.
  if (fields.order !== undefined && model.hasOrder) patch[keys.order] = fields.order;
  return patch;
}

/** The same translation for a brand-new card, which has no object behind it. */
export function toCardDraft(fields: PatchFields, model: KanbanModel): CardRecord {
  const stub: Entry = {
    id: '',
    cardId: undefined,
    index: 0,
    title: '',
    status: null,
    due: null,
    priority: null,
    description: '',
    order: undefined,
    card: {},
    synthetic: true,
  };
  return toCardPatch(fields, stub, model);
}

let counter = 0;

/** A local id for a card the board just made, before storage names it. */
export const nextLocalId = (prefix = 'new'): string => `${prefix}-${++counter}`;

/** Build the optimistic entry for a card the reader just added. */
export function draftEntry(
  fields: PatchFields,
  model: KanbanModel,
  index: number,
  id: string = nextLocalId()
): Entry {
  const card = toCardDraft(fields, model);
  return {
    id,
    cardId: id,
    index,
    title: fields.title ?? '',
    status: fields.status ?? model.statuses[0]?.id ?? null,
    due: dueFromDay(fields.due ?? null),
    priority: fields.priority ?? null,
    description: fields.description ?? '',
    order: fields.order,
    card: { ...card, [model.fields.id]: id },
    synthetic: false,
    optimistic: true,
  };
}
