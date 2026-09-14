// sqlexec runs the SQL script on stdin against a sqlite database file,
// creating the file if it does not exist.
//
// It exists for the sync test harness, which uses it to build a database the
// way an OLDER server build left it (an old schema, old rows, an old
// user_version) before starting the current server on that file — so the
// server-side migration runs for real, on the same modernc sqlite the server
// uses, with no sqlite3 CLI required. Not part of the shipped server.
package main

import (
	"database/sql"
	"fmt"
	"io"
	"os"

	_ "modernc.org/sqlite"
)

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: sqlexec <path-to-db> < script.sql")
		os.Exit(2)
	}
	script, err := io.ReadAll(os.Stdin)
	if err != nil {
		fail(err)
	}
	db, err := sql.Open("sqlite", "file:"+os.Args[1])
	if err != nil {
		fail(err)
	}
	defer db.Close()
	// One Exec runs every statement in the script, in order, and stops at the
	// first error.
	if _, err := db.Exec(string(script)); err != nil {
		fail(err)
	}
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}
