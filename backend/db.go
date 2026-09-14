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
const serverDDL = `
CREATE TABLE sync_state (
    id       INTEGER PRIMARY KEY CHECK (id = 1),
    last_seq INTEGER NOT NULL,
    epoch    TEXT NOT NULL
);
`

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
	dsn := fmt.Sprintf("file:%s?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)", path)
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, "", err
	}
	if err := db.Ping(); err != nil {
		return nil, "", err
	}

	var version int
	if err := db.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
		return nil, "", err
	}
	if version == 0 {
		if _, err := db.Exec(schemaSQL); err != nil {
			return nil, "", fmt.Errorf("apply schema: %w", err)
		}
		if _, err := db.Exec(serverDDL); err != nil {
			return nil, "", fmt.Errorf("apply server ddl: %w", err)
		}
		epoch, err := newEpoch()
		if err != nil {
			return nil, "", err
		}
		if _, err := db.Exec("INSERT INTO sync_state (id, last_seq, epoch) VALUES (1, 0, ?)", epoch); err != nil {
			return nil, "", err
		}
		if _, err := db.Exec("PRAGMA user_version = 1"); err != nil {
			return nil, "", err
		}
	}

	var epoch string
	if err := db.QueryRow("SELECT epoch FROM sync_state WHERE id = 1").Scan(&epoch); err != nil {
		return nil, "", fmt.Errorf("read sync epoch (database created by an older build?): %w", err)
	}
	return db, epoch, nil
}
