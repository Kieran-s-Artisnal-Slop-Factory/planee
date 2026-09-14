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
