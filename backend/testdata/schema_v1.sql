-- FROZEN FIXTURE: schema v1, exactly as backend/sql/schema.sql shipped in the
-- initial commit (231a592). db_test.go builds a v1 database from it to prove
-- the migrations in db.go reach the same columns as a fresh database.
-- Never edit this file; add a new fixture for a new baseline instead.
--
-- planee schema — canonical data model.
--
-- This DDL is the single source of truth. The frontend's IndexedDB object
-- stores (frontend/src/lib/db/types.ts) mirror these tables 1:1 by field
-- name. Change them in lockstep: edit this file AND append an IndexedDB
-- migration in frontend/src/lib/db/db.ts.
--
-- Sync design (pattern from github.com/workoutt-style local-first apps):
--   * id          TEXT UUID primary key, generated client-side (offline-safe)
--   * updated_at  UTC ISO 8601, client-set; conflict resolution is
--                 last-write-wins on this field
--   * deleted_at  UTC ISO 8601 tombstone; rows are never hard-deleted so
--                 deletions sync
--   * server_seq  server-assigned monotonic integer from ONE global counter,
--                 stamped on push; the sync cursor. NULL until the server
--                 first accepts the row.
--
-- Enum tables (fixed-value lookups) are seeded right here with the value key
-- as the id and a constant updated_at. Every client seeds the same rows in its
-- own migration, so they are never pushed, pulled or backed up; changing the
-- value set is a schema change on both sides like any other.
--
-- Tables marked "concurrent edits: per field" in the builder also carry
-- field_updated_at: a JSON map of column -> timestamp, so two devices editing
-- DIFFERENT fields of the same row both keep their edit instead of the later
-- whole-row write erasing the other. Everything else is whole-row
-- last-write-wins, which is correct for rows one person edits as a unit.

CREATE TABLE project (
    id           TEXT PRIMARY KEY,
    description  TEXT NOT NULL,
    version      TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    deleted_at   TEXT,
    server_seq   INTEGER
);

CREATE TABLE version (
    id          TEXT PRIMARY KEY,
    number      TEXT NOT NULL,
    project     TEXT NOT NULL REFERENCES project (id),
    updated_at  TEXT NOT NULL,
    deleted_at  TEXT,
    server_seq  INTEGER
);

CREATE TABLE task (
    id           TEXT PRIMARY KEY,
    project      TEXT NOT NULL REFERENCES project (id),
    description  TEXT,
    priority     INTEGER NOT NULL DEFAULT 3,
    subtasks     TEXT,
    updated_at   TEXT NOT NULL,
    deleted_at   TEXT,
    server_seq   INTEGER
);

CREATE TABLE version_task (
    id          TEXT PRIMARY KEY,
    version     TEXT NOT NULL REFERENCES version (id),
    task        TEXT NOT NULL REFERENCES task (id),
    updated_at  TEXT NOT NULL,
    deleted_at  TEXT,
    server_seq  INTEGER
);

-- task_type: enum (fixed values, seeded below; not synced — see sync.go)
CREATE TABLE task_type (
    id          TEXT PRIMARY KEY,  -- the value key — same on every device
    label       TEXT NOT NULL,
    position    INTEGER NOT NULL,
    updated_at  TEXT NOT NULL,
    deleted_at  TEXT,
    server_seq  INTEGER
);

INSERT OR IGNORE INTO task_type (id, label, position, updated_at, deleted_at, server_seq) VALUES
    ('bug', 'Bug', 0, '1970-01-01T00:00:00.000Z', NULL, NULL),
    ('feature', 'Feature', 1, '1970-01-01T00:00:00.000Z', NULL, NULL),
    ('exploration', 'Exploration', 2, '1970-01-01T00:00:00.000Z', NULL, NULL),
    ('cleanup', 'Cleanup', 3, '1970-01-01T00:00:00.000Z', NULL, NULL);

CREATE TABLE preferences (
    id                 TEXT PRIMARY KEY,
    default_task_type  TEXT NOT NULL REFERENCES task_type (id),
    updated_at         TEXT NOT NULL,
    deleted_at         TEXT,
    server_seq         INTEGER,
    field_updated_at   TEXT NOT NULL DEFAULT '{}'  -- JSON object: column -> UTC ISO 8601 (per-field LWW)
);

-- status_type: enum (fixed values, seeded below; not synced — see sync.go)
CREATE TABLE status_type (
    id          TEXT PRIMARY KEY,  -- the value key — same on every device
    label       TEXT NOT NULL,
    position    INTEGER NOT NULL,
    updated_at  TEXT NOT NULL,
    deleted_at  TEXT,
    server_seq  INTEGER
);

INSERT OR IGNORE INTO status_type (id, label, position, updated_at, deleted_at, server_seq) VALUES
    ('todo', 'TODO', 0, '1970-01-01T00:00:00.000Z', NULL, NULL),
    ('in_progress', 'In Progress', 1, '1970-01-01T00:00:00.000Z', NULL, NULL),
    ('done', 'Done', 2, '1970-01-01T00:00:00.000Z', NULL, NULL),
    ('wontfix', 'Wont Fix', 3, '1970-01-01T00:00:00.000Z', NULL, NULL),
    ('out_of_scope', 'Out of Scope', 4, '1970-01-01T00:00:00.000Z', NULL, NULL),
    ('bumped', 'Bumped', 5, '1970-01-01T00:00:00.000Z', NULL, NULL);
