package main

import (
	"database/sql"
	_ "embed"
	"fmt"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
)

// openTestDB opens a fresh database file in a per-test temp dir.
func openTestDB(t *testing.T) (*sql.DB, string, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "test.db")
	db, epoch, err := openDB(path)
	if err != nil {
		t.Fatalf("openDB: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	return db, epoch, path
}

func TestOpenDBFresh(t *testing.T) {
	db, epoch, _ := openTestDB(t)
	if len(epoch) != 32 {
		t.Fatalf("epoch = %q, want 32 hex chars", epoch)
	}

	if version := userVersion(t, db); version != latestSchemaVersion() {
		t.Fatalf("user_version = %d, want latest (%d)", version, latestSchemaVersion())
	}

	var lastSeq int64
	if err := db.QueryRow("SELECT last_seq FROM sync_state WHERE id = 1").Scan(&lastSeq); err != nil {
		t.Fatal(err)
	}
	if lastSeq != 0 {
		t.Fatalf("last_seq = %d, want 0", lastSeq)
	}

	// Every synced table in the sync metadata must exist with its columns.
	for _, table := range tableOrder {
		meta := tables[table]
		query := "SELECT " + strings.Join(meta.writable(), ", ") + " FROM " + table + " LIMIT 0"
		if _, err := db.Exec(query); err != nil {
			t.Errorf("table %s does not match sync metadata: %v", table, err)
		}
	}
}

func TestOpenDBSeedsEnums(t *testing.T) {
	db, _, _ := openTestDB(t)
	want := map[string][]string{
		"task_type":   {"bug", "feature", "exploration", "cleanup"},
		"status_type": {"todo", "in_progress", "done", "wontfix", "out_of_scope", "bumped"},
	}
	for table, ids := range want {
		rows, err := db.Query("SELECT id FROM " + table + " ORDER BY position")
		if err != nil {
			t.Fatal(err)
		}
		var got []string
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				t.Fatal(err)
			}
			got = append(got, id)
		}
		rows.Close()
		if len(got) != len(ids) {
			t.Fatalf("%s = %v, want %v", table, got, ids)
		}
		for i := range ids {
			if got[i] != ids[i] {
				t.Fatalf("%s = %v, want %v", table, got, ids)
			}
		}
	}
}

func TestOpenDBReopenKeepsEpoch(t *testing.T) {
	path := filepath.Join(t.TempDir(), "test.db")
	db, epoch, err := openDB(path)
	if err != nil {
		t.Fatal(err)
	}
	db.Close()
	db2, epoch2, err := openDB(path)
	if err != nil {
		t.Fatal(err)
	}
	defer db2.Close()
	if epoch != epoch2 {
		t.Fatalf("epoch changed on reopen: %s -> %s", epoch, epoch2)
	}
}

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

// schemaV1SQL is the schema exactly as it first shipped. Frozen: a v1 database
// in the wild looks like this, whatever sql/schema.sql says today.
//
//go:embed testdata/schema_v1.sql
var schemaV1SQL string

// v1Epoch is the sync identity of the fixture database; migrating must keep it.
const v1Epoch = "0123456789abcdef0123456789abcdef"

// createV1DB writes a database as the v1 build left it — schema, server
// bookkeeping, user_version 1 — holding a few real rows, and returns its path.
func createV1DB(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "v1.db")
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	stmts := []string{
		schemaV1SQL,
		serverDDL,
		"INSERT INTO sync_state (id, last_seq, epoch) VALUES (1, 4, '" + v1Epoch + "')",
		`INSERT INTO project (id, description, version, updated_at, deleted_at, server_seq)
		 VALUES ('p1', 'Planee', '0.1.0', '2026-01-01T00:00:00.000Z', NULL, 1)`,
		`INSERT INTO version (id, number, project, updated_at, deleted_at, server_seq)
		 VALUES ('v1', '0.1.0', 'p1', '2026-01-01T00:00:01.000Z', NULL, 2)`,
		`INSERT INTO task (id, project, description, priority, subtasks, updated_at, deleted_at, server_seq)
		 VALUES ('t1', 'p1', 'Write the migration', 2, NULL, '2026-01-01T00:00:02.000Z', NULL, 3)`,
		`INSERT INTO version_task (id, version, task, updated_at, deleted_at, server_seq)
		 VALUES ('vt1', 'v1', 't1', '2026-01-01T00:00:03.000Z', '2026-01-02T00:00:00.000Z', 4)`,
		"PRAGMA user_version = 1",
	}
	for _, stmt := range stmts {
		if _, err := db.Exec(stmt); err != nil {
			t.Fatalf("build v1 fixture: %v\n%s", err, stmt)
		}
	}
	return path
}

func userVersion(t *testing.T, db *sql.DB) int {
	t.Helper()
	var v int
	if err := db.QueryRow("PRAGMA user_version").Scan(&v); err != nil {
		t.Fatal(err)
	}
	return v
}

// columnInfo is one PRAGMA table_info row minus cid, which is only the column's
// position — see columnsOf.
type columnInfo struct {
	Type    string
	NotNull bool
	Default sql.NullString
	PK      int
}

func (c columnInfo) String() string {
	d := "<none>"
	if c.Default.Valid {
		d = c.Default.String
	}
	return fmt.Sprintf("type=%s notnull=%v default=%s pk=%d", c.Type, c.NotNull, d, c.PK)
}

// columnsOf returns table -> column -> info for every table in the database.
//
// Keyed by column NAME, not position, on purpose: ALTER TABLE ADD COLUMN can
// only append and DROP COLUMN closes the gap, so a migrated table lists its
// columns in a different order than the same table created fresh from
// schema.sql (migrated project is id, description, updated_at, deleted_at,
// server_seq, name, field_updated_at; fresh has name second). Order is
// invisible to the app — sync.go and cmd/dbdump always address columns by
// name — so it is not part of what "the same schema" means here.
func columnsOf(t *testing.T, db *sql.DB) map[string]map[string]columnInfo {
	t.Helper()
	out := map[string]map[string]columnInfo{}
	for _, table := range tableNamesOf(t, db) {
		rows, err := db.Query(`SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info(?)`, table)
		if err != nil {
			t.Fatal(err)
		}
		cols := map[string]columnInfo{}
		for rows.Next() {
			var name string
			var c columnInfo
			if err := rows.Scan(&name, &c.Type, &c.NotNull, &c.Default, &c.PK); err != nil {
				t.Fatal(err)
			}
			cols[name] = c
		}
		rows.Close()
		out[table] = cols
	}
	return out
}

// foreignKeysOf returns table -> sorted "column -> parent(column)" edges.
func foreignKeysOf(t *testing.T, db *sql.DB) map[string][]string {
	t.Helper()
	out := map[string][]string{}
	for _, table := range tableNamesOf(t, db) {
		rows, err := db.Query(`SELECT "from", "table", "to" FROM pragma_foreign_key_list(?)`, table)
		if err != nil {
			t.Fatal(err)
		}
		edges := []string{}
		for rows.Next() {
			var from, parent string
			var to sql.NullString
			if err := rows.Scan(&from, &parent, &to); err != nil {
				t.Fatal(err)
			}
			edges = append(edges, from+" -> "+parent+"("+to.String+")")
		}
		rows.Close()
		sort.Strings(edges)
		out[table] = edges
	}
	return out
}

func tableNamesOf(t *testing.T, db *sql.DB) []string {
	t.Helper()
	rows, err := db.Query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var names []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			t.Fatal(err)
		}
		names = append(names, name)
	}
	return names
}

// knownMigrationDifferences are the column-level differences between a migrated
// database and a fresh one that are accepted on purpose, as
// "table.column" -> {fresh, migrated}. Each needs its reason at the migration
// that causes it. Listed exactly — rather than skipping the column — so the
// test still fails if the difference changes, spreads, or disappears.
var knownMigrationDifferences = map[string][2]string{
	// migrateV2: SQLite cannot ALTER a column default. The client always sends
	// priority, so only an INSERT that omits it would see the old default.
	"task.priority": {
		"type=INTEGER notnull=true default=4 pk=0",
		"type=INTEGER notnull=true default=3 pk=0",
	},
}

func TestMigrateV1MatchesFresh(t *testing.T) {
	fresh, _, _ := openTestDB(t)

	path := createV1DB(t)
	migrated, epoch, err := openDB(path)
	if err != nil {
		t.Fatalf("openDB on a v1 database: %v", err)
	}
	defer migrated.Close()

	if got := userVersion(t, migrated); got != latestSchemaVersion() {
		t.Fatalf("migrated user_version = %d, want %d", got, latestSchemaVersion())
	}
	if epoch != v1Epoch {
		t.Fatalf("epoch changed by migration: %s -> %s", v1Epoch, epoch)
	}

	if f, m := tableNamesOf(t, fresh), tableNamesOf(t, migrated); !reflect.DeepEqual(f, m) {
		t.Fatalf("tables differ:\n fresh:    %v\n migrated: %v", f, m)
	}
	freshCols := columnsOf(t, fresh)
	migratedCols := columnsOf(t, migrated)
	seenKnown := map[string]bool{}
	for table, cols := range freshCols {
		names := map[string]bool{}
		for name := range cols {
			names[name] = true
		}
		for name := range migratedCols[table] {
			names[name] = true
		}
		for name := range names {
			key := table + "." + name
			f, inFresh := cols[name]
			m, inMigrated := migratedCols[table][name]
			switch {
			case !inFresh:
				t.Errorf("%s exists only in the migrated database (%s)", key, m)
			case !inMigrated:
				t.Errorf("%s is missing from the migrated database (fresh: %s)", key, f)
			case f != m:
				if want, ok := knownMigrationDifferences[key]; ok && want == [2]string{f.String(), m.String()} {
					seenKnown[key] = true
					continue
				}
				t.Errorf("%s differs:\n fresh:    %s\n migrated: %s", key, f, m)
			}
		}
	}
	for key := range knownMigrationDifferences {
		if !seenKnown[key] {
			t.Errorf("known difference %s no longer occurs as recorded; update knownMigrationDifferences", key)
		}
	}

	if f, m := foreignKeysOf(t, fresh), foreignKeysOf(t, migrated); !reflect.DeepEqual(f, m) {
		t.Errorf("foreign keys differ:\n fresh:    %v\n migrated: %v", f, m)
	}

	// Every synced table must be readable through the sync metadata.
	for _, table := range tableOrder {
		meta := tables[table]
		query := "SELECT " + strings.Join(meta.writable(), ", ") + " FROM " + table + " LIMIT 0"
		if _, err := migrated.Exec(query); err != nil {
			t.Errorf("migrated table %s does not match sync metadata: %v", table, err)
		}
	}
}

func TestMigrateV1BackfillsExistingRows(t *testing.T) {
	path := createV1DB(t)
	db, _, err := openDB(path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// Read back in WIRE format, the way a pull serves them. These are the
	// values the client's IndexedDB v3 migration backfills too; if the two
	// disagree, every row that existed before the upgrade diverges.
	want := map[string]map[string]any{
		"project": {
			"id": "p1", "name": "", "description": "Planee",
			"updated_at": "2026-01-01T00:00:00.000Z", "deleted_at": nil, "server_seq": int64(1),
			"field_updated_at": map[string]any{},
		},
		"version": {
			"id": "v1", "number": "0.1.0", "project": "p1", "description": nil, "completed": false,
			"updated_at": "2026-01-01T00:00:01.000Z", "deleted_at": nil, "server_seq": int64(2),
			"field_updated_at": map[string]any{},
		},
		"task": {
			"id": "t1", "project": "p1", "title": "", "task_type": "feature",
			"description": "Write the migration", "priority": int64(2), "subtasks": nil,
			"updated_at": "2026-01-01T00:00:02.000Z", "deleted_at": nil, "server_seq": int64(3),
			"field_updated_at": map[string]any{},
		},
		"version_task": {
			"id": "vt1", "version": "v1", "task": "t1", "status": "todo", "position": float64(0),
			"updated_at": "2026-01-01T00:00:03.000Z", "deleted_at": "2026-01-02T00:00:00.000Z",
			"server_seq": int64(4), "field_updated_at": map[string]any{},
		},
	}
	ids := map[string]string{"project": "p1", "version": "v1", "task": "t1", "version_task": "vt1"}
	for table, id := range ids {
		got, err := readRow(db, table, tables[table], id)
		if err != nil {
			t.Fatalf("read %s/%s: %v", table, id, err)
		}
		if !reflect.DeepEqual(got, want[table]) {
			t.Errorf("%s/%s after migration:\n got:  %#v\n want: %#v", table, id, got, want[table])
		}
	}

	// The dropped column is really gone, not just absent from the metadata.
	if _, err := db.Exec("SELECT version FROM project"); err == nil {
		t.Error("project.version still exists after migration")
	}

	var lastSeq int64
	if err := db.QueryRow("SELECT last_seq FROM sync_state WHERE id = 1").Scan(&lastSeq); err != nil {
		t.Fatal(err)
	}
	if lastSeq != 4 {
		t.Errorf("last_seq = %d after migration, want 4 (a migration must not touch the sync counter)", lastSeq)
	}
}

func TestMigrateReopenIsNoOp(t *testing.T) {
	path := createV1DB(t)
	db, epoch, err := openDB(path)
	if err != nil {
		t.Fatal(err)
	}
	before := columnsOf(t, db)
	rowBefore, err := readRow(db, "task", tables["task"], "t1")
	if err != nil {
		t.Fatal(err)
	}
	db.Close()

	// A second start must not re-run anything. migrateV2's DROP COLUMN would
	// fail outright if it did, so an error here is the loud version of this.
	db2, epoch2, err := openDB(path)
	if err != nil {
		t.Fatalf("reopening a migrated database: %v", err)
	}
	defer db2.Close()
	if epoch2 != epoch {
		t.Fatalf("epoch changed on reopen: %s -> %s", epoch, epoch2)
	}
	if got := userVersion(t, db2); got != latestSchemaVersion() {
		t.Fatalf("user_version = %d on reopen, want %d", got, latestSchemaVersion())
	}
	if after := columnsOf(t, db2); !reflect.DeepEqual(before, after) {
		t.Fatalf("columns changed on reopen:\n before: %v\n after:  %v", before, after)
	}
	rowAfter, err := readRow(db2, "task", tables["task"], "t1")
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(rowBefore, rowAfter) {
		t.Fatalf("row changed on reopen:\n before: %#v\n after:  %#v", rowBefore, rowAfter)
	}
}

func TestOpenDBRefusesNewerSchema(t *testing.T) {
	path := filepath.Join(t.TempDir(), "future.db")
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(fmt.Sprintf("PRAGMA user_version = %d", latestSchemaVersion()+1)); err != nil {
		t.Fatal(err)
	}
	db.Close()
	if db2, _, err := openDB(path); err == nil {
		db2.Close()
		t.Fatal("openDB accepted a database from a newer build")
	}
}

// A migration that fails must leave the database exactly at its old version,
// so the next start retries it instead of skipping half-applied work.
func TestFailedMigrationRollsBack(t *testing.T) {
	path := createV1DB(t)
	saved := migrations
	t.Cleanup(func() { migrations = saved })
	migrations = []func(*sql.Tx) error{func(tx *sql.Tx) error {
		if err := migrateV2(tx); err != nil {
			return err
		}
		return fmt.Errorf("simulated failure after the DDL ran")
	}}

	if db, _, err := openDB(path); err == nil {
		db.Close()
		t.Fatal("openDB succeeded despite a failing migration")
	}

	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if got := userVersion(t, db); got != 1 {
		t.Fatalf("user_version = %d after a failed migration, want 1", got)
	}
	if _, err := db.Exec("SELECT version FROM project"); err != nil {
		t.Fatalf("the failed migration's DROP COLUMN was not rolled back: %v", err)
	}
	if _, err := db.Exec("SELECT name FROM project"); err == nil {
		t.Fatal("the failed migration's ADD COLUMN was not rolled back")
	}
}
