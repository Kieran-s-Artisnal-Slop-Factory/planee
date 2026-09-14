// dbdump prints every user table of a sqlite database as JSON.
//
// It exists for the sync test harness's "what the server actually STORED" leg.
// Reading the file directly, rather than trusting /sync/pull, is what catches
// a value the server mangles on write but re-derives on read — a pull-only
// view launders exactly that class of corruption.
package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"os"

	_ "modernc.org/sqlite"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: dbdump <path-to-db>")
		os.Exit(2)
	}
	db, err := sql.Open("sqlite", "file:"+os.Args[1]+"?mode=ro")
	if err != nil {
		fail(err)
	}
	defer db.Close()

	names, err := tableNames(db)
	if err != nil {
		fail(err)
	}
	out := map[string][]map[string]any{}
	for _, name := range names {
		rows, err := dumpTable(db, name)
		if err != nil {
			fail(err)
		}
		out[name] = rows
	}
	if err := json.NewEncoder(os.Stdout).Encode(out); err != nil {
		fail(err)
	}
}

func tableNames(db *sql.DB) ([]string, error) {
	rows, err := db.Query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'sync_state'`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var names []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		names = append(names, name)
	}
	return names, rows.Err()
}

func dumpTable(db *sql.DB, name string) ([]map[string]any, error) {
	rows, err := db.Query("SELECT * FROM " + name)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	cols, err := rows.Columns()
	if err != nil {
		return nil, err
	}
	out := []map[string]any{}
	for rows.Next() {
		vals := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			return nil, err
		}
		row := map[string]any{}
		for i, col := range cols {
			v := vals[i]
			if b, ok := v.([]byte); ok {
				v = string(b)
			}
			row[col] = v
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}
