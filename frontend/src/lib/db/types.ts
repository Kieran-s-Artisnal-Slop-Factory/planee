/**
 * Entity types + object-store map. GENERATED from your schema — mirrors
 * backend/sql/schema.sql 1:1 by field name; change them in lockstep.
 */

/** Fields every synced entity carries (see backend/README.md). */
export interface SyncFields {
  id: string; // UUID v4, client-generated
  updated_at: string; // UTC ISO 8601; LWW conflict-resolution field
  deleted_at: string | null; // soft-delete tombstone (null = alive)
  server_seq: number | null; // server sync cursor (null = never synced)
  /**
   * Per-field last-write-wins timestamps (column -> UTC ISO 8601). Present
   * only on stores flagged `fieldMerge` below; written by repo.patch/put and
   * merged field-by-field on both the client and the server, so two devices
   * editing different fields of the same row both keep their edit.
   */
  field_updated_at?: Record<string, string>;
}

export interface Project extends SyncFields {
  name: string;
  description: string; // markdown
}

export interface Version extends SyncFields {
  number: string; // semver
  project: string; // FK -> project.id
  description: string | null; // markdown
  completed: boolean;
}

export interface Task extends SyncFields {
  project: string; // FK -> project.id
  title: string;
  task_type: TaskTypeKey; // FK -> task_type.id
  description: string | null; // markdown
  priority: number; // one of PRIORITY_VALUES (1 Urgent .. 4 Low)
  subtasks: string | null; // markdown checklist
}

/** A task scheduled in a version; status and board order are per version. */
export interface VersionTask extends SyncFields {
  version: string; // FK -> version.id
  task: string; // FK -> task.id
  status: StatusTypeKey; // FK -> status_type.id
  position: number; // REAL: order within the status column
}

/** An image or drawing referenced from markdown as `assets/<id>.<ext>`. */
export interface Asset extends SyncFields {
  name: string;
  mime: string;
  size: number; // bytes, before base64
  data: string; // base64 of the bytes
}

/** Enum row — one of TASK_TYPE_VALUES; `id` is the value key. */
export interface TaskType extends SyncFields {
  id: TaskTypeKey;
  label: string;
  position: number;
}

export interface Preferences extends SyncFields {
  default_task_type: TaskTypeKey; // FK -> task_type.id
}

/** Enum row — one of STATUS_TYPE_VALUES; `id` is the value key. */
export interface StatusType extends SyncFields {
  id: StatusTypeKey;
  label: string;
  position: number;
}

export interface StoreIndex {
  name: string;
  multiEntry?: boolean;
}

export interface StoreDef {
  indexes: StoreIndex[];
  /** Reconciled per field rather than whole-row last-write-wins. */
  fieldMerge?: boolean;
  /** Single-row table: read/write it with repo's getSingleton/putSingleton. */
  singleton?: boolean;
  /**
   * Fixed-value lookup seeded from ENUM_SEEDS. Read-only in the app, never
   * pushed, pulled or backed up — see SYNCED_STORES.
   */
  enum?: boolean;
}

export const STORES: Record<string, StoreDef> = {
  project: { indexes: [], fieldMerge: true },
  version: { indexes: [{ name: 'project' }], fieldMerge: true },
  task: { indexes: [{ name: 'project' }], fieldMerge: true },
  version_task: { indexes: [{ name: 'version' }, { name: 'task' }], fieldMerge: true },
  asset: { indexes: [] },
  task_type: { indexes: [], enum: true },
  preferences: { indexes: [], fieldMerge: true, singleton: true },
  status_type: { indexes: [], enum: true },
};

export type StoreName = keyof typeof STORES;

/**
 * Stores whose rows travel: everything except enum lookups. This is the list
 * the sync loop pushes and pulls, the backup exports and restores, and the
 * "queue everything" reset walks — enum rows are seeded identically everywhere
 * (ENUM_SEEDS), so moving them could only create duplicates or conflicts.
 */
export const SYNCED_STORES: string[] = Object.entries(STORES)
  .filter(([, def]) => !def.enum)
  .map(([name]) => name);

/** Stores whose rows carry per-field timestamps (see SyncFields.field_updated_at). */
export const FIELD_MERGED_STORES: string[] = Object.entries(STORES)
  .filter(([, def]) => def.fieldMerge)
  .map(([name]) => name);
/** One declared value of an enum table. */
export interface EnumSeed {
  readonly key: string;
  readonly label: string;
}

/** Values of the task_type enum, in display order (index = position). */
export const TASK_TYPE_VALUES = [
  { key: "bug", label: "Bug" },
  { key: "feature", label: "Feature" },
  { key: "exploration", label: "Exploration" },
  { key: "cleanup", label: "Cleanup" },
] as const satisfies readonly EnumSeed[];

export type TaskTypeKey = (typeof TASK_TYPE_VALUES)[number]['key'];

/**
 * task.task_type when nothing better is known (matches the column DEFAULT in
 * schema.sql). The UI should prefer preferences.default_task_type.
 */
export const DEFAULT_TASK_TYPE: TaskTypeKey = 'feature';

/** Values of the status_type enum, in display order (index = position). */
export const STATUS_TYPE_VALUES = [
  { key: "todo", label: "TODO" },
  { key: "in_progress", label: "In Progress" },
  { key: "done", label: "Done" },
  { key: "wontfix", label: "Wont Fix" },
  { key: "out_of_scope", label: "Out of Scope" },
  { key: "bumped", label: "Bumped" },
] as const satisfies readonly EnumSeed[];

export type StatusTypeKey = (typeof STATUS_TYPE_VALUES)[number]['key'];

/** version_task.status for a newly scheduled task (matches the column DEFAULT). */
export const DEFAULT_STATUS: StatusTypeKey = 'todo';

/**
 * Statuses that count as finished: they sit in the board's Done column, and a
 * version whose links are all in one of these has no open work. `done` is what
 * a drag to Done writes; the other three are resolutions picked explicitly.
 */
export const DONE_STATUSES: StatusTypeKey[] = ['done', 'wontfix', 'out_of_scope', 'bumped'];

export function isDoneStatus(status: string): boolean {
  return (DONE_STATUSES as string[]).includes(status);
}

/**
 * task.priority values, most urgent first. Stored as the number; not an enum
 * table because the order IS the value.
 */
export const PRIORITY_VALUES = [
  { value: 1, label: 'Urgent' },
  { value: 2, label: 'High' },
  { value: 3, label: 'Medium' },
  { value: 4, label: 'Low' },
] as const;

export type Priority = (typeof PRIORITY_VALUES)[number]['value'];

/** The priority a new task gets (matches task.priority's DEFAULT in schema.sql). */
export const DEFAULT_PRIORITY: Priority = 4;

/**
 * Seed rows for every enum store, keyed by store name. db.ts writes these in
 * the migration that creates the store; the key becomes the row id, the index
 * becomes `position`, and `updated_at` is ENUM_SEED_UPDATED_AT — identical
 * on every device and on the server, which is why enum stores never sync.
 */
export const ENUM_SEEDS: Record<string, readonly EnumSeed[]> = {
  task_type: TASK_TYPE_VALUES,
  status_type: STATUS_TYPE_VALUES,
};

/** The constant `updated_at` on every seeded enum row (see ENUM_SEEDS). */
export const ENUM_SEED_UPDATED_AT = "1970-01-01T00:00:00.000Z";
