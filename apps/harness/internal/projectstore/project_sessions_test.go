package projectstore

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"
)

func textRaw(s string) []byte {
	raw, _ := json.Marshal([]map[string]any{{"type": "text", "text": s}})
	return raw
}

// A database at schema 12 opens at 13: the sessions are main sessions, the newest is current, the orchestrator's
// messages and compactions belong to the session that held their turn, and every sub-agent gets an agent
// session linked by the turn that spawned it (or, without data, under the session active when it started).
func TestMigrateToSchema13LinksMessagesAndAgents(t *testing.T) {
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
	put := func(role, text, at string) int64 {
		res, err := db.sql.ExecContext(ctx, `INSERT INTO messages (agent_id, role, content_json, created_at) VALUES (?,?,?,?)`, orch.ID, role, string(textRaw(text)), at)
		if err != nil {
			t.Fatal(err)
		}
		id, _ := res.LastInsertId()
		return id
	}
	u1 := put("user", "first", "2026-11-01T09:00:00.000Z")
	put("assistant", "one", "2026-11-01T09:00:05.000Z")
	u2 := put("user", "second, a day later", "2026-11-02T09:00:00.000Z")
	last := put("assistant", "two", "2026-11-02T09:00:05.000Z")
	// A sub-agent spawned during the second turn, one that has no message before it (before everything), one while no message exists after it.
	spawn := func(title, at string) string {
		a, err := db.CreateAgent(ctx, NewAgent{ParentID: &orch.ID, Depth: 1, Role: "r", Title: title, Task: "t", Model: "m", Status: StatusCompleted})
		if err != nil {
			t.Fatal(err)
		}
		if err := db.Exec_(ctx, `UPDATE agents SET created_at = ? WHERE id = ?`, at, a.ID); err != nil {
			t.Fatal(err)
		}
		return a.ID
	}
	inTurn2 := spawn("in turn two", "2026-11-02T09:00:02.000Z")
	early := spawn("before any message", "2026-10-30T09:00:00.000Z")
	// A regular compaction of the second session and a clear boundary after it.
	if err := db.Exec_(ctx, `INSERT INTO compactions (agent_id, summary, upto_message_id, created_at) VALUES (?, 'sum', ?, '2026-11-02T09:00:06.000Z')`, orch.ID, last); err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{
		`DROP TABLE exchanges`, `DROP TABLE sessions`, `DROP TABLE session_reports`, `UPDATE messages SET session_id = ''`, `UPDATE compactions SET session_id = ''`,
		`PRAGMA user_version = 11`,
	} {
		if err := db.Exec_(ctx, q); err != nil {
			t.Fatal(err)
		}
	}
	_ = s.Close()
	// Back to 12: v12 rebuilds sessions from the messages (no v13 data), v13 then links.
	s, err = Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	db, err = s.Get(ctx, pid)
	if err != nil {
		t.Fatal(err)
	}
	list, err := db.ListSessions(ctx, SessionFilter{Kind: KindMain, Limit: -1})
	if err != nil || len(list) != 2 {
		t.Fatalf("main sessions = %+v %v", list, err)
	}
	if !list[0].Current || list[1].Current || list[0].Kind != KindMain {
		t.Fatalf("current flags = %+v", list)
	}
	msgs, _ := db.Messages(ctx, orch.ID)
	for _, m := range msgs {
		want := list[1].ID
		if m.ID >= u2 {
			want = list[0].ID
		}
		if m.SessionID != want {
			t.Fatalf("message %d in %q, want %q", m.ID, m.SessionID, want)
		}
	}
	_ = u1
	c, ok, err := db.LatestCompaction(ctx, orch.ID)
	if err != nil || !ok || c.Summary != "sum" {
		t.Fatalf("compaction of the current session: %+v %v %v", c, ok, err)
	}
	a, err := db.SessionOfAgent(ctx, inTurn2)
	if err != nil || a.Kind != KindAgent || a.ParentSessionID != list[0].ID || a.TurnID != u2 || a.State != SessionIdle || a.Title != "in turn two" {
		t.Fatalf("agent session = %+v %v", a, err)
	}
	e, err := db.SessionOfAgent(ctx, early)
	if err != nil || e.TurnID != 0 || e.ParentSessionID == "" {
		t.Fatalf("unlinked agent session = %+v %v", e, err)
	}
	kids, _ := db.ChildSessions(ctx, list[0].ID)
	if len(kids) != 1 || kids[0].ID != a.ID {
		t.Fatalf("children = %+v", kids)
	}
	if v, _ := userVersion(ctx, db.sql); v != SchemaVersion {
		t.Fatalf("user_version = %d", v)
	}
	// A second open adds nothing.
	_ = s.Close()
	s, _ = Open(dir)
	db, _ = s.Get(ctx, pid)
	if all, _ := db.ListSessions(ctx, SessionFilter{Limit: -1}); len(all) != 3 && len(all) != 4 {
		t.Fatalf("second open lists %d sessions", len(all))
	}
}

func TestSessionLifecycle(t *testing.T) {
	ctx := context.Background()
	db := create(t, newStore(t), "p")
	orch, _ := db.Orchestrator(ctx)
	first, err := db.CurrentSessionID(ctx)
	if err != nil || first == "" {
		t.Fatalf("current = %q %v", first, err)
	}
	m1, _ := db.AppendMessage(ctx, orch.ID, "user", textRaw("hello"))
	if m1.SessionID != first {
		t.Fatalf("message session = %q, want %q", m1.SessionID, first)
	}
	if _, _, err := db.RecordExchange(ctx, Exchange{TurnID: m1.ID, Request: "hello", Answer: "hi", Status: ExchangeCompleted, StartedAt: Now()}, SessionGap); err != nil {
		t.Fatal(err)
	}
	// A boundary starts a second session, which is current; the first one can be resumed.
	prev, cur, err := db.StartNewSession(ctx, "clear", "sum", "stored", time.Now())
	if err != nil || prev != first || cur == first {
		t.Fatalf("boundary = %q %q %v", prev, cur, err)
	}
	m2, _ := db.AppendMessage(ctx, orch.ID, "user", textRaw("second"))
	if m2.SessionID != cur {
		t.Fatalf("second message in %q, want %q", m2.SessionID, cur)
	}
	if _, _, err := db.RecordExchange(ctx, Exchange{TurnID: m2.ID, Request: "second", Answer: "ok", Status: ExchangeCompleted, StartedAt: Now()}, SessionGap); err != nil {
		t.Fatal(err)
	}
	live, _ := db.LiveMessages(ctx, orch.ID)
	if len(live) != 1 || live[0].ID != m2.ID {
		t.Fatalf("live messages of the new session = %+v", live)
	}
	// Resume the first: its messages are the live ones, new messages join it.
	if p, err := db.SetCurrentSession(ctx, first); err != nil || p != cur {
		t.Fatalf("resume = %q %v", p, err)
	}
	live, _ = db.LiveMessages(ctx, orch.ID)
	if len(live) != 1 || live[0].ID != m1.ID {
		t.Fatalf("live messages after resume = %+v", live)
	}
	m3, _ := db.AppendMessage(ctx, orch.ID, "user", textRaw("third"))
	if m3.SessionID != first {
		t.Fatalf("message after resume in %q", m3.SessionID)
	}
	if _, _, err := db.RecordExchange(ctx, Exchange{TurnID: m3.ID, Request: "third", Answer: "ok", Status: ExchangeFailed, StartedAt: Now()}, SessionGap); err != nil {
		t.Fatal(err)
	}
	if info, _ := db.SessionInfoOf(ctx, first); info.Exchanges != 2 || !info.Current || info.State != SessionFailed {
		t.Fatalf("resumed session = %+v", info)
	}
	// Compactions belong to the session they were made in.
	if _, err := db.AddCompaction(ctx, orch.ID, "first's summary"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.SetCurrentSession(ctx, cur); err != nil {
		t.Fatal(err)
	}
	if c, ok, _ := db.LatestCompaction(ctx, orch.ID); ok {
		t.Fatalf("the other session sees %+v", c)
	}
	// The current one cannot be archived or deleted; another one can.
	if _, err := db.PatchSession(ctx, cur, nil, ptr(true)); !errors.Is(err, ErrSessionCurrent) {
		t.Fatalf("archive current = %v", err)
	}
	if _, err := db.DeleteSession(ctx, cur); !errors.Is(err, ErrSessionCurrent) {
		t.Fatalf("delete current = %v", err)
	}
	title := "My title"
	if info, err := db.PatchSession(ctx, first, &title, ptr(true)); err != nil || info.Title != title || !info.Archived {
		t.Fatalf("patch = %+v %v", info, err)
	}
	if l, _ := db.ListSessions(ctx, SessionFilter{}); len(l) != 1 || l[0].ID != cur {
		t.Fatalf("default list hides archived: %+v", l)
	}
	if l, _ := db.ListSessions(ctx, SessionFilter{Archived: "true"}); len(l) != 1 || l[0].ID != first {
		t.Fatalf("archived list: %+v", l)
	}
	// Delete removes the exchanges from the index and the messages; a task made in the session stays, marked.
	made, err := db.CreateTask(ctx, Task{Title: "Kept task", Goal: "Kept", SessionID: first})
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := db.Task(ctx, made.ID); got.SessionDeleted {
		t.Fatal("a task of a live session is marked deleted")
	}
	ids, err := db.DeleteSession(ctx, first)
	if err != nil || len(ids) != 1 {
		t.Fatalf("delete = %v %v", ids, err)
	}
	if hits, _ := db.Search(ctx, SearchQuery{Text: "third", Kinds: []string{DocExchange, DocMessage}}); len(hits) != 0 {
		t.Fatalf("deleted session still searchable: %+v", hits)
	}
	if _, err := db.SessionInfoOf(ctx, first); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleted session = %v", err)
	}
	if all, err := db.Tasks(ctx); err != nil || len(all) != 1 || !all[0].SessionDeleted || all[0].SessionID != first {
		t.Fatalf("task after its session was deleted = %+v %v", all, err)
	}
	if _, err := db.SetCurrentSession(ctx, "nope"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("resume unknown = %v", err)
	}
}

func ptr[T any](v T) *T { return &v }

func TestAgentSessionsFollowTheirAgent(t *testing.T) {
	ctx := context.Background()
	db := create(t, newStore(t), "p")
	orch, _ := db.Orchestrator(ctx)
	main, _ := db.CurrentSessionID(ctx)
	a, err := db.CreateAgent(ctx, NewAgent{ParentID: &orch.ID, Depth: 1, Role: "r", Title: "Worker", Task: "t", Model: "m", Status: StatusRunning, Started: true})
	if err != nil {
		t.Fatal(err)
	}
	s, err := db.CreateAgentSession(ctx, a, main, 7)
	if err != nil || s.Kind != KindAgent || s.ParentSessionID != main || s.TurnID != 7 || s.State != SessionWorking || s.Title != "Worker" {
		t.Fatalf("agent session = %+v %v", s, err)
	}
	done := StatusCompleted
	if _, err := db.UpdateAgent(ctx, a.ID, AgentPatch{Status: &done}); err != nil {
		t.Fatal(err)
	}
	if s, _ = db.SessionOfAgent(ctx, a.ID); s.State != SessionIdle {
		t.Fatalf("after completion = %+v", s)
	}
	if _, err := db.AppendMessage(ctx, a.ID, "user", textRaw("agent text")); err != nil {
		t.Fatal(err)
	}
	if msgs, err := db.SessionMessages(ctx, s.ID); err != nil || len(msgs) != 1 || msgs[0].SessionID != "" {
		t.Fatalf("agent messages = %+v %v", msgs, err)
	}
	if info, _ := db.SessionInfoOf(ctx, main); info.Children != 1 {
		t.Fatalf("children = %d", info.Children)
	}
	// A rewound agent's session is hidden.
	if err := db.Exec_(ctx, `UPDATE agents SET rewound_at = ? WHERE id = ?`, Now(), a.ID); err != nil {
		t.Fatal(err)
	}
	if l, _ := db.ListSessions(ctx, SessionFilter{Kind: KindAgent}); len(l) != 0 {
		t.Fatalf("rewound agent listed: %+v", l)
	}
	// Reports are handed over once.
	if err := db.AddSessionReport(ctx, main, s.ID, "the answer"); err != nil {
		t.Fatal(err)
	}
	r, _ := db.TakeSessionReports(ctx, main)
	again, _ := db.TakeSessionReports(ctx, main)
	if len(r) != 1 || r[0].Text != "the answer" || len(again) != 0 {
		t.Fatalf("reports = %+v / %+v", r, again)
	}
}
