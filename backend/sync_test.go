package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
)

func testServer(t *testing.T) *server {
	t.Helper()
	db, epoch, path := openTestDB(t)
	return &server{db: db, dbPath: path, epoch: epoch}
}

func push(t *testing.T, s *server, rows map[string][]map[string]any) pushResponse {
	t.Helper()
	body, err := json.Marshal(pushRequest{Rows: rows})
	if err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	s.handlePush(rec, httptest.NewRequest(http.MethodPost, "/sync/push", bytes.NewReader(body)))
	if rec.Code != http.StatusOK {
		t.Fatalf("push: %d %s", rec.Code, rec.Body.String())
	}
	var res pushResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil {
		t.Fatal(err)
	}
	if len(res.Rejected) > 0 {
		t.Fatalf("push rejected rows: %+v", res.Rejected)
	}
	return res
}

// pullRows decodes a full pull with UseNumber, so an integer that came back as
// a float (or the reverse) is visible in the comparison.
func pullRows(t *testing.T, s *server) map[string][]map[string]any {
	t.Helper()
	rec := httptest.NewRecorder()
	s.handlePull(rec, httptest.NewRequest(http.MethodGet, "/sync/pull?since=0", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("pull: %d %s", rec.Code, rec.Body.String())
	}
	dec := json.NewDecoder(bytes.NewReader(rec.Body.Bytes()))
	dec.UseNumber()
	var body struct {
		Rows map[string][]map[string]any `json:"rows"`
	}
	if err := dec.Decode(&body); err != nil {
		t.Fatal(err)
	}
	return body.Rows
}

func TestPushPullNewColumnTypesRoundTrip(t *testing.T) {
	s := testServer(t)
	const at = "2026-03-01T00:00:00.000Z"
	push(t, s, map[string][]map[string]any{
		"version": {{
			"id": "v1", "number": "0.10.0", "project": "p1", "description": nil, "completed": true,
			"updated_at": at, "deleted_at": nil, "field_updated_at": map[string]any{},
		}},
		"version_task": {{
			"id": "vt1", "version": "v1", "task": "t1", "status": "in_progress", "position": 0.30000000000000004,
			"updated_at": at, "deleted_at": nil, "field_updated_at": map[string]any{},
		}},
		"asset": {{
			"id": "a1", "name": "x.png", "mime": "image/png", "size": 5242880, "data": "iVBORw0KGgo=",
			"updated_at": at, "deleted_at": nil,
		}},
	})

	rows := pullRows(t, s)
	check := func(table, col string, want any) {
		t.Helper()
		if len(rows[table]) != 1 {
			t.Fatalf("%s: got %d rows", table, len(rows[table]))
		}
		if got := rows[table][0][col]; !reflect.DeepEqual(got, want) {
			t.Errorf("%s.%s = %#v (%T), want %#v (%T)", table, col, got, got, want, want)
		}
	}
	check("version", "completed", true) // a bool, not 1
	check("version", "description", nil)
	check("version_task", "status", "in_progress")
	check("version_task", "position", json.Number("0.30000000000000004"))
	check("asset", "size", json.Number("5242880")) // no ".0", no exponent
	if _, ok := rows["asset"][0][fieldTSColumn]; ok {
		t.Error("asset is whole-row LWW and must not carry field_updated_at")
	}
}

// A new fieldMerge row is stored with one stamp per data column — whatever
// shape of stamp map the client sent — so it matches what every later merge
// (server or client) produces.
func TestPushCanonicalisesStampsOnInsert(t *testing.T) {
	s := testServer(t)
	const at = "2026-03-01T00:00:00.000Z"
	const earlier = "2026-02-01T00:00:00.000Z"
	push(t, s, map[string][]map[string]any{
		"task": {{
			"id": "t1", "project": "p1", "title": "T", "task_type": "bug", "description": nil,
			"priority": 4, "subtasks": nil, "updated_at": at, "deleted_at": nil,
			// a stamp for a bookkeeping column, and stamps missing for most fields
			"field_updated_at": map[string]any{"updated_at": at, "title": earlier},
		}},
	})
	got := pullRows(t, s)["task"][0][fieldTSColumn]
	want := map[string]any{
		"project": at, "title": earlier, "task_type": at, "description": at,
		"priority": at, "subtasks": at, "deleted_at": at,
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("field_updated_at = %#v\nwant %#v", got, want)
	}
}
