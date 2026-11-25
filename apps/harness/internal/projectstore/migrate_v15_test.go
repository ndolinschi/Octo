package projectstore

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// v15Fixture shapes a database like schema 14 wrote it: one orchestrator row whose messages carry the main
// session they were stored in. Three main sessions, the current (default) one in the middle, sub-agents (one
// nested, without an agent session of its own), compactions and clears, a paused queue, changes, a plan, a
// kept ACP session, exchanges and their search documents.
type v15Fixture struct {
	dir, pid, orch      string
	a, b, c             string // main sessions; b is current
	x, y, z             string // sub-agents: x spawned in a, y in c, z by y
	msgs                map[string][]int64
	turnA, turnC        int64
	changeA, changeC    int64
	planC, queueID      string
	compA, clearB, clrC int64
}

func makeV15Fixture(t *testing.T) v15Fixture {
	t.Helper()
	ctx := context.Background()
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	db, err := s.Create(ctx, NewProject{Name: "p", ModelsJSON: "{}", MaxDepth: 3, OrchestratorModel: "claude-x"})
	if err != nil {
		t.Fatal(err)
	}
	f := v15Fixture{dir: dir, pid: db.ID(), msgs: map[string][]int64{}}
	orch, _ := db.Orchestrator(ctx)
	f.orch = orch.ID
	// Back to schema 14's shape: no link between sessions and root agents.
	exec(t, db, `DELETE FROM sessions`)
	exec(t, db, `UPDATE agents SET session_id = ''`)
	f.a, f.b, f.c = "ses_a", "ses_b", "ses_c"
	for i, sid := range []string{f.a, f.b, f.c} {
		at := fmt.Sprintf("2026-11-0%dT10:00:00.000Z", i+1)
		cur := 0
		if sid == f.b {
			cur = 1
		}
		exec(t, db, `INSERT INTO sessions (id, title, started_at, ended_at, closed, reason, kind, current) VALUES (?, ?, ?, ?, ?, '', 'main', ?)`,
			sid, "session "+sid, at, at, 1-cur, cur)
	}
	exec(t, db, `UPDATE sessions SET acp_agent = 'scripted', acp_model = 'acp:scripted', acp_session_id = 'acp-sess-a' WHERE id = ?`, f.a)
	add := func(agent, sid, role, text string) int64 {
		res, err := db.sql.ExecContext(ctx, `INSERT INTO messages (agent_id, role, content_json, created_at, session_id) VALUES (?, ?, ?, ?, ?)`,
			agent, role, string(textRaw(text)), Now(), sid)
		if err != nil {
			t.Fatal(err)
		}
		id, _ := res.LastInsertId()
		if role == "user" || role == "assistant" {
			exec(t, db, `INSERT INTO search_docs (kind, ref, title, body, date) VALUES ('message', ?, '', ?, ?)`, fmt.Sprint(id), text, Now())
		}
		return id
	}
	for _, sid := range []string{f.a, f.b, f.c} {
		u := add(f.orch, sid, "user", "request in "+sid)
		f.msgs[sid] = append(f.msgs[sid], u, add(f.orch, sid, "assistant", "answer in "+sid))
		if _, _, err := db.RecordExchange(ctx, Exchange{TurnID: u, Request: "request in " + sid, Answer: "answer in " + sid, Status: ExchangeCompleted, StartedAt: Now()}, SessionGap); err != nil {
			t.Fatal(err)
		}
		switch sid {
		case f.a:
			f.turnA = u
		case f.c:
			f.turnC = u
		}
	}
	comp := func(agent, sid string, upto int64, cleared int) int64 {
		res, err := db.sql.ExecContext(ctx, `INSERT INTO compactions (agent_id, summary, upto_message_id, created_at, session_id, cleared) VALUES (?, 'sum', ?, ?, ?, ?)`,
			agent, upto, Now(), sid, cleared)
		if err != nil {
			t.Fatal(err)
		}
		id, _ := res.LastInsertId()
		return id
	}
	f.compA = comp(f.orch, f.a, f.msgs[f.a][1], 0)
	f.clearB = comp(f.orch, f.b, f.msgs[f.a][1], 1)
	f.clrC = comp(f.orch, f.c, f.msgs[f.b][1], 1)
	sub := func(parent, title string) string {
		a, err := db.CreateAgent(ctx, NewAgent{ParentID: &parent, Depth: 1, Role: "worker", Title: title, Model: "claude-x", Status: StatusCompleted})
		if err != nil {
			t.Fatal(err)
		}
		exec(t, db, `UPDATE agents SET session_id = '' WHERE id = ?`, a.ID)
		return a.ID
	}
	f.x = sub(f.orch, "x")
	f.y = sub(f.orch, "y")
	f.z = sub(f.y, "z")
	for _, link := range []struct{ agent, parent string }{{f.x, f.a}, {f.y, f.c}} {
		exec(t, db, `INSERT INTO sessions (id, title, started_at, ended_at, closed, reason, kind, parent_session_id, agent_id) VALUES (?, '', ?, ?, 1, '', 'agent', ?, ?)`,
			NewID("ses"), Now(), Now(), link.parent, link.agent)
	}
	add(f.x, "", "user", "task of x")
	add(f.z, "", "assistant", "report of z")
	q, err := db.sql.ExecContext(ctx, `INSERT INTO queue (id, seq, text, created_at) VALUES ('q_1', 1, 'waiting', ?)`, Now())
	if err != nil || q == nil {
		t.Fatal(err)
	}
	f.queueID = "q_1"
	exec(t, db, `UPDATE project SET queue_paused = 1`)
	for _, ch := range []struct {
		turn  int64
		agent string
		out   *int64
	}{{f.turnA, f.x, &f.changeA}, {f.turnC, f.orch, &f.changeC}} {
		res, err := db.sql.ExecContext(ctx, `INSERT INTO changes (turn_id, agent_id, folder, path, created_at) VALUES (?, ?, 'p', 'a.go', ?)`, ch.turn, ch.agent, Now())
		if err != nil {
			t.Fatal(err)
		}
		*ch.out, _ = res.LastInsertId()
	}
	exec(t, db, `UPDATE changes SET session_id = ''`)
	f.planC = "pln_c"
	exec(t, db, `INSERT INTO plans (id, turn_id, text, status, created_at) VALUES (?, ?, 'the plan', 'pending', ?)`, f.planC, f.turnC, Now())
	exec(t, db, `UPDATE search_docs SET session_id = ''`)
	exec(t, db, `DELETE FROM workspaces`)
	exec(t, db, `PRAGMA user_version = 14`)
	_ = s.Close()
	return f
}

func (f v15Fixture) open(t *testing.T) (*Store, *DB) {
	t.Helper()
	s, err := Open(f.dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	db, err := s.Get(context.Background(), f.pid)
	if err != nil {
		t.Fatal(err)
	}
	return s, db
}

func one[T any](t *testing.T, db *DB, q string, args ...any) T {
	t.Helper()
	var v T
	if err := db.sql.QueryRowContext(context.Background(), q, args...).Scan(&v); err != nil {
		t.Fatalf("%s: %v", q, err)
	}
	return v
}

// Acceptance criterion 1 (spec 2026-11-14 section 12): a database stamped 14 opens as 15; the current main
// session is the default and keeps the old orchestrator row as its root; every other main session with messages
// has its own root with exactly its messages and compactions. Also the rest of the back-fill (section 7).
func TestMigrateToSchema15GivesEverySessionItsRoot(t *testing.T) {
	ctx := context.Background()
	f := makeV15Fixture(t)
	s, db := f.open(t)
	if v, _ := userVersion(ctx, db.sql); v != 15 {
		t.Fatalf("user_version = %d", v)
	}
	if _, err := os.Stat(filepath.Join(s.ProjectDir(f.pid), "project.sqlite"+BackupSuffixV15)); err != nil {
		t.Fatalf("no backup: %v", err)
	}
	def, _ := db.DefaultSessionID(ctx)
	if def != f.b {
		t.Fatalf("default = %s, want %s", def, f.b)
	}
	rootB, _ := db.RootAgent(ctx, f.b)
	if rootB.ID != f.orch || rootB.SessionID != f.b {
		t.Fatalf("default's root = %+v", rootB)
	}
	roots := map[string]string{f.b: f.orch}
	for _, sid := range []string{f.a, f.c} {
		r, err := db.RootAgent(ctx, sid)
		if err != nil || r.ID == f.orch || r.SessionID != sid || r.ParentID != nil || r.Model != "claude-x" || r.Status != StatusCompleted {
			t.Fatalf("root of %s = %+v %v", sid, r, err)
		}
		roots[sid] = r.ID
	}
	for sid, root := range roots {
		msgs, _ := db.Messages(ctx, root)
		var ids []int64
		for _, m := range msgs {
			ids = append(ids, m.ID)
			if m.SessionID != sid {
				t.Fatalf("message %d of %s's root is in %s", m.ID, sid, m.SessionID)
			}
		}
		if fmt.Sprint(ids) != fmt.Sprint(f.msgs[sid]) {
			t.Fatalf("messages of %s = %v, want %v", sid, ids, f.msgs[sid])
		}
		info, _ := db.SessionInfoOf(ctx, sid)
		if info.RootAgentID != root || info.Default != (sid == f.b) || info.Memory != MemoryOn || info.Workspace == nil || info.Workspace.ID != SharedWorkspace {
			t.Fatalf("session %s = %+v", sid, info)
		}
	}
	for id, want := range map[int64]string{f.compA: roots[f.a], f.clearB: f.orch, f.clrC: roots[f.c]} {
		if got := one[string](t, db, `SELECT agent_id FROM compactions WHERE id = ?`, id); got != want {
			t.Fatalf("compaction %d on %s, want %s", id, got, want)
		}
	}
	if c, ok, _ := db.LatestCompaction(ctx, roots[f.c]); !ok || c.ID != f.clrC || !c.Cleared {
		t.Fatalf("C's carry-over = %+v %v", c, ok)
	}
	if live, _ := db.LiveMessages(ctx, roots[f.c]); len(live) != 2 {
		t.Fatalf("C's live messages = %d", len(live))
	}
	for agent, want := range map[string][2]string{f.x: {roots[f.a], f.a}, f.y: {roots[f.c], f.c}, f.z: {f.y, f.c}} {
		a, _ := db.Agent(ctx, agent)
		if a.ParentID == nil || *a.ParentID != want[0] || a.SessionID != want[1] {
			t.Fatalf("sub-agent %s: parent %v session %s, want %v", agent, a.ParentID, a.SessionID, want)
		}
	}
	q, paused, _ := db.SessionQueue(ctx, f.b)
	if len(q) != 1 || q[0].ID != f.queueID || q[0].SessionID != f.b || !paused {
		t.Fatalf("default queue = %+v paused %v", q, paused)
	}
	for id, want := range map[int64]string{f.changeA: f.a, f.changeC: f.c} {
		if got := one[string](t, db, `SELECT session_id FROM changes WHERE id = ?`, id); got != want {
			t.Fatalf("change %d in %s, want %s", id, got, want)
		}
	}
	if p, _ := db.Plan(ctx, f.planC); p.SessionID != f.c {
		t.Fatalf("plan session = %q", p.SessionID)
	}
	if n := one[int](t, db, `SELECT COUNT(*) FROM search_docs WHERE kind IN ('exchange','message') AND session_id = ''`); n != 0 {
		t.Fatalf("%d search documents without a session", n)
	}
	if got := one[string](t, db, `SELECT session_id FROM search_docs WHERE kind = 'message' AND ref = ?`, fmt.Sprint(f.msgs[f.c][0])); got != f.c {
		t.Fatalf("message doc in %q", got)
	}
	if got := one[string](t, db, `SELECT session_id FROM acp_sessions WHERE agent_id = ?`, roots[f.a]); got != "acp-sess-a" {
		t.Fatalf("kept acp session of A = %q", got)
	}
	if n := one[int](t, db, `SELECT COUNT(*) FROM workspaces WHERE id = 'shared'`); n != 1 {
		t.Fatalf("shared workspace rows = %d", n)
	}
	// Every listed main session is addressable.
	if l, _ := db.ListSessions(ctx, SessionFilter{Kind: KindMain, Archived: "all"}); len(l) != 3 {
		t.Fatalf("main sessions = %d", len(l))
	}
}

// Acceptance criterion 2: opening a migrated database a second time changes no row; the backup exists after a
// rewrite and not when there was nothing to rewrite.
func TestMigrateToSchema15IsIdempotentAndBacksUpOnlyARewrite(t *testing.T) {
	ctx := context.Background()
	f := makeV15Fixture(t)
	s, _ := f.open(t)
	before := dumpTables(t, s, f.pid)
	_ = s.Close()
	s2, _ := f.open(t)
	if after := dumpTables(t, s2, f.pid); after != before {
		t.Fatalf("a second open changed rows")
	}
	matches, _ := filepath.Glob(filepath.Join(s2.ProjectDir(f.pid), "project.sqlite"+BackupSuffixV15+"*"))
	if len(matches) != 1 {
		t.Fatalf("backups = %v", matches)
	}

	// Nothing to move: one session, stamped 14.
	dir := t.TempDir()
	st, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	db, err := st.Create(ctx, NewProject{Name: "q", ModelsJSON: "{}", MaxDepth: 1, OrchestratorModel: "m"})
	if err != nil {
		t.Fatal(err)
	}
	pid := db.ID()
	orch, _ := db.Orchestrator(ctx)
	if _, err := db.AppendMessage(ctx, orch.ID, "user", textRaw("hi")); err != nil {
		t.Fatal(err)
	}
	exec(t, db, `UPDATE sessions SET root_agent_id = ''`)
	exec(t, db, `UPDATE agents SET session_id = ''`)
	exec(t, db, `PRAGMA user_version = 14`)
	_ = st.Close()
	st, err = Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	db, err = st.Get(ctx, pid)
	if err != nil {
		t.Fatal(err)
	}
	if r, err := db.Orchestrator(ctx); err != nil || r.ID != orch.ID {
		t.Fatalf("default root = %+v %v", r, err)
	}
	if m, _ := filepath.Glob(filepath.Join(st.ProjectDir(pid), "project.sqlite"+BackupSuffixV15+"*")); len(m) != 0 {
		t.Fatalf("a backup was written with nothing to rewrite: %v", m)
	}
}

// Acceptance criterion 3 (this binary's side; the real schema-14 binary is checked by hand, see the report): a
// database stamped by a newer schema is refused and its file is left byte for byte as it was.
func TestSchema15RefusesNewerUntouched(t *testing.T) {
	f := makeV15Fixture(t)
	s, db := f.open(t)
	exec(t, db, fmt.Sprintf(`PRAGMA user_version = %d`, SchemaVersion+1))
	path := filepath.Join(s.ProjectDir(f.pid), "project.sqlite")
	_ = s.Close()
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	s2, err := Open(f.dir)
	if err == nil {
		_, err = s2.Get(context.Background(), f.pid)
		_ = s2.Close()
	}
	var newer *NewerSchemaError
	if !errors.As(err, &newer) {
		t.Fatalf("open of a newer database = %v", err)
	}
	if after, _ := os.ReadFile(path); !bytes.Equal(before, after) {
		t.Fatal("the newer database was changed")
	}
}

// dumpTables is every row of the tables the back-fill writes, as text.
func dumpTables(t *testing.T, s *Store, pid string) string {
	t.Helper()
	db, err := s.Get(context.Background(), pid)
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, table := range []string{"agents", "messages", "compactions", "sessions", "queue", "changes", "plans", "search_docs", "acp_sessions", "workspaces"} {
		rows, err := db.sql.QueryContext(context.Background(), `SELECT * FROM `+table)
		if err != nil {
			t.Fatal(err)
		}
		cols, _ := rows.Columns()
		for rows.Next() {
			vals := make([]any, len(cols))
			ptrs := make([]any, len(cols))
			for i := range vals {
				ptrs[i] = &vals[i]
			}
			if err := rows.Scan(ptrs...); err != nil {
				t.Fatal(err)
			}
			out = append(out, table+fmt.Sprint(vals...))
		}
		_ = rows.Close()
	}
	sort.Strings(out)
	return strings.Join(out, "\n")
}
