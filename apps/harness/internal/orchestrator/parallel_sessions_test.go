package orchestrator_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/config"
	"github.com/ndolinschi/Octo/apps/harness/internal/events"
	"github.com/ndolinschi/Octo/apps/harness/internal/mockllm"
	"github.com/ndolinschi/Octo/apps/harness/internal/orchestrator"
	"github.com/ndolinschi/Octo/apps/harness/internal/project"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
	"github.com/ndolinschi/Octo/apps/harness/internal/usererr"
)

// Parallel sessions, phase 1 (spec 2026-11-14-parallel-sessions-design.md, acceptance criteria 4-13).

func psWait(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func (r *rig) newSession(t *testing.T, pid string, in project.CreateSessionInput) orchestrator.SessionView {
	t.Helper()
	out, err := r.svc.CreateSessionWith(context.Background(), pid, in)
	if err != nil {
		t.Fatal(err)
	}
	return out.Session
}

func (r *rig) post(t *testing.T, pid, sid, text string) *projectstore.QueuedMessage {
	t.Helper()
	_, q, err := r.svc.PostSessionMessage(context.Background(), pid, sid, text, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	return q
}

func (r *rig) defaultSession(t *testing.T, pid string) string {
	t.Helper()
	db, err := r.store.Get(context.Background(), pid)
	if err != nil {
		t.Fatal(err)
	}
	sid, err := db.DefaultSessionID(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return sid
}

func (r *rig) root(t *testing.T, pid, sid string) string {
	t.Helper()
	db, _ := r.store.Get(context.Background(), pid)
	a, err := db.RootAgent(context.Background(), sid)
	if err != nil {
		t.Fatal(err)
	}
	return a.ID
}

func (r *rig) view(t *testing.T, pid, sid string) orchestrator.SessionView {
	t.Helper()
	d, err := r.svc.GetSession(context.Background(), pid, sid)
	if err != nil {
		t.Fatal(err)
	}
	return d.Session
}

// finishedOf collects turn.finished payloads from ch until n arrived.
func finishedOf(t *testing.T, ch <-chan events.Event, n int, seen *[]events.Event) []map[string]any {
	t.Helper()
	var out []map[string]any
	deadline := time.After(30 * time.Second)
	for len(out) < n {
		select {
		case ev := <-ch:
			if seen != nil {
				*seen = append(*seen, ev)
			}
			if ev.Type == events.TurnFinished {
				var m map[string]any
				_ = json.Unmarshal(ev.Data, &m)
				out = append(out, m)
			}
		case <-deadline:
			t.Fatalf("only %d of %d turn.finished", len(out), n)
		}
	}
	return out
}

// Criteria 4, 5 and 6: a new session is not the default; two sessions of one project run turns at the same time,
// their events carry their session and root; a message to a busy session queues there only.
func TestTwoSessionsOfAProjectRunAtOnce(t *testing.T) {
	h := mockllm.NewHolds()
	r := newRig(t, mockllm.New(0, mockllm.WithHolds(h)))
	pid := r.project(t, 2)
	s1 := r.defaultSession(t, pid)
	s2 := r.newSession(t, pid, project.CreateSessionInput{Title: "Second"})
	if s2.Default || r.defaultSession(t, pid) != s1 || s2.RootAgentID == "" || s2.RootAgentID == r.root(t, pid, s1) {
		t.Fatalf("new session = %+v", s2)
	}
	ch, cancel := r.hub.Subscribe(pid)
	defer cancel()
	r.post(t, pid, s1, "[hold:a] first session")
	r.post(t, pid, s2.ID, "[hold:b] second session")
	psWait(t, "both replies held", func() bool { return h.Waiting("a") == 1 && h.Waiting("b") == 1 })
	if !r.orch.ActiveSession(pid, s1) || !r.orch.ActiveSession(pid, s2.ID) {
		t.Fatal("both sessions must be running")
	}
	if v := r.view(t, pid, s2.ID); v.State != projectstore.SessionWorking {
		t.Fatalf("second session state = %s", v.State)
	}
	q := r.post(t, pid, s1, "quick queued in the first")
	if q == nil || q.SessionID != s1 || q.WaitingFor != projectstore.WaitingTurn {
		t.Fatalf("queued = %+v", q)
	}
	if other, _, _ := r.orch.SessionQueue(context.Background(), pid, s2.ID); len(other) != 0 {
		t.Fatalf("the other session's queue changed: %+v", other)
	}
	if p, _ := r.svc.Get(context.Background(), pid); p.Status != "running" || p.Sessions.Running != 2 || p.Sessions.Total != 2 {
		t.Fatalf("project summary = %s %+v", p.Status, p.Sessions)
	}
	h.Release("a")
	h.Release("b")
	var seen []events.Event
	fins := finishedOf(t, ch, 3, &seen)
	roots := map[string]string{s1: r.root(t, pid, s1), s2.ID: r.root(t, pid, s2.ID)}
	for _, f := range fins {
		sid, _ := f["session_id"].(string)
		if f["status"] != "completed" || roots[sid] == "" || f["agent_id"] != roots[sid] {
			t.Fatalf("turn.finished = %+v", f)
		}
	}
	for _, ev := range seen {
		if !strings.HasPrefix(ev.Type, "message.") && !strings.HasPrefix(ev.Type, "tool.") && ev.Type != events.QueueUpdated {
			continue
		}
		var m map[string]any
		_ = json.Unmarshal(ev.Data, &m)
		if sid, _ := m["session_id"].(string); roots[sid] == "" {
			t.Fatalf("%s without its session: %s", ev.Type, ev.Data)
		}
		if msg, ok := m["message"].(map[string]any); ok && msg["agent_id"] != roots[m["session_id"].(string)] {
			t.Fatalf("%s of %v carries another root: %s", ev.Type, m["session_id"], ev.Data)
		}
	}
	// Each session's conversation holds its own messages only.
	for sid, root := range roots {
		msgs, _ := r.svc.Messages(context.Background(), pid, root)
		for _, m := range msgs {
			if m.SessionID != sid {
				t.Fatalf("message %d of %s's root is in %s", m.ID, sid, m.SessionID)
			}
		}
	}
}

// Sub-agents of a session carry its session; tool events of a delegating turn carry it too.
func TestToolAndAgentEventsCarryTheSession(t *testing.T) {
	r := newRig(t, mockllm.New(0))
	pid := r.project(t, 1)
	s2 := r.newSession(t, pid, project.CreateSessionInput{})
	ch, cancel := r.hub.Subscribe(pid)
	defer cancel()
	r.post(t, pid, s2.ID, "build it")
	var seen []events.Event
	finishedOf(t, ch, 1, &seen)
	n := 0
	for _, ev := range seen {
		if !strings.HasPrefix(ev.Type, "tool.") && !strings.HasPrefix(ev.Type, "agent.") {
			continue
		}
		var m map[string]any
		_ = json.Unmarshal(ev.Data, &m)
		if m["session_id"] != s2.ID {
			t.Fatalf("%s: %s", ev.Type, ev.Data)
		}
		n++
	}
	if n == 0 {
		t.Fatal("no tool or agent events")
	}
	for _, a := range r.agents(t, pid) {
		if a.ParentID != nil && a.SessionID != s2.ID {
			t.Fatalf("sub-agent %s in session %q", a.ID, a.SessionID)
		}
	}
}

// Criterion 7: with sessions.max_running = 1 a second session's message waits for a slot, the session reads
// queued, and it starts when the first turn ends.
func TestProjectCapQueuesForASlot(t *testing.T) {
	h := mockllm.NewHolds()
	r := newRig(t, mockllm.New(0, mockllm.WithHolds(h)))
	pid := r.project(t, 1)
	if _, err := r.svc.Update(context.Background(), pid, project.Input{SessionSettings: &projectstore.SessionsSettings{MaxRunning: 1}}); err != nil {
		t.Fatal(err)
	}
	s1 := r.defaultSession(t, pid)
	s2 := r.newSession(t, pid, project.CreateSessionInput{})
	ch, cancel := r.hub.Subscribe(pid)
	defer cancel()
	r.post(t, pid, s1, "[hold:a] holds the only slot")
	psWait(t, "first reply held", func() bool { return h.Waiting("a") == 1 })
	q := r.post(t, pid, s2.ID, "quick waits for a slot")
	if q == nil || q.WaitingFor != projectstore.WaitingSlot || q.SessionID != s2.ID {
		t.Fatalf("queued = %+v", q)
	}
	if v := r.view(t, pid, s2.ID); v.State != projectstore.SessionQueued || v.Queued != 1 {
		t.Fatalf("second session = %s queued %d", v.State, v.Queued)
	}
	if p, _ := r.svc.Get(context.Background(), pid); p.Sessions.Queued != 1 || p.Sessions.Running != 1 {
		t.Fatalf("summary = %+v", p.Sessions)
	}
	if r.orch.ActiveSession(pid, s2.ID) {
		t.Fatal("the second session started past the cap")
	}
	h.Release("a")
	fins := finishedOf(t, ch, 2, nil)
	if fins[0]["session_id"] != s1 || fins[1]["session_id"] != s2.ID {
		t.Fatalf("order = %v then %v", fins[0]["session_id"], fins[1]["session_id"])
	}
}

// Criterion 8: the harness-wide cap holds across projects, and waiting messages start in the order they were queued.
func TestMachineCapAcrossProjectsInQueueOrder(t *testing.T) {
	h := mockllm.NewHolds()
	r := newRigWith(t, mockllm.New(0, mockllm.WithHolds(h)), orchestrator.Options{MaxRunning: 1})
	p1, p2, p3 := r.project(t, 1), r.project(t, 1), r.project(t, 1)
	r.post(t, p1, "", "[hold:a] project one")
	psWait(t, "p1 held", func() bool { return h.Waiting("a") == 1 })
	if q := r.post(t, p2, "", "[hold:b] project two"); q == nil || q.WaitingFor != projectstore.WaitingSlot {
		t.Fatalf("p2 = %+v", q)
	}
	time.Sleep(5 * time.Millisecond) // a later created_at
	if q := r.post(t, p3, "", "quick project three"); q == nil || q.WaitingFor != projectstore.WaitingSlot {
		t.Fatalf("p3 = %+v", q)
	}
	h.Release("a")
	psWait(t, "p2 started first", func() bool { return h.Waiting("b") == 1 })
	if r.orch.Active(p3) {
		t.Fatal("p3 started before p2 released its slot")
	}
	if n, total := r.orch.RunningCount(p2); n != 1 || total != 1 {
		t.Fatalf("running = %d/%d", n, total)
	}
	h.Release("b")
	psWait(t, "p3 ran", func() bool {
		q, _, _ := r.orch.Queue(context.Background(), p3)
		return len(q) == 0 && !r.orch.Active(p3)
	})
}

// Criterion 9: POST /messages, /cancel, /queue and /clear act on the default session only; cancel all stops all.
func TestProjectRoutesActOnTheDefaultSession(t *testing.T) {
	h := mockllm.NewHolds()
	r := newRig(t, mockllm.New(0, mockllm.WithHolds(h)))
	pid := r.project(t, 1)
	ctx := context.Background()
	s1 := r.defaultSession(t, pid)
	s2 := r.newSession(t, pid, project.CreateSessionInput{})
	ch, cancel := r.hub.Subscribe(pid)
	defer cancel()
	if _, _, err := r.svc.PostMessage(ctx, pid, "[hold:a] via the project route", nil); err != nil {
		t.Fatal(err)
	}
	r.post(t, pid, s2.ID, "[hold:b] in the second")
	psWait(t, "both held", func() bool { return h.Waiting("a") == 1 && h.Waiting("b") == 1 })
	if !r.orch.ActiveSession(pid, s1) {
		t.Fatal("POST /messages did not go to the default session")
	}
	if _, q, err := r.svc.PostMessage(ctx, pid, "quick queued via project", nil); err != nil || q == nil || q.SessionID != s1 {
		t.Fatalf("queued = %+v %v", q, err)
	}
	if qs, err := r.svc.Queue(ctx, pid); err != nil || len(qs.Messages) != 1 || qs.Messages[0].SessionID != s1 {
		t.Fatalf("GET /queue = %+v %v", qs, err)
	}
	if err := r.svc.RemoveQueued(ctx, pid, ""); err != nil {
		t.Fatal(err)
	}
	if err := r.svc.CancelSession(ctx, pid, "", false); err != nil {
		t.Fatal(err)
	}
	f := finishedOf(t, ch, 1, nil)[0]
	if f["session_id"] != s1 || f["status"] != "cancelled" || !r.orch.ActiveSession(pid, s2.ID) {
		t.Fatalf("cancel of the default = %+v, second running %v", f, r.orch.ActiveSession(pid, s2.ID))
	}
	// /clear: the default gets a new session; the second one is untouched.
	res, err := r.svc.Clear(ctx, pid)
	if err != nil {
		t.Fatal(err)
	}
	if d := r.defaultSession(t, pid); d == s1 || d != res.SessionID {
		t.Fatalf("default after /clear = %s (clear made %s)", d, res.SessionID)
	}
	if v := r.view(t, pid, s2.ID); v.State != projectstore.SessionWorking {
		t.Fatalf("second session after /clear = %s", v.State)
	}
	if err := r.svc.CancelSession(ctx, pid, "", true); err != nil {
		t.Fatal(err)
	}
	if f := finishedOf(t, ch, 1, nil)[0]; f["session_id"] != s2.ID || f["status"] != "cancelled" {
		t.Fatalf("cancel all = %+v", f)
	}
}

// Criterion 10: stopping one session denies only its approvals and closes only its forms.
func TestStoppingASessionDeniesOnlyItsApprovals(t *testing.T) {
	r := newRig(t, mockllm.New(0))
	pid := r.supervisedProject(t, t.TempDir(), "")
	ctx := context.Background()
	s1 := r.defaultSession(t, pid)
	s2 := r.newSession(t, pid, project.CreateSessionInput{})
	r.post(t, pid, s1, "Go [bash:echo one]")
	r.post(t, pid, s2.ID, "Go [bash:echo two]")
	bySession := func() map[string]int {
		out := map[string]int{}
		for _, a := range r.orch.Approvals(pid) {
			out[a.SessionID]++
		}
		return out
	}
	psWait(t, "an approval in each session", func() bool { b := bySession(); return b[s1] > 0 && b[s2.ID] > 0 })
	if v := r.view(t, pid, s2.ID); !v.NeedsYou || v.PendingApprovals == 0 || v.State != projectstore.SessionWaiting {
		t.Fatalf("second session = %+v", v)
	}
	if list, _ := r.svc.SessionApprovals(ctx, pid, s2.ID); len(list) == 0 || list[0].SessionID != s2.ID {
		t.Fatalf("approvals?session= %+v", list)
	}
	if _, err := r.svc.StopSession(ctx, pid, s1); err != nil {
		t.Fatal(err)
	}
	psWait(t, "the first session's approvals denied", func() bool { return bySession()[s1] == 0 && !r.orch.ActiveSession(pid, s1) })
	if bySession()[s2.ID] == 0 || !r.orch.ActiveSession(pid, s2.ID) {
		t.Fatal("stopping the first session touched the second one's approvals")
	}
	if _, err := r.svc.StopSession(ctx, pid, s2.ID); err != nil {
		t.Fatal(err)
	}
	psWait(t, "second stopped", func() bool { return !r.orch.ActiveSession(pid, s2.ID) })
}

// Criterion 13: /clear in a non-default session creates a session in the same workspace with the same memory
// mode and leaves the default unchanged; the new session gets the carry-over.
func TestClearOfANonDefaultSession(t *testing.T) {
	r := newRig(t, mockllm.New(0))
	pid := r.project(t, 1)
	ctx := context.Background()
	s1 := r.defaultSession(t, pid)
	s2 := r.newSession(t, pid, project.CreateSessionInput{Memory: "on"})
	ch, cancel := r.hub.Subscribe(pid)
	defer cancel()
	r.post(t, pid, s2.ID, "quick question about walruses")
	finishedOf(t, ch, 1, nil)
	out, err := r.svc.CreateSessionWith(ctx, pid, project.CreateSessionInput{FromSession: s2.ID, Clear: true})
	if err != nil {
		t.Fatal(err)
	}
	s3 := out.Session
	if s3.ID == s2.ID || s3.Default || r.defaultSession(t, pid) != s1 || s3.Workspace == nil || s3.Workspace.ID != s2.Workspace.ID || s3.Memory != s2.Memory {
		t.Fatalf("cleared = %+v", s3)
	}
	db, _ := r.store.Get(ctx, pid)
	c, ok, _ := db.LatestCompaction(ctx, s3.RootAgentID)
	if !ok || !c.Cleared || !strings.Contains(c.Summary, "Carried over") {
		t.Fatalf("carry-over = %+v %v", c, ok)
	}
	if old := r.view(t, pid, s2.ID); old.Exchanges != 1 {
		t.Fatalf("the cleared session keeps its conversation: %+v", old)
	}
}

// Criterion 12: after a simulated crash with two running sessions both are closed interrupted and both
// non-empty queues are paused.
func TestCrashRecoveryClosesEverySession(t *testing.T) {
	h := mockllm.NewHolds()
	r := newRig(t, mockllm.New(0, mockllm.WithHolds(h)))
	pid := r.project(t, 1)
	s1 := r.defaultSession(t, pid)
	s2 := r.newSession(t, pid, project.CreateSessionInput{})
	r.post(t, pid, s1, "[hold:a] first long turn")
	r.post(t, pid, s2.ID, "[hold:b] second long turn")
	psWait(t, "both held", func() bool { return h.Waiting("a") == 1 && h.Waiting("b") == 1 })
	r.post(t, pid, s1, "quick waiting in one")
	r.post(t, pid, s2.ID, "quick waiting in two")
	dir := crashCopy(t, r, pid)
	h.Release("a")
	h.Release("b")

	r2 := restart(t, dir, mockllm.New(0))
	ctx := context.Background()
	db, err := r2.store.Get(ctx, pid)
	if err != nil {
		t.Fatal(err)
	}
	want := usererr.TurnInterrupted()
	for _, sid := range []string{s1, s2.ID} {
		root, _ := db.RootAgent(ctx, sid)
		if root.Status != projectstore.StatusIdle || root.Error == nil || *root.Error != want.Message {
			t.Fatalf("root of %s = %+v", sid, root)
		}
		_, ex, _ := db.SessionOf(ctx, sid)
		if len(ex) != 1 || !ex[0].Interrupted || ex[0].Status != projectstore.ExchangeFailed {
			t.Fatalf("exchanges of %s = %+v", sid, ex)
		}
		// The stored exchange says why the turn failed (what a reloaded conversation shows).
		if e := ex[0].Error; e == nil || e.Code != usererr.CodeTurnInterrupted || e.Message != want.Message || e.Hint != want.Hint {
			t.Fatalf("exchange error of %s = %+v", sid, e)
		}
		q, paused, _ := db.SessionQueue(ctx, sid)
		if len(q) != 1 || !paused {
			t.Fatalf("queue of %s = %d paused %v", sid, len(q), paused)
		}
		if v := r2.view(t, pid, sid); v.State != projectstore.SessionFailed {
			t.Fatalf("session %s after recovery = %s", sid, v.State)
		}
	}
}

// Criterion 11 (live part): two sessions of a project whose orchestrator is an ACP agent run two agent processes
// with two MCP tokens at once.
func TestTwoACPSessionsRunTwoProcesses(t *testing.T) {
	r := newACPRig(t, mockllm.New(0), fakeAgent("fake", true))
	svc := r.svcWithAgents(t, fakeAgent("fake", true))
	name, dir := "p", t.TempDir()
	p, err := svc.Create(context.Background(), project.Input{Name: &name, Folders: &[]project.FolderInput{{Path: dir}},
		Models: &config.Models{Orchestrator: "acp:fake"}})
	if err != nil {
		t.Fatal(err)
	}
	pid := p.ID
	s1 := r.defaultSession(t, pid)
	s2 := r.newSession(t, pid, project.CreateSessionInput{})
	ch, cancel := r.hub.Subscribe(pid)
	defer cancel()
	r.post(t, pid, s1, "[hang]")
	r.post(t, pid, s2.ID, "[hang]")
	pids := map[string]int{}
	deadline := time.After(20 * time.Second)
	for len(pids) < 2 {
		select {
		case ev := <-ch:
			if ev.Type != events.MessageCreated {
				continue
			}
			var m struct {
				SessionID string `json:"session_id"`
			}
			_ = json.Unmarshal(ev.Data, &m)
			if p := hangPID(ev.Data); p > 0 {
				pids[m.SessionID] = p
			}
		case <-deadline:
			t.Fatalf("hang calls seen: %v", pids)
		}
	}
	if pids[s1] == 0 || pids[s2.ID] == 0 || pids[s1] == pids[s2.ID] {
		t.Fatalf("agent processes = %v", pids)
	}
	if n := r.orch.LiveMCPTokens(); n != 2 {
		t.Fatalf("live MCP tokens = %d", n)
	}
	r.orch.Cancel(pid)
	finishedOf(t, ch, 2, nil)
}
