package main

import (
	"crypto/rand"
	"database/sql"
	_ "embed"
	"encoding/hex"
	"fmt"

	_ "modernc.org/sqlite"
)

//go:embed sql/schema.sql
var schemaSQL string

// Server-only bookkeeping: the single global sync counter plus this database's
// identity. Not part of the shared schema (the client never stores it).
//
// `epoch` is generated once, when the database is created, and returned on
// every sync response. server_seq values only mean anything relative to the
// counter that issued them, so a client that sees the epoch change knows it is
// talking to a different (or rebuilt) database and must resync from scratch —
// without it, restoring the server from a backup or starting a fresh DB leaves
// every existing client silently stuck above the new sequence, pulling nothing.
//
// A migration must never touch sync_state: rewriting the epoch would make every
// client throw away its cursor and re-pull everything.
const serverDDL = `
CREATE TABLE sync_state (
    id       INTEGER PRIMARY KEY CHECK (id = 1),
    last_seq INTEGER NOT NULL,
    epoch    TEXT NOT NULL
);
`

// Schema versions, stored in PRAGMA user_version:
//
//	0    empty file, nothing applied yet
//	1    the original generated schema (backend/testdata/schema_v1.sql)
//	1+n  after migrations[0..n-1]
//
// sql/schema.sql is always the LATEST schema, so a fresh database applies it
// directly and jumps straight to latestSchemaVersion; only an existing database
// walks the list below.
//
// To change the schema: edit sql/schema.sql, then APPEND a function here that
// takes a database from the previous version to the new one. Never edit or
// reorder a migration that has shipped — a database out there is already past
// it and will never run it again. db_test.go checks that migrated v1 and v2
// databases (testdata/schema_v1.sql, schema_v2.sql) end up with exactly the
// columns a fresh one has.
var migrations = []func(*sql.Tx) error{
	migrateV2, // 1 -> 2
	migrateV3, // 2 -> 3
}

// latestSchemaVersion is the user_version a fully up-to-date database carries.
func latestSchemaVersion() int {
	return 1 + len(migrations)
}

// migrateV2: project names, task titles/types, per-version task status and
// order, version descriptions and completion, per-field merge on the four
// data tables, and the synced asset store.
//
// Every added NOT NULL column carries the same DEFAULT as sql/schema.sql, and
// the IndexedDB v3 migration (frontend/src/lib/db/db.ts) backfills exactly
// these values on the client, so rows that existed before the upgrade agree
// on both sides without anyone re-pushing them.
func migrateV2(tx *sql.Tx) error {
	stmts := []string{
		// project: a name; `version` was free text that overlapped the version
		// table and is gone. DROP COLUMN needs SQLite 3.35+ (modernc bundles a
		// far newer one).
		`ALTER TABLE project ADD COLUMN name TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE project DROP COLUMN version`,
		`ALTER TABLE project ADD COLUMN field_updated_at TEXT NOT NULL DEFAULT '{}'`,

		`ALTER TABLE version ADD COLUMN description TEXT`,
		`ALTER TABLE version ADD COLUMN completed INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE version ADD COLUMN field_updated_at TEXT NOT NULL DEFAULT '{}'`,

		// ADD COLUMN ... REFERENCES with a non-NULL default is only allowed
		// while foreign_keys is OFF, which openDB guarantees (see below).
		`ALTER TABLE task ADD COLUMN title TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE task ADD COLUMN task_type TEXT NOT NULL DEFAULT 'feature' REFERENCES task_type (id)`,
		`ALTER TABLE task ADD COLUMN field_updated_at TEXT NOT NULL DEFAULT '{}'`,
		// task.priority's DEFAULT is 4 in sql/schema.sql but stays 3 here:
		// SQLite cannot change a column default with ALTER, and rebuilding the
		// table (create/copy/drop/rename) is not worth the risk for it. The
		// default only applies to an INSERT that omits the column, and the
		// client always sends priority, so the difference is unobservable
		// through sync. db_test.go asserts this one difference explicitly.

		`ALTER TABLE version_task ADD COLUMN status TEXT NOT NULL DEFAULT 'todo' REFERENCES status_type (id)`,
		`ALTER TABLE version_task ADD COLUMN position REAL NOT NULL DEFAULT 0`,
		`ALTER TABLE version_task ADD COLUMN field_updated_at TEXT NOT NULL DEFAULT '{}'`,

		// Frozen copy of the asset DDL as of v2 — not a reference to
		// schema.sql, which will keep moving.
		`CREATE TABLE asset (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    mime        TEXT NOT NULL,
    size        INTEGER NOT NULL,
    data        TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    deleted_at  TEXT,
    server_seq  INTEGER
)`,
	}
	for _, stmt := range stmts {
		if _, err := tx.Exec(stmt); err != nil {
			return fmt.Errorf("%s: %w", stmt, err)
		}
	}
	return nil
}

// migrateV3: how many recent issues Home lists, a synced preference.
//
// The DEFAULT matches sql/schema.sql, and the IndexedDB v4 migration
// (frontend/src/lib/db/db.ts, backfillV4) fills the same 6 into existing
// client rows. No field_updated_at stamp is added on either side: a missing
// stamp falls back to the row's updated_at everywhere, so the existing row
// reads identically on the server and every upgraded device.
func migrateV3(tx *sql.Tx) error {
	const stmt = `ALTER TABLE preferences ADD COLUMN recent_issues_count INTEGER NOT NULL DEFAULT 6`
	if _, err := tx.Exec(stmt); err != nil {
		return fmt.Errorf("%s: %w", stmt, err)
	}
	return nil
}

func newEpoch() (string, error) {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

func openDB(path string) (*sql.DB, string, error) {
	// NOTE: foreign_keys is deliberately left OFF. Sync applies rows in
	// dependency order, but a child whose parent has not landed yet (an earlier
	// batch failed, the parent was created on another device) must be STORED
	// and reconciled, not rejected — enforcement here turns a transient
	// ordering gap into a row the server refuses and the client keeps retrying.
	// Migrations rely on it too: SQLite refuses ADD COLUMN ... REFERENCES with
	// a non-NULL default while enforcement is on.
	dsn := fmt.Sprintf("file:%s?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)", path)
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, "", err
	}
	if err := initSchema(db); err != nil {
		db.Close()
		return nil, "", err
	}

	var epoch string
	if err := db.QueryRow("SELECT epoch FROM sync_state WHERE id = 1").Scan(&epoch); err != nil {
		db.Close()
		return nil, "", fmt.Errorf("read sync epoch (database created by an older build?): %w", err)
	}
	return db, epoch, nil
}

// initSchema brings the database to latestSchemaVersion: the full schema for a
// fresh file, or the remaining migrations for an existing one.
//
// Each step runs in its own transaction and sets user_version INSIDE it
// (SQLite writes the pragma to the file header as part of the transaction), so
// a crash mid-step leaves the database at the previous version with none of
// that step applied, and the next start simply retries it.
func initSchema(db *sql.DB) error {
	if err := db.Ping(); err != nil {
		return err
	}
	var version int
	if err := db.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
		return err
	}
	latest := latestSchemaVersion()

	switch {
	case version > latest:
		return fmt.Errorf("database schema is v%d but this build only knows up to v%d; "+
			"refusing to open a database written by a newer build", version, latest)
	case version == 0:
		return inTx(db, latest, func(tx *sql.Tx) error {
			if _, err := tx.Exec(schemaSQL); err != nil {
				return fmt.Errorf("apply schema: %w", err)
			}
			if _, err := tx.Exec(serverDDL); err != nil {
				return fmt.Errorf("apply server ddl: %w", err)
			}
			epoch, err := newEpoch()
			if err != nil {
				return err
			}
			_, err = tx.Exec("INSERT INTO sync_state (id, last_seq, epoch) VALUES (1, 0, ?)", epoch)
			return err
		})
	}

	for v := version; v < latest; v++ {
		if err := inTx(db, v+1, migrations[v-1]); err != nil {
			return fmt.Errorf("migrate schema v%d -> v%d: %w", v, v+1, err)
		}
	}
	return nil
}

// inTx runs fn and sets user_version to `to` in one transaction.
func inTx(db *sql.DB, to int, fn func(*sql.Tx) error) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := fn(tx); err != nil {
		return err
	}
	// PRAGMA takes no bound parameters; `to` is an int we computed.
	if _, err := tx.Exec(fmt.Sprintf("PRAGMA user_version = %d", to)); err != nil {
		return err
	}
	return tx.Commit()
}
