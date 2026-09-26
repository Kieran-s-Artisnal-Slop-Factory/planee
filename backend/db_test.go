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

// schemaV2SQL is the schema as the v2 build shipped it. Frozen for the same
// reason: a server CREATED by a v2 build (rather than migrated there from v1)
// looks like this.
//
//go:embed testdata/schema_v2.sql
var schemaV2SQL string

// v2Epoch is the sync identity of the v2 fixture database.
const v2Epoch = "fedcba9876543210fedcba9876543210"

// schemaV3SQL is the schema as the v3 build (0.1.0 through Checkpoint 4c)
// shipped it. Frozen: a server created by that build looks like this.
//
//go:embed testdata/schema_v3.sql
var schemaV3SQL string

// v3Epoch is the sync identity of the v3 fixture database.
const v3Epoch = "33333333333333333333333333333333"

// createFixtureDB builds a database file from the given statements and returns
// its path. The statements must include the schema, serverDDL, sync_state and
// the PRAGMA user_version the old build left.
func createFixtureDB(t *testing.T, name string, stmts []string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), name+".db")
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, stmt := range stmts {
		if _, err := db.Exec(stmt); err != nil {
			t.Fatalf("build %s fixture: %v\n%s", name, err, stmt)
		}
	}
	return path
}

// createV1DB writes a database as the v1 build left it — schema, server
// bookkeeping, user_version 1 — holding a few real rows, and returns its path.
func createV1DB(t *testing.T) string {
	t.Helper()
	return createFixtureDB(t, "v1", []string{
		schemaV1SQL,
		serverDDL,
		"INSERT INTO sync_state (id, last_seq, epoch) VALUES (1, 5, '" + v1Epoch + "')",
		`INSERT INTO project (id, description, version, updated_at, deleted_at, server_seq)
		 VALUES ('p1', 'Planee', '0.1.0', '2026-01-01T00:00:00.000Z', NULL, 1)`,
		`INSERT INTO version (id, number, project, updated_at, deleted_at, server_seq)
		 VALUES ('v1', '0.1.0', 'p1', '2026-01-01T00:00:01.000Z', NULL, 2)`,
		`INSERT INTO task (id, project, description, priority, subtasks, updated_at, deleted_at, server_seq)
		 VALUES ('t1', 'p1', 'Write the migration', 2, NULL, '2026-01-01T00:00:02.000Z', NULL, 3)`,
		`INSERT INTO version_task (id, version, task, updated_at, deleted_at, server_seq)
		 VALUES ('vt1', 'v1', 't1', '2026-01-01T00:00:03.000Z', '2026-01-02T00:00:00.000Z', 4)`,
		`INSERT INTO preferences (id, default_task_type, updated_at, deleted_at, server_seq, field_updated_at)
		 VALUES ('singleton', 'bug', '2026-01-01T00:00:04.000Z', NULL, 5,
		         '{"default_task_type":"2026-01-01T00:00:04.000Z","deleted_at":"2026-01-01T00:00:04.000Z"}')`,
		"PRAGMA user_version = 1",
	})
}

// createV2DB writes a database as a v2 build CREATED it (schema_v2.sql applied
// fresh, user_version 2) holding a preferences row and a task, and returns its
// path.
func createV2DB(t *testing.T) string {
	t.Helper()
	return createFixtureDB(t, "v2", []string{
		schemaV2SQL,
		serverDDL,
		"INSERT INTO sync_state (id, last_seq, epoch) VALUES (1, 3, '" + v2Epoch + "')",
		`INSERT INTO project (id, name, description, updated_at, deleted_at, server_seq, field_updated_at)
		 VALUES ('p1', 'Planee', '', '2026-02-01T00:00:00.000Z', NULL, 1, '{}')`,
		`INSERT INTO task (id, project, title, task_type, description, priority, subtasks, updated_at, deleted_at, server_seq, field_updated_at)
		 VALUES ('t1', 'p1', 'Add a preference', 'feature', NULL, 4, NULL, '2026-02-01T00:00:01.000Z', NULL, 2, '{}')`,
		`INSERT INTO preferences (id, default_task_type, updated_at, deleted_at, server_seq, field_updated_at)
		 VALUES ('singleton', 'cleanup', '2026-02-01T00:00:02.000Z', '2026-02-02T00:00:00.000Z', 3,
		         '{"default_task_type":"2026-02-01T00:00:02.000Z","deleted_at":"2026-02-02T00:00:00.000Z"}')`,
		"PRAGMA user_version = 2",
	})
}

// createV3DB writes a database as a v3 build CREATED it (schema_v3.sql applied
// fresh, user_version 3) holding a task and a preferences row with a
// non-default count, and returns its path.
func createV3DB(t *testing.T) string {
	t.Helper()
	return createFixtureDB(t, "v3", []string{
		schemaV3SQL,
		serverDDL,
		"INSERT INTO sync_state (id, last_seq, epoch) VALUES (1, 3, '" + v3Epoch + "')",
		`INSERT INTO project (id, name, description, updated_at, deleted_at, server_seq, field_updated_at)
		 VALUES ('p1', 'Planee', '', '2026-03-01T00:00:00.000Z', NULL, 1, '{}')`,
		`INSERT INTO task (id, project, title, task_type, description, priority, subtasks, updated_at, deleted_at, server_seq, field_updated_at)
		 VALUES ('t1', 'p1', 'Hide the cheat sheet', 'feature', NULL, 4, NULL, '2026-03-01T00:00:02.000Z', NULL, 3, '{}')`,
		`INSERT INTO preferences (id, default_task_type, recent_issues_count, updated_at, deleted_at, server_seq, field_updated_at)
		 VALUES ('singleton', 'exploration', 3, '2026-03-01T00:00:01.000Z', NULL, 2,
		         '{"default_task_type":"2026-03-01T00:00:01.000Z","recent_issues_count":"2026-03-01T00:00:01.000Z","deleted_at":"2026-03-01T00:00:01.000Z"}')`,
		"PRAGMA user_version = 3",
	})
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
//
// These are for a database that started at v1. One created fresh by a v2 build
// never ran migrateV2, so it has none of them (v2KnownDifferences).
var knownMigrationDifferences = map[string][2]string{
	// migrateV2: SQLite cannot ALTER a column default. The client always sends
	// priority, so only an INSERT that omits it would see the old default.
	"task.priority": {
		"type=INTEGER notnull=true default=4 pk=0",
		"type=INTEGER notnull=true default=3 pk=0",
	},
}

// v2KnownDifferences: a database created by a v2 (or later) build has none.
var v2KnownDifferences = map[string][2]string{}

func TestMigrateV1MatchesFresh(t *testing.T) {
	assertMigratedMatchesFresh(t, createV1DB(t), v1Epoch, knownMigrationDifferences)
}

func TestMigrateV2MatchesFresh(t *testing.T) {
	assertMigratedMatchesFresh(t, createV2DB(t), v2Epoch, v2KnownDifferences)
}

func TestMigrateV3MatchesFresh(t *testing.T) {
	assertMigratedMatchesFresh(t, createV3DB(t), v3Epoch, v2KnownDifferences)
}

// assertMigratedMatchesFresh opens the old database at path (running every
// remaining migration) and checks it against a fresh database: same tables,
// same columns by name, same foreign keys — except exactly `known`.
func assertMigratedMatchesFresh(t *testing.T, path, wantEpoch string, known map[string][2]string) {
	t.Helper()
	fresh, _, _ := openTestDB(t)

	migrated, epoch, err := openDB(path)
	if err != nil {
		t.Fatalf("openDB on an old database: %v", err)
	}
	defer migrated.Close()

	if got := userVersion(t, migrated); got != latestSchemaVersion() {
		t.Fatalf("migrated user_version = %d, want %d", got, latestSchemaVersion())
	}
	if epoch != wantEpoch {
		t.Fatalf("epoch changed by migration: %s -> %s", wantEpoch, epoch)
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
				if want, ok := known[key]; ok && want == [2]string{f.String(), m.String()} {
					seenKnown[key] = true
					continue
				}
				t.Errorf("%s differs:\n fresh:    %s\n migrated: %s", key, f, m)
			}
		}
	}
	for key := range known {
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
		// migrateV3 (IndexedDB v4 backfillV4): recent_issues_count 6;
		// migrateV4 (IndexedDB v5 backfillV5): show_keybind_sheet true; and the
		// stamp map left exactly as it was.
		"preferences": {
			"id": "singleton", "default_task_type": "bug", "recent_issues_count": int64(6), "show_keybind_sheet": true,
			"updated_at": "2026-01-01T00:00:04.000Z", "deleted_at": nil, "server_seq": int64(5),
			"field_updated_at": map[string]any{
				"default_task_type": "2026-01-01T00:00:04.000Z", "deleted_at": "2026-01-01T00:00:04.000Z",
			},
		},
	}
	ids := map[string]string{"project": "p1", "version": "v1", "task": "t1", "version_task": "vt1", "preferences": "singleton"}
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
	if lastSeq != 5 {
		t.Errorf("last_seq = %d after migration, want 5 (a migration must not touch the sync counter)", lastSeq)
	}
}

func TestMigrateV2BackfillsExistingRows(t *testing.T) {
	path := createV2DB(t)
	db, _, err := openDB(path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// A tombstoned preferences row upgrades too; its stamps stay as they were.
	want := map[string]any{
		"id": "singleton", "default_task_type": "cleanup", "recent_issues_count": int64(6), "show_keybind_sheet": true,
		"updated_at": "2026-02-01T00:00:02.000Z", "deleted_at": "2026-02-02T00:00:00.000Z", "server_seq": int64(3),
		"field_updated_at": map[string]any{
			"default_task_type": "2026-02-01T00:00:02.000Z", "deleted_at": "2026-02-02T00:00:00.000Z",
		},
	}
	got, err := readRow(db, "preferences", tables["preferences"], "singleton")
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("preferences after migration:\n got:  %#v\n want: %#v", got, want)
	}

	// Rows in other tables are untouched by migrateV3 and migrateV4.
	task, err := readRow(db, "task", tables["task"], "t1")
	if err != nil {
		t.Fatal(err)
	}
	wantTask := map[string]any{
		"id": "t1", "project": "p1", "title": "Add a preference", "task_type": "feature",
		"description": nil, "priority": int64(4), "subtasks": nil,
		"updated_at": "2026-02-01T00:00:01.000Z", "deleted_at": nil, "server_seq": int64(2),
		"field_updated_at": map[string]any{},
	}
	if !reflect.DeepEqual(task, wantTask) {
		t.Errorf("task after migration:\n got:  %#v\n want: %#v", task, wantTask)
	}

	var lastSeq int64
	if err := db.QueryRow("SELECT last_seq FROM sync_state WHERE id = 1").Scan(&lastSeq); err != nil {
		t.Fatal(err)
	}
	if lastSeq != 3 {
		t.Errorf("last_seq = %d after migration, want 3 (a migration must not touch the sync counter)", lastSeq)
	}
}

func TestMigrateV3BackfillsExistingRows(t *testing.T) {
	path := createV3DB(t)
	db, _, err := openDB(path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// The cheat sheet is on, as it was before the column existed; the count
	// someone chose and every stamp stay as they were.
	want := map[string]any{
		"id": "singleton", "default_task_type": "exploration", "recent_issues_count": int64(3), "show_keybind_sheet": true,
		"updated_at": "2026-03-01T00:00:01.000Z", "deleted_at": nil, "server_seq": int64(2),
		"field_updated_at": map[string]any{
			"default_task_type":   "2026-03-01T00:00:01.000Z",
			"recent_issues_count": "2026-03-01T00:00:01.000Z",
			"deleted_at":          "2026-03-01T00:00:01.000Z",
		},
	}
	got, err := readRow(db, "preferences", tables["preferences"], "singleton")
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("preferences after migration:\n got:  %#v\n want: %#v", got, want)
	}

	var lastSeq int64
	if err := db.QueryRow("SELECT last_seq FROM sync_state WHERE id = 1").Scan(&lastSeq); err != nil {
		t.Fatal(err)
	}
	if lastSeq != 3 {
		t.Errorf("last_seq = %d after migration, want 3 (a migration must not touch the sync counter)", lastSeq)
	}
}

func TestMigrateReopenIsNoOp(t *testing.T) {
	for name, create := range map[string]func(*testing.T) string{"v1": createV1DB, "v2": createV2DB, "v3": createV3DB} {
		t.Run(name, func(t *testing.T) {
			path := create(t)
			db, epoch, err := openDB(path)
			if err != nil {
				t.Fatal(err)
			}
			before := columnsOf(t, db)
			rowsBefore := map[string]map[string]any{}
			for table, id := range map[string]string{"task": "t1", "preferences": "singleton"} {
				if rowsBefore[table], err = readRow(db, table, tables[table], id); err != nil {
					t.Fatal(err)
				}
			}
			db.Close()

			// A second start must not re-run anything. migrateV2's DROP COLUMN
			// and the later ADD COLUMNs would fail outright if it did, so an
			// error here is the loud version of this.
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
			for table, rowBefore := range rowsBefore {
				id, _ := rowBefore["id"].(string)
				rowAfter, err := readRow(db2, table, tables[table], id)
				if err != nil {
					t.Fatal(err)
				}
				if !reflect.DeepEqual(rowBefore, rowAfter) {
					t.Fatalf("%s row changed on reopen:\n before: %#v\n after:  %#v", table, rowBefore, rowAfter)
				}
			}
		})
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

// The same for a later step: v2 -> v3 failing leaves the database at v2.
func TestFailedMigrationV3RollsBack(t *testing.T) {
	path := createV2DB(t)
	saved := migrations
	t.Cleanup(func() { migrations = saved })
	migrations = []func(*sql.Tx) error{migrateV2, func(tx *sql.Tx) error {
		if err := migrateV3(tx); err != nil {
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
	if got := userVersion(t, db); got != 2 {
		t.Fatalf("user_version = %d after a failed migration, want 2", got)
	}
	if _, err := db.Exec("SELECT recent_issues_count FROM preferences"); err == nil {
		t.Fatal("the failed migration's ADD COLUMN was not rolled back")
	}
}

// And v3 -> v4: a failure leaves a v3 database at v3.
func TestFailedMigrationV4RollsBack(t *testing.T) {
	path := createV3DB(t)
	saved := migrations
	t.Cleanup(func() { migrations = saved })
	migrations = []func(*sql.Tx) error{migrateV2, migrateV3, func(tx *sql.Tx) error {
		if err := migrateV4(tx); err != nil {
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
	if got := userVersion(t, db); got != 3 {
		t.Fatalf("user_version = %d after a failed migration, want 3", got)
	}
	if _, err := db.Exec("SELECT show_keybind_sheet FROM preferences"); err == nil {
		t.Fatal("the failed migration's ADD COLUMN was not rolled back")
	}
}
