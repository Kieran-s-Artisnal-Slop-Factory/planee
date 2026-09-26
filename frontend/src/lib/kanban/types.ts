// Ported from retoken (af25bc6)
/**
 * The data-shape vocabulary KanbanBoard is driven by.
 *
 * A board is handed a list of your own objects and a schema saying which of
 * their keys plays which part on a card:
 *
 *   { headline: 'title', state: 'status', deadline: 'due', urgency: 'priority' }
 *
 * — your key to the role it fills, which is the same shape DataTable's schema
 * has (`{ column: type }`), read the same way round. Where a role needs more
 * than a name (its own vocabulary, a label, a WIP limit, a date format) the
 * value becomes an object instead, and the two forms mix freely:
 *
 *   { state: { role: 'status', options: ['Backlog', 'Doing', 'Shipped'] } }
 *
 * Roles the board doesn't know are ignored rather than guessed at, and roles
 * you don't name fall back to the obvious key spellings — `title`/`name`,
 * `status`/`state`, `dueDate`/`due_date`/`due`, `priority`, and
 * `description`/`body`/`notes` — picked from the keys your data actually has.
 * That is what makes `<KanbanBoard cards={items} />` work with no schema at
 * all.
 *
 * `normalizeSchema` turns either form into the `KanbanModel` the component and
 * `board.ts` work with. Everything downstream reads the model, never the
 * schema, so adding a role or an alias is a one-line change here.
 *
 * Pure and unit-tested (types.test.ts). No Svelte, no DOM.
 */

/** The parts of a card the board understands. */
export type FieldRole = 'id' | 'title' | 'status' | 'due' | 'priority' | 'description' | 'order';

/** How a badge is coloured. Each maps to one semantic token pair. */
export type Tone = 'muted' | 'info' | 'success' | 'warning' | 'danger' | 'primary';

/**
 * The spellings accepted for a role. Generous on purpose: these are written by
 * hand, and `due` / `dueDate` / `deadline` all obviously mean the same thing.
 */
const ROLE_ALIASES: Record<string, FieldRole> = {
  id: 'id',
  _id: 'id',
  uuid: 'id',
  guid: 'id',
  key: 'id',
  pk: 'id',

  title: 'title',
  name: 'title',
  label: 'title',
  summary: 'title',
  headline: 'title',
  subject: 'title',
  heading: 'title',

  status: 'status',
  state: 'status',
  stage: 'status',
  column: 'status',
  lane: 'status',
  phase: 'status',
  progress: 'status',

  due: 'due',
  duedate: 'due',
  dueon: 'due',
  deadline: 'due',
  date: 'due',
  target: 'due',
  when: 'due',

  priority: 'priority',
  urgency: 'priority',
  importance: 'priority',
  severity: 'priority',

  description: 'description',
  desc: 'description',
  body: 'description',
  notes: 'description',
  note: 'description',
  details: 'description',
  detail: 'description',
  content: 'description',
  markdown: 'description',

  order: 'order',
  position: 'order',
  sort: 'order',
  sortorder: 'order',
  rank: 'order',
  seq: 'order',
  sequence: 'order',
};

/**
 * Key spellings looked for when the schema doesn't name a role. The first one
 * present in the data wins; if none is, the first in the list is used anyway,
 * so a card can still be given a value the source objects never had.
 */
const KEY_CANDIDATES: Record<FieldRole, string[]> = {
  id: ['id', '_id', 'uuid', 'key'],
  title: ['title', 'name', 'label', 'summary'],
  status: ['status', 'state', 'stage', 'column'],
  due: ['dueDate', 'due_date', 'due', 'duedate', 'deadline'],
  priority: ['priority', 'urgency', 'importance'],
  description: ['description', 'body', 'notes', 'details'],
  order: ['order', 'position', 'sortOrder', 'sort_order', 'rank'],
};

/** How a due date is written back. `auto` matches whatever was already there. */
export type DueFormat = 'auto' | 'iso' | 'datetime' | 'date' | 'epoch';

/** One column of the board, as written in a schema's `options`. */
export interface StatusOption {
  /** Canonical id, used everywhere inside the board. */
  id: string;
  /** Column heading. Defaults to the id, humanized. */
  label?: string;
  /** What gets WRITTEN back to your object. Defaults to the id. */
  value?: unknown;
  /** Extra spellings in your data that mean this status. */
  match?: string[];
  /** WIP limit — shown as `3/5`, and flagged when exceeded. */
  limit?: number;
  tone?: Tone;
}

/** One priority level, as written in a schema's `options`. */
export interface PriorityOption {
  id: string;
  label?: string;
  value?: unknown;
  match?: string[];
  tone?: Tone;
}

/** The long form of a field, when a bare role name isn't enough. */
export interface FieldSpec {
  role: string;
  /** Field label in the card editor. Defaults to the role, humanized. */
  label?: string;
  /** The vocabulary for a `status` or `priority` field. */
  options?: (string | StatusOption | PriorityOption)[];
  /** `due` only: how to write a date back. Defaults to `auto`. */
  format?: DueFormat;
}

/** What a caller writes: their key to a role name, or to a spec. */
export type KanbanSchema = Record<string, string | FieldSpec>;

/** One card, as the caller's own object. Untouched by the board. */
export type CardRecord = Record<string, unknown>;

/** A status after normalization. */
export interface Status {
  id: string;
  label: string;
  value: unknown;
  /** Folded spellings that resolve to this status. */
  match: string[];
  limit?: number;
  tone: Tone;
}

/** A priority after normalization. `weight` orders them, quietest first. */
export interface Priority {
  id: string;
  label: string;
  value: unknown;
  match: string[];
  tone: Tone;
  weight: number;
}

/** A schema after normalization — what the component actually uses. */
export interface KanbanModel {
  /** Role to the key it reads and writes. Always resolved to something. */
  fields: Record<FieldRole, string>;
  /**
   * Whether the data (or the schema) actually has an ordering field. When it
   * doesn't, a card's position within its column is remembered locally and
   * never reported as an update — there is nowhere to put it.
   */
  hasOrder: boolean;
  statuses: Status[];
  priorities: Priority[];
  dueFormat: DueFormat;
  /** Field labels for the card editor, by role. */
  labels: Record<FieldRole, string>;
}

/**
 * The three statuses a board has unless a schema says otherwise. `id` doubles
 * as the value written back, so a board over `{ status: 'todo' }` data needs
 * no configuration at all.
 */
export const DEFAULT_STATUSES: StatusOption[] = [
  { id: 'todo', label: 'To do' },
  { id: 'in-progress', label: 'In progress' },
  { id: 'done', label: 'Done', tone: 'success' },
];

export const DEFAULT_PRIORITIES: PriorityOption[] = [
  { id: 'low', label: 'Low', tone: 'muted' },
  { id: 'medium', label: 'Medium', tone: 'info' },
  { id: 'high', label: 'High', tone: 'warning' },
  { id: 'urgent', label: 'Urgent', tone: 'danger' },
];

/**
 * Spellings the built-in statuses answer to, on top of their own id, label and
 * written value. A board reading someone else's data is the normal case —
 * `"In Progress"`, `"WIP"` and `"doing"` all mean the middle column.
 */
const STATUS_MATCHES: Record<string, string[]> = {
  todo: ['todo', 'to do', 'backlog', 'open', 'new', 'pending', 'not started', 'planned', 'queued'],
  'in progress': ['in progress', 'doing', 'wip', 'active', 'started', 'ongoing', 'in review'],
  done: ['done', 'complete', 'completed', 'closed', 'finished', 'resolved', 'shipped'],
};

/**
 * Likewise for priorities. The numeric spellings follow the tracker convention
 * where a LOWER number is more urgent (`P0` is the one that is on fire).
 */
const PRIORITY_MATCHES: Record<string, string[]> = {
  low: ['low', 'lowest', 'minor', 'trivial', 'p3', '3'],
  medium: ['medium', 'med', 'normal', 'moderate', 'default', 'p2', '2'],
  high: ['high', 'major', 'important', 'p1', '1'],
  urgent: ['urgent', 'critical', 'blocker', 'highest', 'asap', 'p0', '0'],
};

/** `first_name` / `firstName` / `first-name` → "First name". */
export function humanize(key: string): string {
  const spaced = key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase() : key;
}

/**
 * Fold a written value down to something comparable: trimmed, lower-cased, and
 * with `_`, `-` and runs of spaces all treated as one space. It is what makes
 * `IN_PROGRESS`, `in-progress` and `In Progress` the same status.
 */
export const foldValue = (value: unknown): string =>
  String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');

/**
 * Resolve a written role name to a canonical one. Unknown names return null
 * and the field is ignored — a typo costs you that one field, and guessing
 * would put the wrong value on every card instead.
 */
export function resolveRole(name: string): FieldRole | null {
  return ROLE_ALIASES[foldValue(name).replace(/\s+/g, '')] ?? null;
}

const isSpec = (value: string | FieldSpec): value is FieldSpec =>
  typeof value === 'object' && value !== null;

/** Every spelling that should resolve to one option, folded and deduplicated. */
const matchesFor = (
  id: string,
  spec: { label?: string; value?: unknown; match?: string[] },
  builtin: Record<string, string[]>
): string[] => [
  ...new Set(
    [id, spec.label ?? '', ...(spec.match ?? []), ...(builtin[foldValue(id)] ?? [])]
      .map(foldValue)
      .concat(spec.value === undefined ? [] : [foldValue(spec.value)])
      .filter(Boolean)
  ),
];

/** Fill in a status option's defaults, folding its spellings for lookup. */
function toStatus(option: string | StatusOption, index: number): Status {
  const spec: StatusOption = typeof option === 'string' ? { id: option } : option;
  const id = String(spec.id);
  return {
    id,
    label: spec.label ?? humanize(id),
    value: spec.value ?? id,
    match: matchesFor(id, spec, STATUS_MATCHES),
    limit: spec.limit,
    tone: spec.tone ?? (index === 0 ? 'muted' : 'info'),
  };
}

function toPriority(option: string | PriorityOption, index: number, count: number): Priority {
  const spec: PriorityOption = typeof option === 'string' ? { id: option } : option;
  const id = String(spec.id);
  // A custom vocabulary gets its tone from where it sits in the list: the last
  // one is the loudest, the first the quietest.
  const share = count > 1 ? index / (count - 1) : 0;
  const fallback: Tone =
    share >= 0.99 ? 'danger' : share >= 0.6 ? 'warning' : share >= 0.3 ? 'info' : 'muted';
  return {
    id,
    label: spec.label ?? humanize(id),
    value: spec.value ?? id,
    match: matchesFor(id, spec, PRIORITY_MATCHES),
    tone: spec.tone ?? fallback,
    weight: index,
  };
}

/** Drop duplicates by folded id, keeping the first — the order is meaningful. */
function dedupe<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = foldValue(item.id);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Turn either schema form into the model everything else reads.
 *
 * `keys` is the set of keys the cards actually have; it only decides which
 * spelling an unnamed role falls back to, so the result is stable for a given
 * (schema, keys) pair and never depends on the values.
 */
export function normalizeSchema(
  schema: KanbanSchema = {},
  keys: Iterable<string> = []
): KanbanModel {
  const present = new Set(keys);
  const claimed = new Map<FieldRole, { key: string; spec: FieldSpec }>();

  for (const [key, value] of Object.entries(schema)) {
    const spec: FieldSpec = isSpec(value) ? value : { role: value };
    const role = resolveRole(spec.role);
    // Unknown role, or one an earlier key already claimed: ignored. A role has
    // exactly one source key, or a write would have two places to go.
    if (!role || claimed.has(role)) continue;
    claimed.set(role, { key, spec });
  }

  const fields = {} as Record<FieldRole, string>;
  const labels = {} as Record<FieldRole, string>;
  for (const role of Object.keys(KEY_CANDIDATES) as FieldRole[]) {
    const candidates = KEY_CANDIDATES[role];
    const own = claimed.get(role);
    fields[role] = own?.key ?? candidates.find((name) => present.has(name)) ?? candidates[0]!;
    labels[role] = own?.spec.label ?? humanize(role === 'due' ? 'due date' : role);
  }

  const statusOptions = claimed.get('status')?.spec.options;
  const priorityOptions = claimed.get('priority')?.spec.options;
  const statuses = dedupe(
    ((statusOptions?.length ? statusOptions : DEFAULT_STATUSES) as (string | StatusOption)[]).map(
      toStatus
    )
  );
  const rawPriorities = (
    priorityOptions?.length ? priorityOptions : DEFAULT_PRIORITIES
  ) as (string | PriorityOption)[];
  // Re-weight after deduplication so the weights stay 0…n-1 with no gaps.
  const priorities = dedupe(
    rawPriorities.map((option, index) => toPriority(option, index, rawPriorities.length))
  ).map((priority, index) => ({ ...priority, weight: index }));

  return {
    fields,
    // An `order` key nobody has is not an ordering: writing to it would invent
    // a field on someone else's objects to hold a number they never asked for.
    hasOrder: claimed.has('order') || KEY_CANDIDATES.order.some((name) => present.has(name)),
    statuses: statuses.length > 0 ? statuses : dedupe(DEFAULT_STATUSES.map(toStatus)),
    priorities,
    dueFormat: claimed.get('due')?.spec.format ?? 'auto',
    labels,
  };
}

/** The keys present across a sample of cards, for `normalizeSchema`. */
export function sampleKeys(cards: readonly CardRecord[], limit = 20): string[] {
  const keys = new Set<string>();
  for (const card of cards.slice(0, limit)) {
    if (card && typeof card === 'object') for (const key of Object.keys(card)) keys.add(key);
  }
  return [...keys];
}

/**
 * Which status a written value means, or null when nothing claims it. Matching
 * is by folded value, so case and separators don't matter.
 */
export function resolveStatus(raw: unknown, statuses: readonly Status[]): string | null {
  const folded = foldValue(raw);
  if (!folded) return null;
  return statuses.find((status) => status.match.includes(folded))?.id ?? null;
}

/** Which priority a written value means, or null. */
export function resolvePriority(raw: unknown, priorities: readonly Priority[]): string | null {
  const folded = foldValue(raw);
  if (!folded) return null;
  return priorities.find((priority) => priority.match.includes(folded))?.id ?? null;
}

export const statusById = (id: string | null, statuses: readonly Status[]): Status | undefined =>
  statuses.find((status) => status.id === id);

export const priorityById = (
  id: string | null,
  priorities: readonly Priority[]
): Priority | undefined => priorities.find((priority) => priority.id === id);
