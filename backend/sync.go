package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"sort"
	"strconv"
	"strings"
)

// The sync engine is generic over table metadata: rows travel as JSON objects
// and the metadata below mirrors sql/schema.sql exactly — this file is
// GENERATED from your schema; regenerate (or edit both) when it changes.
type tableMeta struct {
	columns  []string
	jsonCols map[string]bool // stored as JSON text, wire format = array/object
	boolCols map[string]bool // stored as INTEGER 0/1, wire format = bool
	// fieldMerge tables reconcile per FIELD using the field_updated_at map
	// instead of whole-row last-write-wins, so two devices editing different
	// fields of the same row both keep their edit.
	fieldMerge bool
}

func set(names ...string) map[string]bool {
	m := make(map[string]bool, len(names))
	for _, n := range names {
		m[n] = true
	}
	return m
}

var syncFields = []string{"updated_at", "deleted_at", "server_seq"}

// fieldTSColumn holds the per-field last-write-wins timestamps on fieldMerge
// tables (JSON object: column name -> UTC ISO 8601).
const fieldTSColumn = "field_updated_at"

func cols(own ...string) []string {
	return append(own, syncFields...)
}

// tableOrder keeps responses deterministic; parents before children so a
// restoring client sees referenced rows first. It is sent to the client as
// "order" so the apply loop can follow it rather than Go's map iteration.
// Enum tables are deliberately absent from tableOrder and tables: their rows
// are seeded by sql/schema.sql with the same ids every client seeds for
// itself, so a push naming one is refused as unknown and a pull never carries
// one. Static here: task_type, status_type.
var tableOrder = []string{
	"project",
	"version",
	"task",
	"version_task",
	"asset",
	"preferences",
}

var tables = map[string]tableMeta{
	"project": {
		columns:    cols("id", "name", "description"),
		fieldMerge: true,
	},
	"version": {
		columns:    cols("id", "number", "project", "description", "completed"),
		boolCols:   set("completed"),
		fieldMerge: true,
	},
	"task": {
		columns:    cols("id", "project", "title", "task_type", "description", "priority", "subtasks"),
		fieldMerge: true,
	},
	"version_task": {
		columns:    cols("id", "version", "task", "status", "position"),
		fieldMerge: true,
	},
	// Whole-row last-write-wins on purpose: an asset is replaced as a unit.
	"asset": {
		columns: cols("id", "name", "mime", "size", "data"),
	},
	"preferences": {
		columns:    cols("id", "default_task_type", "recent_issues_count"),
		fieldMerge: true,
	},
}

func (m tableMeta) writable() []string {
	if !m.fieldMerge {
		return m.columns
	}
	return append(append([]string{}, m.columns...), fieldTSColumn)
}

type server struct {
	db     *sql.DB
	dbPath string
	// epoch identifies THIS database. A client that sees it change knows the
	// server_seq counter it has been tracking no longer exists and resets its
	// cursor — without it, pointing an app at a rebuilt server silently
	// under-fetches forever.
	epoch string
}

type pushRequest struct {
	Rows map[string][]map[string]any `json:"rows"`
}

type acceptedRow struct {
	Table     string `json:"table"`
	ID        string `json:"id"`
	ServerSeq int64  `json:"server_seq"`
}

type rejectedRow struct {
	Table  string `json:"table"`
	ID     string `json:"id"`
	Reason string `json:"reason"`
}

type pushResponse struct {
	Accepted []acceptedRow `json:"accepted"`
	// Conflicts carries the authoritative row for every push the server
	// declined under last-write-wins. The pusher's pull cursor is already past
	// that row's server_seq, so a plain pull would never re-offer the winner —
	// without this the losing device keeps its rejected edit forever.
	Conflicts map[string][]map[string]any `json:"conflicts,omitempty"`
	// Rejected carries rows the server could not store at all. Reported rather
	// than fatal: one malformed row must not stop the whole batch (and every
	// batch after it) from landing.
	Rejected  []rejectedRow `json:"rejected,omitempty"`
	LatestSeq int64         `json:"latestSeq"`
	Epoch     string        `json:"epoch"`
}

// toDBValue converts a wire value to what the sqlite column stores.
func toDBValue(meta tableMeta, col string, row map[string]any) (any, error) {
	v, ok := row[col]
	if !ok || v == nil {
		return nil, nil
	}
	if meta.jsonCols[col] || col == fieldTSColumn {
		b, err := json.Marshal(v)
		return string(b), err
	}
	if meta.boolCols[col] {
		b, ok := v.(bool)
		if !ok {
			return nil, fmt.Errorf("column %s: expected bool, got %T", col, v)
		}
		if b {
			return 1, nil
		}
		return 0, nil
	}
	switch v.(type) {
	case string, float64:
		return v, nil
	default:
		return nil, fmt.Errorf("column %s: unsupported type %T", col, v)
	}
}

// presentColumns returns the columns this wire row actually carries, in schema
// order. Columns the client omitted are left out of the statement entirely so
// an UPDATE preserves them and an INSERT falls back to the DDL default —
// binding NULL for them instead silently erases data the client never touched.
func presentColumns(meta tableMeta, row map[string]any) []string {
	out := make([]string, 0, len(meta.columns))
	for _, col := range meta.writable() {
		if col == "server_seq" {
			continue // always server-assigned
		}
		if _, ok := row[col]; ok {
			out = append(out, col)
		}
	}
	return out
}

// upsert writes the given columns of one row, preserving every column not
// listed. Returns an error only for rows that cannot be stored at all; SQLite
// rolls back the failing STATEMENT, not the transaction, so the caller can skip
// the row and keep going.
// writeRow stores one accepted row: an UPDATE of exactly the sent columns when
// the row already exists, an INSERT otherwise.
//
// Not one INSERT ... ON CONFLICT DO UPDATE for both cases: SQLite checks the
// INSERT half against every NOT NULL constraint before it ever reaches the
// conflict clause, so a push that omits a NOT NULL column (an optional field
// the client did not touch) failed the whole statement even though the row
// existed and the UPDATE would only have written the sent columns — the exact
// "omitted field is preserved" guarantee the harness checks.
func writeRow(tx *sql.Tx, table string, meta tableMeta, row map[string]any, columns []string, seq int64, exists bool) error {
	names := append(append([]string{}, columns...), "server_seq")
	args := make([]any, 0, len(names)+1)
	for _, col := range names {
		if exists && col == "id" {
			continue
		}
		if col == "server_seq" {
			args = append(args, seq)
			continue
		}
		v, err := toDBValue(meta, col, row)
		if err != nil {
			return err
		}
		args = append(args, v)
	}
	if exists {
		sets := make([]string, 0, len(names))
		for _, col := range names {
			if col != "id" {
				sets = append(sets, col+" = ?")
			}
		}
		args = append(args, row["id"])
		_, err := tx.Exec("UPDATE "+table+" SET "+strings.Join(sets, ", ")+" WHERE id = ?", args...)
		return err
	}
	placeholders := make([]string, len(names))
	for i := range placeholders {
		placeholders[i] = "?"
	}
	_, err := tx.Exec("INSERT INTO "+table+" ("+strings.Join(names, ", ")+") VALUES ("+
		strings.Join(placeholders, ", ")+")", args...)
	return err
}

// readRow loads one full row in wire format, or nil when it does not exist.
func readRow(q interface {
	QueryRow(string, ...any) *sql.Row
}, table string, meta tableMeta, id string) (map[string]any, error) {
	columns := meta.writable()
	vals := make([]any, len(columns))
	ptrs := make([]any, len(columns))
	for i := range vals {
		ptrs[i] = &vals[i]
	}
	query := "SELECT " + strings.Join(columns, ", ") + " FROM " + table + " WHERE id = ?"
	if err := q.QueryRow(query, id).Scan(ptrs...); err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	out := make(map[string]any, len(columns))
	for i, col := range columns {
		out[col] = fromDBValue(meta, col, vals[i])
	}
	return out, nil
}

func fieldStamps(row map[string]any) map[string]string {
	out := map[string]string{}
	raw, ok := row[fieldTSColumn]
	if !ok || raw == nil {
		return out
	}
	if m, ok := raw.(map[string]any); ok {
		for k, v := range m {
			if s, ok := v.(string); ok {
				out[k] = s
			}
		}
	}
	return out
}

func stampFor(stamps map[string]string, col string, fallback string) string {
	if ts, ok := stamps[col]; ok {
		return ts
	}
	return fallback
}

// stampedColumn reports whether a column carries its own entry in
// field_updated_at: every column except the row identity and the row-level
// bookkeeping. deleted_at IS stamped, so a delete merges like any other field.
func stampedColumn(col string) bool {
	return col != "id" && col != "server_seq" && col != "updated_at"
}

// withCanonicalStamps returns a copy of a NEW fieldMerge row whose
// field_updated_at holds exactly one stamp per stamped column: the client's
// stamp where it sent one, otherwise the row's updated_at (the same fallback
// mergeFields and the client apply to a missing stamp), and nothing else.
//
// Stored verbatim instead, the map's shape depends on who wrote the row — a
// client stamps `updated_at` too, a raw or migrated row has no stamps — while
// every LATER merge, here and on each client, rewrites it into this canonical
// shape. The device that created the row then pulls it back, merges, and
// holds a different map than the server and every other device: a permanent
// divergence in bookkeeping that the sync oracle reports on every new row.
func withCanonicalStamps(meta tableMeta, row map[string]any) map[string]any {
	stamps := fieldStamps(row)
	updatedAt, _ := row["updated_at"].(string)
	canonical := make(map[string]any, len(meta.columns))
	for _, col := range meta.columns {
		if stampedColumn(col) {
			canonical[col] = stampFor(stamps, col, updatedAt)
		}
	}
	out := make(map[string]any, len(row)+1)
	for k, v := range row {
		out[k] = v
	}
	out[fieldTSColumn] = canonical
	return out
}

// mergeFields decides which of the incoming row's columns win against the row
// the server holds. A column wins only when its stamp is STRICTLY newer, so an
// exact tie keeps the incumbent — the same direction the client resolves a tie,
// which is what stops the two sides diverging permanently on a millisecond tie.
func mergeFields(meta tableMeta, incoming, existing map[string]any) (winners []string, merged map[string]string, changed bool) {
	inStamps := fieldStamps(incoming)
	exStamps := fieldStamps(existing)
	inUpdated, _ := incoming["updated_at"].(string)
	exUpdated, _ := existing["updated_at"].(string)

	merged = map[string]string{}
	for _, col := range meta.columns {
		if !stampedColumn(col) {
			continue
		}
		exAt := stampFor(exStamps, col, exUpdated)
		merged[col] = exAt
		if _, sent := incoming[col]; !sent {
			continue
		}
		inAt := stampFor(inStamps, col, inUpdated)
		if inAt > exAt {
			winners = append(winners, col)
			merged[col] = inAt
			changed = true
		}
	}
	sort.Strings(winners)
	return winners, merged, changed
}

// POST /sync/push — accept client rows, resolve conflicts, stamp each accepted
// row with the next value of the single global counter.
func (s *server) handlePush(w http.ResponseWriter, r *http.Request) {
	var req pushRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON: "+err.Error(), http.StatusBadRequest)
		return
	}

	tx, err := s.db.Begin()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	defer tx.Rollback()

	var lastSeq int64
	if err := tx.QueryRow("SELECT last_seq FROM sync_state WHERE id = 1").Scan(&lastSeq); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	accepted := []acceptedRow{}
	rejected := []rejectedRow{}
	conflicts := map[string][]map[string]any{}

	// reject records a row the server cannot store. Deliberately non-fatal: a
	// 500 here makes the client retry the same poison payload forever, which
	// halts sync in BOTH directions for that device until someone clears data.
	reject := func(table, id, reason string) {
		rejected = append(rejected, rejectedRow{Table: table, ID: id, Reason: reason})
		slog.Warn("sync push: skipping unstorable row", "table", table, "id", id, "reason", reason)
	}

	for _, table := range tableOrder {
		meta := tables[table]
		for _, row := range req.Rows[table] {
			id, _ := row["id"].(string)
			updatedAt, _ := row["updated_at"].(string)
			if id == "" || updatedAt == "" {
				reject(table, id, "row missing id/updated_at")
				continue
			}

			existing, err := readRow(tx, table, meta, id)
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}

			if meta.fieldMerge && existing == nil {
				row = withCanonicalStamps(meta, row)
			}
			columns := presentColumns(meta, row)
			if meta.fieldMerge && existing != nil {
				winners, mergedStamps, changed := mergeFields(meta, row, existing)
				if !changed {
					// Nothing of ours is newer. Hand back the authoritative row
					// so the pusher merges it instead of keeping its stale copy.
					conflicts[table] = append(conflicts[table], existing)
					continue
				}
				row = mergeRowForWrite(row, existing, winners, mergedStamps)
				columns = append([]string{"id"}, winners...)
				columns = append(columns, "updated_at", fieldTSColumn)
			} else if existing != nil {
				exUpdated, _ := existing["updated_at"].(string)
				// Strictly newer only: an exact tie keeps the incumbent, which
				// is the same way the client resolves it.
				if updatedAt <= exUpdated {
					conflicts[table] = append(conflicts[table], existing)
					continue
				}
			}

			lastSeq++
			if err := writeRow(tx, table, meta, row, columns, lastSeq, existing != nil); err != nil {
				lastSeq-- // the row never landed; don't burn a sequence number
				reject(table, id, err.Error())
				continue
			}
			accepted = append(accepted, acceptedRow{Table: table, ID: id, ServerSeq: lastSeq})
		}
	}

	if _, err := tx.Exec("UPDATE sync_state SET last_seq = ? WHERE id = 1", lastSeq); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if err := tx.Commit(); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	slog.Info("sync push", "accepted", len(accepted), "conflicts", len(conflicts),
		"rejected", len(rejected), "latestSeq", lastSeq)
	writeJSON(w, pushResponse{
		Accepted:  accepted,
		Conflicts: conflicts,
		Rejected:  rejected,
		LatestSeq: lastSeq,
		Epoch:     s.epoch,
	})
}

// mergeRowForWrite builds the row actually written for a fieldMerge table:
// the winning incoming columns, the newer updated_at, and the merged stamp map.
func mergeRowForWrite(incoming, existing map[string]any, winners []string, stamps map[string]string) map[string]any {
	out := map[string]any{"id": incoming["id"]}
	for _, col := range winners {
		out[col] = incoming[col]
	}
	inUpdated, _ := incoming["updated_at"].(string)
	exUpdated, _ := existing["updated_at"].(string)
	if inUpdated > exUpdated {
		out["updated_at"] = inUpdated
	} else {
		out["updated_at"] = exUpdated
	}
	out[fieldTSColumn] = stamps
	return out
}

// GET /sync/pull?since=<server_seq> — return all rows (tombstones included)
// with server_seq greater than the cursor.
//
// The whole read runs in ONE transaction. With a query per table, a push
// committing between two of them is seen by the later table and missed by the
// earlier one, and the cursor then advances past a row that was never
// delivered — a permanently skipped row, on that device, silently.
func (s *server) handlePull(w http.ResponseWriter, r *http.Request) {
	since, err := strconv.ParseInt(r.URL.Query().Get("since"), 10, 64)
	if err != nil {
		since = 0
	}

	// A plain deferred transaction: in WAL mode the read snapshot is taken at
	// the first statement and held until rollback, and it never blocks writers.
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	defer tx.Rollback()

	// The snapshot's own high-water mark. Rows committed after the snapshot are
	// invisible AND carry a higher seq, so advancing the client to this value
	// can never skip one.
	var latest int64
	if err := tx.QueryRow("SELECT last_seq FROM sync_state WHERE id = 1").Scan(&latest); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if latest < since {
		latest = since
	}

	out := map[string][]map[string]any{}
	for _, table := range tableOrder {
		meta := tables[table]
		columns := meta.writable()
		query := "SELECT " + strings.Join(columns, ", ") + " FROM " + table +
			" WHERE server_seq > ? ORDER BY server_seq"
		rows, err := tx.Query(query, since)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		for rows.Next() {
			vals := make([]any, len(columns))
			ptrs := make([]any, len(columns))
			for i := range vals {
				ptrs[i] = &vals[i]
			}
			if err := rows.Scan(ptrs...); err != nil {
				rows.Close()
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			row := make(map[string]any, len(columns))
			for i, col := range columns {
				row[col] = fromDBValue(meta, col, vals[i])
			}
			out[table] = append(out[table], row)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
	}

	writeJSON(w, map[string]any{
		"rows": out,
		// Go serializes maps alphabetically, so the client cannot infer
		// parents-before-children from the response shape. Send the order.
		"order":     tableOrder,
		"latestSeq": latest,
		"epoch":     s.epoch,
	})
}

// fromDBValue converts a sqlite value back to the wire format.
func fromDBValue(meta tableMeta, col string, v any) any {
	if b, ok := v.([]byte); ok {
		v = string(b)
	}
	if v == nil {
		if col == fieldTSColumn {
			return map[string]any{}
		}
		return nil
	}
	if meta.jsonCols[col] || col == fieldTSColumn {
		var parsed any
		if s, ok := v.(string); ok && json.Unmarshal([]byte(s), &parsed) == nil {
			return parsed
		}
		return v
	}
	if meta.boolCols[col] {
		if n, ok := v.(int64); ok {
			return n != 0
		}
	}
	return v
}

// GET /backup — download the sqlite file directly (complements the client's
// JSON export). Checkpoints WAL first so the file is complete.
func (s *server) handleBackup(w http.ResponseWriter, r *http.Request) {
	if _, err := s.db.Exec("PRAGMA wal_checkpoint(TRUNCATE)"); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Disposition", `attachment; filename="planee-backup.db"`)
	w.Header().Set("Content-Type", "application/vnd.sqlite3")
	http.ServeFile(w, r, s.dbPath)
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(v); err != nil {
		slog.Error("write response", "error", err)
	}
}
