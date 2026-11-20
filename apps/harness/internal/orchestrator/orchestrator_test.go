package orchestrator_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/anthropicclient"
	"github.com/ndolinschi/Octo/apps/harness/internal/config"
	"github.com/ndolinschi/Octo/apps/harness/internal/events"
	"github.com/ndolinschi/Octo/apps/harness/internal/mockllm"
	"github.com/ndolinschi/Octo/apps/harness/internal/orchestrator"
	"github.com/ndolinschi/Octo/apps/harness/internal/project"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
	"github.com/ndolinschi/Octo/apps/harness/internal/router"
)

type rig struct {
	store *projectstore.Store
	hub   *events.Hub
	orch  *orchestrator.Orchestrator
	svc   *project.Service
	notes *project.Notes
}

func newRig(t *testing.T, llm http.Handler) *rig {
	return newRigWith(t, llm, orchestrator.Options{})
}

// newRigWith is newRig with extra orchestrator options (client and max turns are set here).
func newRigWith(t *testing.T, llm http.Handler, opts orchestrator.Options) *rig {
	t.Helper()
	return newRigAt(t, t.TempDir(), llm, opts)
}

// newRigAt is newRigWith over the data directory dir.
func newRigAt(t *testing.T, dir string, llm http.Handler, opts orchestrator.Options) *rig {
	t.Helper()
	srv := httptest.NewServer(llm)
	t.Cleanup(srv.Close)
	store, err := projectstore.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	hub := events.NewHub()
	notes := project.NewNotes(store, hub)
	opts.Client, opts.MaxTurns = anthropicclient.New("k", srv.URL, ""), 10
	if opts.Router == nil {
		// As in production: probe the base URL, which only an Octo router answers.
		opts.Router = router.New(context.Background(), srv.URL, "", router.WithCallRetryWait(100*time.Millisecond))
	}
	orch := orchestrator.New(store, hub, notes, opts)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = orch.Shutdown(ctx)
	})
	svc := project.NewService(store, hub, orch, project.Defaults{Models: config.DefaultModels(), MaxDepth: 3},
		project.WithPrices(opts.Prices), project.WithRouter(opts.Router))
	return &rig{store: store, hub: hub, orch: orch, svc: svc, notes: notes}
}

func (r *rig) project(t *testing.T, maxDepth int) string {
	t.Helper()
	name := "p"
	p, err := r.svc.Create(context.Background(), project.Input{
		Name: &name, MaxDepth: &maxDepth,
		Folders: &[]project.FolderInput{{Path: t.TempDir()}},
	})
	if err != nil {
		t.Fatal(err)
	}
	return p.ID
}

// run starts a turn and returns the turn.finished status.
func (r *rig) run(t *testing.T, pid, text string, during func()) string {
	t.Helper()
	ch, cancel := r.hub.Subscribe(pid)
	defer cancel()
	if _, err := r.orch.Start(context.Background(), pid, text); err != nil {
		t.Fatal(err)
	}
	if during != nil {
		during()
	}
	timeout := time.After(20 * time.Second)
	for {
		select {
		case ev, ok := <-ch:
			if !ok {
				t.Fatal("event stream closed")
			}
			if ev.Type == events.TurnFinished {
				var f struct{ Status string }
				if err := json.Unmarshal(ev.Data, &f); err != nil {
					t.Fatal(err)
				}
				return f.Status
			}
		case <-timeout:
			t.Fatal("timed out waiting for turn.finished")
		}
	}
}

func (r *rig) agents(t *testing.T, pid string) []projectstore.Agent {
	t.Helper()
	a, err := r.svc.Agents(context.Background(), pid)
	if err != nil {
		t.Fatal(err)
	}
	return a
}

func TestSpawnDepthLimit(t *testing.T) {
	for _, tc := range []struct {
		maxDepth, wantAgents, wantDeepest int
	}{
		{1, 4, 1},
		{2, 5, 2},
		{3, 5, 2},
	} {
		t.Run(fmt.Sprintf("max_depth=%d", tc.maxDepth), func(t *testing.T) {
			r := newRig(t, mockllm.New(0))
			pid := r.project(t, tc.maxDepth)
			if st := r.run(t, pid, "build it", nil); st != "completed" {
				t.Fatalf("turn status = %s", st)
			}
			agents := r.agents(t, pid)
			deepest := 0
			for _, a := range agents {
				deepest = max(deepest, a.Depth)
			}
			if len(agents) != tc.wantAgents || deepest != tc.wantDeepest {
				t.Fatalf("agents = %d deepest = %d, want %d/%d", len(agents), deepest, tc.wantAgents, tc.wantDeepest)
			}
		})
	}
}

type fakeReq struct {
	Tools []struct {
		Name        string          `json:"name"`
		InputSchema json.RawMessage `json:"input_schema"`
	} `json:"tools"`
	Msgs      []json.RawMessage `json:"messages"`
	Stream    bool              `json:"stream"`
	System    json.RawMessage   `json:"system"`
	MaxTokens int64             `json:"max_tokens"`
	Model     string            `json:"model"`
}

func (f fakeReq) isOrchestrator() bool {
	for _, tl := range f.Tools {
		if tl.Name == "save_note" {
			return true
		}
	}
	return false
}

func fakeLLM(fn func(w http.ResponseWriter, r *http.Request, req fakeReq)) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req fakeReq
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		fn(w, r, req)
	})
}

func respond(w http.ResponseWriter, stop string, content ...string) {
	w.Header().Set("Content-Type", "application/json")
	fmt.Fprintf(w, `{"id":"m","type":"message","role":"assistant","model":"x","content":[%s],"stop_reason":%q,`+
		`"usage":{"input_tokens":3,"output_tokens":2}}`, strings.Join(content, ","), stop)
}

func spawnBlock(id, title string) string {
	return fmt.Sprintf(`{"type":"tool_use","id":%q,"name":"spawn_agent","input":{"role":"Worker","title":%q,"task":"do it","tier":"fast"}}`, id, title)
}

func textBlock(s string) string { return fmt.Sprintf(`{"type":"text","text":%q}`, s) }

func TestParallelSpawns(t *testing.T) {
	var arrived atomic.Int32
	barrier := make(chan struct{})
	var once sync.Once
	r := newRig(t, fakeLLM(func(w http.ResponseWriter, hr *http.Request, req fakeReq) {
		switch {
		case req.isOrchestrator() && len(req.Msgs) == 1:
			respond(w, "tool_use", spawnBlock("t1", "a"), spawnBlock("t2", "b"), spawnBlock("t3", "c"))
		case req.isOrchestrator():
			respond(w, "end_turn", textBlock("all done"))
		default:
			if arrived.Add(1) == 3 {
				once.Do(func() { close(barrier) })
			}
			select {
			case <-barrier:
				respond(w, "end_turn", textBlock("child report"))
			case <-time.After(5 * time.Second):
				http.Error(w, "children did not run in parallel", http.StatusBadRequest)
			}
		}
	}))
	pid := r.project(t, 2)
	if st := r.run(t, pid, "go", nil); st != "completed" {
		t.Fatalf("status = %s", st)
	}
	agents := r.agents(t, pid)
	if len(agents) != 4 {
		t.Fatalf("agents = %d, want 4", len(agents))
	}
	seen := map[string]bool{}
	for _, a := range agents[1:] {
		if a.Status != projectstore.StatusCompleted || a.Result == nil || *a.Result != "child report" {
			t.Fatalf("child = %+v", a)
		}
		seen[*a.SpawnToolUseID] = true
	}
	if len(seen) != 3 {
		t.Fatalf("spawn_tool_use_ids = %v", seen)
	}
}

func TestChildFailureIsErrorResult(t *testing.T) {
	r := newRig(t, fakeLLM(func(w http.ResponseWriter, hr *http.Request, req fakeReq) {
		switch {
		case req.isOrchestrator() && len(req.Msgs) == 1:
			respond(w, "tool_use", spawnBlock("t1", "a"))
		case req.isOrchestrator():
			respond(w, "end_turn", textBlock("handled the failure"))
		default:
			http.Error(w, `{"type":"error","error":{"type":"invalid_request_error","message":"boom"}}`, http.StatusBadRequest)
		}
	}))
	pid := r.project(t, 2)
	if st := r.run(t, pid, "go", nil); st != "completed" {
		t.Fatalf("parent status = %s, want completed", st)
	}
	agents := r.agents(t, pid)
	child := agents[1]
	if child.Status != projectstore.StatusFailed || child.Error == nil || !strings.Contains(*child.Error, "did not answer") {
		t.Fatalf("child = %+v", child)
	}
	orch, err := r.svc.Messages(context.Background(), pid, agents[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	var sawErrResult bool
	for _, m := range orch {
		for _, b := range m.Content {
			if b.Type == "tool_result" && *b.IsError && strings.Contains(*b.Content, "sub-agent failed") {
				sawErrResult = true
			}
		}
	}
	if !sawErrResult {
		t.Fatal("orchestrator did not receive an is_error tool_result")
	}
}

func TestCancelMarksTreeCancelled(t *testing.T) {
	started := make(chan struct{})
	var once sync.Once
	r := newRig(t, fakeLLM(func(w http.ResponseWriter, hr *http.Request, req fakeReq) {
		if req.isOrchestrator() {
			respond(w, "tool_use", spawnBlock("t1", "a"))
			return
		}
		once.Do(func() { close(started) })
		<-hr.Context().Done()
	}))
	pid := r.project(t, 2)
	st := r.run(t, pid, "go", func() {
		select {
		case <-started:
		case <-time.After(10 * time.Second):
			t.Fatal("child never started")
		}
		r.orch.Cancel(pid)
	})
	if st != "cancelled" {
		t.Fatalf("status = %s, want cancelled", st)
	}
	agents := r.agents(t, pid)
	if agents[0].Status != projectstore.StatusIdle || agents[1].Status != projectstore.StatusCancelled {
		t.Fatalf("orchestrator=%s child=%s", agents[0].Status, agents[1].Status)
	}
	if r.orch.Running(pid) {
		t.Fatal("turn slot not released")
	}
}

func TestCancelStoresTheInterruptedResultAtTheStop(t *testing.T) {
	started := make(chan struct{})
	var once sync.Once
	r := newRig(t, fakeLLM(func(w http.ResponseWriter, hr *http.Request, req fakeReq) {
		if req.isOrchestrator() {
			respond(w, "tool_use", spawnBlock("t1", "a"))
			return
		}
		once.Do(func() { close(started) })
		<-hr.Context().Done()
	}))
	pid := r.project(t, 2)
	st := r.run(t, pid, "go", func() {
		select {
		case <-started:
		case <-time.After(10 * time.Second):
			t.Fatal("child never started")
		}
		r.orch.Cancel(pid)
	})
	if st != "cancelled" {
		t.Fatalf("status = %s, want cancelled", st)
	}
	db, err := r.store.Get(context.Background(), pid)
	if err != nil {
		t.Fatal(err)
	}
	orch, _ := db.Orchestrator(context.Background())
	msgs, err := db.Messages(context.Background(), orch.ID)
	if err != nil {
		t.Fatal(err)
	}
	last := msgs[len(msgs)-1]
	if last.Role != "user" || len(last.Content) != 1 || last.Content[0].Type != "tool_result" ||
		*last.Content[0].ToolUseID != "t1" || !*last.Content[0].IsError || *last.Content[0].Content != "interrupted: the tool call did not complete" {
		t.Fatalf("last message = %s %+v, want the interrupted result of t1", last.Role, last.Content)
	}
}

func TestConcurrentTurnRejected(t *testing.T) {
	gate := make(chan struct{})
	r := newRig(t, fakeLLM(func(w http.ResponseWriter, hr *http.Request, req fakeReq) {
		<-gate
		respond(w, "end_turn", textBlock("ok"))
	}))
	pid := r.project(t, 2)
	ctx := context.Background()
	if _, err := r.orch.Start(ctx, pid, "one"); err != nil {
		t.Fatal(err)
	}
	if _, err := r.orch.Start(ctx, pid, "two"); err != orchestrator.ErrTurnInProgress {
		t.Fatalf("second Start err = %v, want ErrTurnInProgress", err)
	}
	close(gate)
}

func TestNextTurnRepairsDanglingToolUse(t *testing.T) {
	var sawRepair atomic.Bool
	r := newRig(t, fakeLLM(func(w http.ResponseWriter, hr *http.Request, req fakeReq) {
		if len(req.Msgs) == 1 {
			respond(w, "tool_use", spawnBlock("t1", "a"))
			return
		}
		for _, m := range req.Msgs {
			if strings.Contains(string(m), "interrupted") {
				sawRepair.Store(true)
			}
		}
		respond(w, "end_turn", textBlock("ok"))
	}))
	pid := r.project(t, 1)
	db, err := r.store.Get(context.Background(), pid)
	if err != nil {
		t.Fatal(err)
	}
	orch, _ := db.Orchestrator(context.Background())
	ctx := context.Background()
	if _, err := db.AppendMessage(ctx, orch.ID, "user", []byte(`[{"type":"text","text":"earlier"}]`)); err != nil {
		t.Fatal(err)
	}
	if _, err := db.AppendMessage(ctx, orch.ID, "assistant", []byte(`[{"type":"tool_use","id":"toolu_dangling","name":"spawn_agent","input":{}}]`)); err != nil {
		t.Fatal(err)
	}
	// Two messages are already stored, so the fake sees a longer history and answers directly.
	if st := r.run(t, pid, "continue", nil); st != "completed" {
		t.Fatalf("status = %s", st)
	}
	if !sawRepair.Load() {
		t.Fatal("history sent to the model lacked a closing tool_result for the dangling tool_use")
	}
}
