/**
 * The harness's OWN mirror of the schema, generated alongside the app.
 *
 * Deliberately independent of the app's db/types.ts and the server's metadata:
 * if the oracle normalised the server dump using the server's own idea of
 * which columns are booleans, a drift in that metadata would be invisible —
 * the test would inherit the bug it exists to catch.
 */
export type ColumnType = 'text' | 'integer' | 'real' | 'boolean' | 'json' | 'date' | 'timestamp';

export interface ColumnMeta {
  name: string;
  type: ColumnType;
  nullable: boolean;
  references: string | null;
  /** json columns only; absent means array. */
  jsonHint?: 'array' | 'object';
}

export interface EnumValueMeta {
  key: string;
  label: string;
}

export interface TableMeta {
  name: string;
  fieldMerge: boolean;
  singleton: boolean;
  /** Fixed-value lookup: rows are `values` seeded by the app, never written or synced. */
  enum: boolean;
  values?: EnumValueMeta[];
  columns: ColumnMeta[];
}

/** Parent tables before child tables (FK order), enum tables included. */
export const TABLES: TableMeta[] = [
  {
    name: 'task_type',
    fieldMerge: false,
    singleton: false,
    enum: true,
    values: [{ key: "bug", label: "Bug" }, { key: "feature", label: "Feature" }, { key: "exploration", label: "Exploration" }, { key: "cleanup", label: "Cleanup" }],
    columns: [
    { name: 'label', type: 'text', nullable: false, references: null },
    { name: 'position', type: 'integer', nullable: false, references: null },
    ],
  },
  {
    name: 'status_type',
    fieldMerge: false,
    singleton: false,
    enum: true,
    values: [{ key: "todo", label: "TODO" }, { key: "in_progress", label: "In Progress" }, { key: "done", label: "Done" }, { key: "wontfix", label: "Wont Fix" }, { key: "out_of_scope", label: "Out of Scope" }, { key: "bumped", label: "Bumped" }],
    columns: [
    { name: 'label', type: 'text', nullable: false, references: null },
    { name: 'position', type: 'integer', nullable: false, references: null },
    ],
  },
  {
    name: 'project',
    fieldMerge: true,
    singleton: false,
    enum: false,
    columns: [
    { name: 'name', type: 'text', nullable: false, references: null },
    { name: 'description', type: 'text', nullable: false, references: null },
    ],
  },
  {
    name: 'version',
    fieldMerge: true,
    singleton: false,
    enum: false,
    columns: [
    { name: 'number', type: 'text', nullable: false, references: null },
    { name: 'project', type: 'text', nullable: false, references: 'project' },
    { name: 'description', type: 'text', nullable: true, references: null },
    { name: 'completed', type: 'boolean', nullable: false, references: null },
    ],
  },
  {
    name: 'task',
    fieldMerge: true,
    singleton: false,
    enum: false,
    columns: [
    { name: 'project', type: 'text', nullable: false, references: 'project' },
    { name: 'title', type: 'text', nullable: false, references: null },
    { name: 'task_type', type: 'text', nullable: false, references: 'task_type' },
    { name: 'description', type: 'text', nullable: true, references: null },
    { name: 'priority', type: 'integer', nullable: false, references: null },
    { name: 'subtasks', type: 'text', nullable: true, references: null },
    ],
  },
  {
    name: 'version_task',
    fieldMerge: true,
    singleton: false,
    enum: false,
    columns: [
    { name: 'version', type: 'text', nullable: false, references: 'version' },
    { name: 'task', type: 'text', nullable: false, references: 'task' },
    { name: 'status', type: 'text', nullable: false, references: 'status_type' },
    { name: 'position', type: 'real', nullable: false, references: null },
    ],
  },
  {
    name: 'asset',
    fieldMerge: false,
    singleton: false,
    enum: false,
    columns: [
    { name: 'name', type: 'text', nullable: false, references: null },
    { name: 'mime', type: 'text', nullable: false, references: null },
    { name: 'size', type: 'integer', nullable: false, references: null },
    { name: 'data', type: 'text', nullable: false, references: null },
    ],
  },
  {
    name: 'preferences',
    fieldMerge: true,
    singleton: true,
    enum: false,
    columns: [
    { name: 'default_task_type', type: 'text', nullable: false, references: 'task_type' },
    { name: 'recent_issues_count', type: 'integer', nullable: false, references: null },
    ],
  },
];

/** The tables whose rows travel — what sync, backup and the row specs cover. */
export const SYNCED_TABLES = TABLES.filter((t) => !t.enum);
export const ENUM_TABLES = TABLES.filter((t) => t.enum);

/** Store names that sync and back up (enum stores are seeded, not moved). */
export const STORE_NAMES = SYNCED_TABLES.map((t) => t.name);
export const tableOf = (name: string): TableMeta =>
  TABLES.find((t) => t.name === name) ?? (() => { throw new Error('no such table: ' + name); })();

/** The `updated_at` on every seeded enum row — the app's ENUM_SEED_UPDATED_AT, restated here on purpose. */
export const ENUM_SEED_UPDATED_AT = '1970-01-01T00:00:00.000Z';

/** The rows an enum store must hold, from the values declared in the schema (sorted by id, as IndexedDB returns them). */
export function enumRows(table: TableMeta): Record<string, unknown>[] {
  return (table.values ?? [])
    .map((v, position) => ({
      id: v.key,
      label: v.label,
      position,
      updated_at: ENUM_SEED_UPDATED_AT,
      deleted_at: null,
      server_seq: null,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * The FK parents a row of `table` needs, as table -> id. A row-backed parent is
 * written with `write`; an enum parent is one of its declared keys and needs no
 * write at all (the app seeded it).
 */
export async function seedParents(
  table: TableMeta,
  tag: string,
  write: (store: string, row: Record<string, unknown>) => Promise<void>
): Promise<Record<string, string>> {
  const parents: Record<string, string> = {};
  for (const col of table.columns) {
    if (!col.references || parents[col.references]) continue;
    const parent = tableOf(col.references);
    if (parent.enum) {
      parents[col.references] = parent.values![0]!.key;
      continue;
    }
    const grand = await seedParents(parent, tag + '-p', write);
    const id = tag + '-' + parent.name;
    await write(parent.name, buildRow(parent, id, grand, 1));
    parents[col.references] = id;
  }
  return parents;
}

/** True for a column that points into an enum table (its values are the enum's keys). */
export function isEnumRef(col: ColumnMeta): boolean {
  return col.references != null && tableOf(col.references).enum;
}

/** A representative value for a column, distinct per `variant`. */
export function sampleValue(col: ColumnMeta, variant: number): unknown {
  if (isEnumRef(col)) {
    // Only a DECLARED key is a valid value — the app seeded exactly those rows
    // and nothing else. A different key per variant, so a lost update is
    // visible; taken from the END of the list because a column DEFAULT is
    // usually one of the first keys, and a value that silently snaps back to
    // its default must not happen to equal the sample.
    const values = tableOf(col.references!).values!;
    return values[values.length - 1 - (variant % values.length)]!.key;
  }
  switch (col.type) {
    case 'text':
      // Includes a quote, a backslash, a newline and non-ASCII on purpose:
      // these are what break naive escaping and JSON round-trips.
      return variant === 0 ? 'value ' + variant : 'wërt "' + variant + '" \\ ünï\ncödé 😀';
    case 'integer':
      return variant === 0 ? 0 : -2147483649 + variant;
    case 'real':
      // 62.4999 is here because a REAL silently coerced to INTEGER, or a float
      // rounded on the way through JSON, is a classic wire-format bug.
      return variant === 0 ? 0.5 : 62.4999;
    case 'boolean':
      // BOTH values matter: a false that arrives as 0, or as an absent key, is
      // a bug that only shows up when you test the false case.
      return variant % 2 === 0;
    case 'json':
      // The shape the app declared: an object column gets an object. Both
      // shapes carry unicode and a nested value, which is what breaks a
      // storage layer that stringifies twice or truncates on the way through.
      if (col.jsonHint === 'object') {
        return variant === 0 ? {} : { k: 'ünï 😀', n: 3, nested: { ok: true } };
      }
      return variant === 0 ? [] : ['a', 'b', 'ünï 😀', 3];
    case 'date':
      return variant === 0 ? '2024-01-01' : '2024-12-31';
    case 'timestamp':
      return variant === 0 ? '2024-01-01T00:00:00.000Z' : '2024-12-31T23:59:59.999Z';
  }
}

/** A complete, storable row for a table. FK columns come from `parents`. */
export function buildRow(
  table: TableMeta,
  id: string,
  parents: Record<string, string>,
  variant = 0
): Record<string, unknown> {
  const row: Record<string, unknown> = {
    id,
    updated_at: new Date().toISOString(),
    deleted_at: null,
    server_seq: null,
  };
  if (table.fieldMerge) row.field_updated_at = {};
  for (const col of table.columns) {
    row[col.name] = col.references
      ? (parents[col.references] ?? defaultParentId(col.references))
      : sampleValue(col, variant);
  }
  return row;
}

/**
 * The FK value a row gets when the caller supplied no parent. A row-backed
 * parent stays null (the specs that care seed one); an enum parent is always
 * present — the app seeded it — so the first declared key is a real, valid
 * reference, and the column is NOT NULL on the server.
 */
function defaultParentId(table: string): string | null {
  const parent = TABLES.find((t) => t.name === table);
  return parent?.enum ? parent.values![0]!.key : null;
}

/**
 * Normalise a raw sqlite dump into wire shape: booleans back from 0/1, JSON
 * columns parsed. Uses the metadata above, never the server's.
 */
export function normalizeStored(
  dump: Record<string, Record<string, unknown>[]>
): Record<string, Record<string, unknown>[]> {
  const out: Record<string, Record<string, unknown>[]> = {};
  for (const table of TABLES) {
    const rows = dump[table.name] ?? [];
    out[table.name] = rows.map((row) => {
      const copy: Record<string, unknown> = { ...row };
      for (const col of table.columns) {
        const v = copy[col.name];
        if (v == null) continue;
        if (col.type === 'boolean') copy[col.name] = v === 1 || v === true;
        if (col.type === 'json' && typeof v === 'string') copy[col.name] = JSON.parse(v);
      }
      if (typeof copy.field_updated_at === 'string') {
        copy.field_updated_at = JSON.parse(copy.field_updated_at);
      }
      return copy;
    });
  }
  return out;
}
