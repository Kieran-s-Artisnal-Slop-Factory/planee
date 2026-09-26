/**
 * Row upgrades for schema changes that add fields to existing rows.
 *
 * Pure functions, shared by the IndexedDB migration that introduced the fields
 * (db.ts) and by backup import (export.ts), so a backup taken before the change
 * restores into the same shape a live upgrade produces.
 *
 * Each function is a FROZEN snapshot of one schema step, like the migration
 * itself: never edit one after it has shipped — add the next step instead.
 */

/**
 * Schema v3 (server migration v2 in backend/db.go).
 *
 * The values are exactly the server's `ALTER TABLE ... DEFAULT`s. That is
 * what lets both sides upgrade independently with no push: a row that existed
 * before the upgrade reads the same here and in the server's database, so it
 * neither diverges nor needs re-sending.
 *
 * Returns the upgraded copy, or null when the row already has every field (so
 * callers can skip the write). Absent fields only — a present value, including
 * a present null, is never overwritten. `updated_at` is deliberately untouched:
 * this is not an edit, and restamping would make stale content beat genuinely
 * newer edits on other devices.
 */
export function backfillV3(
  store: string,
  row: Record<string, unknown>
): Record<string, unknown> | null {
  const defaults = V3_DEFAULTS[store];
  if (!defaults) return null;
  const next: Record<string, unknown> = { ...row };
  let changed = false;
  for (const [field, value] of Object.entries(defaults)) {
    if (!(field in next)) {
      // Fresh object per row: field_updated_at is mutated per field later.
      next[field] = typeof value === 'object' && value !== null ? { ...value } : value;
      changed = true;
    }
  }
  if (store === 'project' && 'version' in next) {
    // Dropped column (the server runs ALTER TABLE project DROP COLUMN version).
    delete next.version;
    changed = true;
  }
  return changed ? next : null;
}

/** The stores backfillV3 touches, and what it fills in. */
export const V3_DEFAULTS: Record<string, Record<string, unknown>> = {
  project: { name: '', field_updated_at: {} },
  version: { description: null, completed: false, field_updated_at: {} },
  task: { title: '', task_type: 'feature', field_updated_at: {} },
  version_task: { status: 'todo', position: 0, field_updated_at: {} },
};

/**
 * Schema v4 (server migration v3 in backend/db.go): preferences gains
 * recent_issues_count, DEFAULT 6.
 *
 * Same contract as backfillV3: absent fields only, updated_at untouched, and
 * no field_updated_at stamp added — the server's ALTER TABLE adds none either,
 * and a missing stamp falls back to the row's updated_at on both sides.
 * The 6 is spelled out rather than read from DEFAULT_RECENT_ISSUES_COUNT so
 * this step stays what it was when it shipped.
 */
export function backfillV4(
  store: string,
  row: Record<string, unknown>
): Record<string, unknown> | null {
  const defaults = V4_DEFAULTS[store];
  if (!defaults) return null;
  const next: Record<string, unknown> = { ...row };
  let changed = false;
  for (const [field, value] of Object.entries(defaults)) {
    if (!(field in next)) {
      next[field] = value;
      changed = true;
    }
  }
  return changed ? next : null;
}

/** The stores backfillV4 touches, and what it fills in. */
export const V4_DEFAULTS: Record<string, Record<string, unknown>> = {
  preferences: { recent_issues_count: 6 },
};

/**
 * Schema v5 (server migration v4 in backend/db.go): preferences gains
 * show_keybind_sheet, DEFAULT 1 — `true` on the wire and here.
 *
 * Same contract as backfillV4: absent fields only, updated_at untouched, no
 * stamp added. The `true` is spelled out rather than read from
 * DEFAULT_SHOW_KEYBIND_SHEET so this step stays what it was when it shipped.
 */
export function backfillV5(
  store: string,
  row: Record<string, unknown>
): Record<string, unknown> | null {
  const defaults = V5_DEFAULTS[store];
  if (!defaults) return null;
  const next: Record<string, unknown> = { ...row };
  let changed = false;
  for (const [field, value] of Object.entries(defaults)) {
    if (!(field in next)) {
      next[field] = value;
      changed = true;
    }
  }
  return changed ? next : null;
}

/** The stores backfillV5 touches, and what it fills in. */
export const V5_DEFAULTS: Record<string, Record<string, unknown>> = {
  preferences: { show_keybind_sheet: true },
};
