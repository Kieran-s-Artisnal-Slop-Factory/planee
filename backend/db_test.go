package main

import (
	"database/sql"
	"path/filepath"
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

	var version int
	if err := db.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
		t.Fatal(err)
	}
	if version < 1 {
		t.Fatalf("user_version = %d, want >= 1", version)
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
