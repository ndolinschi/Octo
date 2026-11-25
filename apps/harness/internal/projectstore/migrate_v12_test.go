package projectstore

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"
)

// A database stamped 8, 9, 10 or 11 (no sessions tables) opens, and its stored messages
// become sessions and exchanges: a failed turn without an answer, a stopped
// one, a six-hour gap, rewound messages left out, tool chatter skipped.
func TestMigrateToSchema12BackfillsSessions(t *testing.T) {
	for _, from := range []int{8, 9, 10, 11} {
		t.Run(fmt.Sprintf("from_%d", from), func(t *testing.T) { backfillSessionsFrom(t, from) })
	}
}

func backfillSessionsFrom(t *testing.T, from int) {
	ctx := context.Background()
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	db, err := s.Create(ctx, NewProject{Name: "p", ModelsJSON: "{}", MaxDepth: 1, OrchestratorModel: "m-orch"})
	if err != nil {
		t.Fatal(err)
	}
	pid := db.ID()
	orch, _ := db.Orchestrator(ctx)
	put := func(role, text, at string, stopped, rewound bool) int64 {
		raw, _ := json.Marshal([]map[string]any{{"type": "text", "text": text}})
		if text == "" {
			raw = []byte(`[{"type":"tool_result","tool_use_id":"x","content":"out"}]`)
		}
		var rw any
		if rewound {
			rw = at
		}
		res, err := db.sql.ExecContext(ctx, `INSERT INTO messages (agent_id, role, content_json, created_at, stopped, rewound_at) VALUES (?,?,?,?,?,?)`,
			orch.ID, role, string(raw), at, stopped, rw)
		if err != nil {
			t.Fatal(err)
		}
		id, _ := res.LastInsertId()
		return id
	}
	u1 := put("user", "Первый запрос\nвторая строка", "2026-11-01T09:00:00.000Z", false, false)
	put("assistant", "thinking", "2026-11-01T09:00:02.000Z", false, false)
	put("user", "", "2026-11-01T09:00:03.000Z", false, false)
	a1 := put("assistant", "final one", "2026-11-01T09:00:10.000Z", false, false)
	u2 := put("user", "no answer ever", "2026-11-01T09:05:00.000Z", false, false)
	u3 := put("user", "stopped one", "2026-11-01T09:06:00.000Z", false, false)
	put("assistant", "half", "2026-11-01T09:06:05.000Z", true, false)
	u4 := put("user", "next day", "2026-11-02T09:00:00.000Z", false, false)
	put("assistant", "cut", "2026-11-02T09:00:01.000Z", false, true)
	for _, q := range []string{`DROP TABLE exchanges`, `DROP TABLE sessions`, fmt.Sprintf(`PRAGMA user_version = %d`, from)} {
		if err := db.Exec_(ctx, q); err != nil {
			t.Fatal(err)
		}
	}
	_ = s.Close()

	s, err = Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	db, err = s.Get(ctx, pid)
	if err != nil {
		t.Fatalf("schema %d does not open: %v", from, err)
	}
	list, err := db.Sessions(ctx, 10, "")
	if err != nil || len(list) != 2 {
		t.Fatalf("sessions = %+v %v", list, err)
	}
	if list[0].Title != "next day" || list[1].Title != "Первый запрос" || list[1].Exchanges != 3 || !list[0].Open {
		t.Fatalf("sessions = %+v", list)
	}
	_, ex, err := db.SessionOf(ctx, list[1].ID)
	if err != nil || len(ex) != 3 {
		t.Fatalf("exchanges = %+v %v", ex, err)
	}
	if ex[0].TurnID != u1 || ex[0].Answer != "final one" || ex[0].MessageID != a1 || ex[0].Status != ExchangeCompleted ||
		ex[0].DurationMS != 10000 || ex[0].Model != "m-orch" || ex[0].Request != "Первый запрос\nвторая строка" {
		t.Fatalf("first = %+v", ex[0])
	}
	if ex[1].TurnID != u2 || ex[1].Status != ExchangeFailed || ex[1].Answer != "" || ex[2].TurnID != u3 || ex[2].Status != ExchangeStopped || ex[2].Answer != "half" {
		t.Fatalf("second, third = %+v %+v", ex[1], ex[2])
	}
	_, last, _ := db.SessionOf(ctx, list[0].ID)
	if len(last) != 1 || last[0].TurnID != u4 || last[0].Status != ExchangeFailed {
		t.Fatalf("rewound answer must not count: %+v", last)
	}
	hits, err := db.Search(ctx, SearchQuery{Text: "final one", Kinds: []string{DocExchange}})
	if err != nil || len(hits) != 1 {
		t.Fatalf("back-filled exchange not searchable: %+v %v", hits, err)
	}
	if v, _ := userVersion(ctx, db.sql); v != SchemaVersion {
		t.Fatalf("user_version = %d", v)
	}
	// Opening again does not duplicate.
	_ = s.Close()
	s, _ = Open(dir)
	db, _ = s.Get(ctx, pid)
	if again, _ := db.Sessions(ctx, 10, ""); len(again) != 2 || again[1].Exchanges != 3 {
		t.Fatalf("second open = %+v", again)
	}
}

// A /clear (schema 9) between two requests ends the session in the back-fill, and the session keeps the clear's summary.
func TestBackfillSplitsSessionsAtAClear(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	db, err := s.Create(ctx, NewProject{Name: "p", ModelsJSON: "{}", MaxDepth: 1, OrchestratorModel: "m"})
	if err != nil {
		t.Fatal(err)
	}
	pid := db.ID()
	orch, _ := db.Orchestrator(ctx)
	put := func(role, text, at string) int64 {
		raw, _ := json.Marshal([]map[string]any{{"type": "text", "text": text}})
		res, err := db.sql.ExecContext(ctx, `INSERT INTO messages (agent_id, role, content_json, created_at) VALUES (?,?,?,?)`, orch.ID, role, string(raw), at)
		if err != nil {
			t.Fatal(err)
		}
		id, _ := res.LastInsertId()
		return id
	}
	put("user", "before the clear", "2026-11-01T09:00:00.000Z")
	last := put("assistant", "done", "2026-11-01T09:00:05.000Z")
	put("user", "after the clear", "2026-11-01T09:10:00.000Z")
	put("assistant", "ok", "2026-11-01T09:10:05.000Z")
	if _, err := db.AddClear(ctx, orch.ID, "conv_1", "carry-over text", "model", "before the clear"); err != nil {
		t.Fatal(err)
	}
	if err := db.Exec_(ctx, `UPDATE compactions SET upto_message_id = ?`, last); err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{`DROP TABLE exchanges`, `DROP TABLE sessions`, `PRAGMA user_version = 11`} {
		if err := db.Exec_(ctx, q); err != nil {
			t.Fatal(err)
		}
	}
	_ = s.Close()
	s, err = Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	db, _ = s.Get(ctx, pid)
	list, err := db.Sessions(ctx, 10, "")
	if err != nil || len(list) != 2 || list[1].Reason != "clear" || list[1].Summary != "carry-over text" || list[1].SummarySource != "model" || list[0].Summary != "" {
		t.Fatalf("sessions = %+v %v", list, err)
	}
}

// StartNewSession closes the latest session with the summary, opens an empty one the next exchange names, and is idempotent.
func TestStartNewSessionKeepsTheSummaryAndIsIdempotent(t *testing.T) {
	ctx := context.Background()
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	db, err := s.Create(ctx, NewProject{Name: "p", ModelsJSON: "{}", MaxDepth: 1, OrchestratorModel: "m"})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 11, 1, 9, 0, 0, 0, time.UTC)
	_, first, err := db.RecordExchange(ctx, Exchange{TurnID: 1, Request: "first request", Status: ExchangeCompleted, StartedAt: Stamp(now)}, SessionGap)
	if err != nil {
		t.Fatal(err)
	}
	prev, cur, err := db.StartNewSession(ctx, "clear", "the summary", "agent", now.Add(time.Minute))
	if err != nil || prev != first.ID || cur == "" || cur == prev {
		t.Fatalf("boundary = %q %q %v", prev, cur, err)
	}
	again, curAgain, err := db.StartNewSession(ctx, "clear", "ignored", "model", now.Add(2*time.Minute))
	if err != nil || curAgain != cur || again != first.ID {
		t.Fatalf("second boundary = %q %q %v", again, curAgain, err)
	}
	closed, _, _ := db.SessionOf(ctx, first.ID)
	if closed.Summary != "the summary" || closed.SummarySource != "agent" || closed.Reason != "clear" || closed.Open {
		t.Fatalf("closed = %+v", closed)
	}
	// Hours later (beyond the gap) the request still joins the empty session and names it.
	_, joined, err := db.RecordExchange(ctx, Exchange{TurnID: 3, Request: "after the clear", Status: ExchangeCompleted, StartedAt: Stamp(now.Add(20 * time.Hour))}, SessionGap)
	if err != nil || joined.ID != cur || joined.Title != "after the clear" {
		t.Fatalf("joined = %+v %v", joined, err)
	}
	if list, _ := db.Sessions(ctx, 10, ""); len(list) != 2 {
		t.Fatalf("sessions = %+v", list)
	}
}
