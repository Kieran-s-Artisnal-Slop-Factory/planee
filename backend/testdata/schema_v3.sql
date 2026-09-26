-- FROZEN FIXTURE: schema v3, exactly as backend/sql/schema.sql shipped from
-- a880c09 (Checkpoint 4b) through 3f0be1a (the 0.1.0 merge). db_test.go builds
-- a v3 database from it — the shape a server CREATED by a v3 build has, as
-- opposed to one migrated there — to prove the migrations after v3 reach the
-- same columns as a fresh database.
-- Never edit this file; add a new fixture for a new baseline instead.
--
-- planee schema — canonical data model.
--
-- This DDL is the single source of truth, and it is the FULL, CURRENT schema:
-- db.go applies it as-is to a brand-new database. An EXISTING database reaches
-- the same shape through the numbered migrations in db.go instead, so every
-- change here needs a matching migration appended there (and db_test.go
-- proves the two paths end up with identical columns).
--
-- The frontend's IndexedDB object stores (frontend/src/lib/db/types.ts)
-- mirror these tables 1:1 by field name. Change them in lockstep: edit this
-- file, append a migration in backend/db.go, update backend/sync.go, AND
-- append an IndexedDB migration in frontend/src/lib/db/db.ts.
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
-- value set is a schema change on both sides like any other. They come first
-- in this file because other tables reference them.
--
-- Tables marked "concurrent edits: per field" carry field_updated_at: a JSON
-- map of column -> timestamp, so two devices editing DIFFERENT fields of the
-- same row both keep their edit instead of the later whole-row write erasing
-- the other. Everything else is whole-row last-write-wins, which is correct
-- for rows one person edits as a unit.
--
-- Markdown columns are plain TEXT; the markdown is rendered (and sanitised) by
-- the client. Booleans are INTEGER 0/1 in storage and JSON true/false on the
-- wire (boolCols in sync.go).

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

-- project — concurrent edits: per field
CREATE TABLE project (
    id                TEXT PRIMARY KEY,
    name              TEXT NOT NULL DEFAULT '',
    description       TEXT NOT NULL,              -- markdown
    updated_at        TEXT NOT NULL,
    deleted_at        TEXT,
    server_seq        INTEGER,
    field_updated_at  TEXT NOT NULL DEFAULT '{}'  -- JSON object: column -> UTC ISO 8601 (per-field LWW)
);

-- version — concurrent edits: per field
CREATE TABLE version (
    id                TEXT PRIMARY KEY,
    number            TEXT NOT NULL,              -- semver, e.g. 0.10.0
    project           TEXT NOT NULL REFERENCES project (id),
    description       TEXT,                       -- markdown
    completed         INTEGER NOT NULL DEFAULT 0, -- boolean
    updated_at        TEXT NOT NULL,
    deleted_at        TEXT,
    server_seq        INTEGER,
    field_updated_at  TEXT NOT NULL DEFAULT '{}'  -- JSON object: column -> UTC ISO 8601 (per-field LWW)
);

-- task — concurrent edits: per field
CREATE TABLE task (
    id                TEXT PRIMARY KEY,
    project           TEXT NOT NULL REFERENCES project (id),
    title             TEXT NOT NULL DEFAULT '',
    task_type         TEXT NOT NULL DEFAULT 'feature' REFERENCES task_type (id),
    description       TEXT,                       -- markdown
    priority          INTEGER NOT NULL DEFAULT 4, -- 1 Urgent, 2 High, 3 Medium, 4 Low
    subtasks          TEXT,                       -- markdown checklist
    updated_at        TEXT NOT NULL,
    deleted_at        TEXT,
    server_seq        INTEGER,
    field_updated_at  TEXT NOT NULL DEFAULT '{}'  -- JSON object: column -> UTC ISO 8601 (per-field LWW)
);

-- version_task — a task scheduled in a version. status and position live here,
-- not on task, so each version keeps its own history of the task (a bumped
-- task is 'bumped' in the old version and 'todo' in the next).
-- Concurrent edits: per field (a drag on one device and a status change on
-- another must both survive).
CREATE TABLE version_task (
    id                TEXT PRIMARY KEY,
    version           TEXT NOT NULL REFERENCES version (id),
    task              TEXT NOT NULL REFERENCES task (id),
    status            TEXT NOT NULL DEFAULT 'todo' REFERENCES status_type (id),
    position          REAL NOT NULL DEFAULT 0,    -- order within the status column
    updated_at        TEXT NOT NULL,
    deleted_at        TEXT,
    server_seq        INTEGER,
    field_updated_at  TEXT NOT NULL DEFAULT '{}'  -- JSON object: column -> UTC ISO 8601 (per-field LWW)
);

-- asset — an image or drawing referenced from markdown as assets/<id>.<ext>.
-- Whole-row last-write-wins: assets are effectively immutable, and a drawing
-- re-save replaces the whole row.
CREATE TABLE asset (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    mime        TEXT NOT NULL,
    size        INTEGER NOT NULL,  -- bytes, before base64
    data        TEXT NOT NULL,     -- base64 of the bytes
    updated_at  TEXT NOT NULL,
    deleted_at  TEXT,
    server_seq  INTEGER
);

-- preferences — single row, concurrent edits: per field
CREATE TABLE preferences (
    id                   TEXT PRIMARY KEY,
    default_task_type    TEXT NOT NULL REFERENCES task_type (id),
    recent_issues_count  INTEGER NOT NULL DEFAULT 6,  -- how many recent issues Home lists
    updated_at           TEXT NOT NULL,
    deleted_at           TEXT,
    server_seq           INTEGER,
    field_updated_at     TEXT NOT NULL DEFAULT '{}'  -- JSON object: column -> UTC ISO 8601 (per-field LWW)
);
