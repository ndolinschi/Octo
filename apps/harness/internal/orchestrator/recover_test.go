package orchestrator_test

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/config"
	"github.com/ndolinschi/Octo/apps/harness/internal/orchestrator"
	"github.com/ndolinschi/Octo/apps/harness/internal/project"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
	"github.com/ndolinschi/Octo/apps/harness/internal/usererr"
)

// sse writes one server-sent event and flushes it.
func sse(w http.ResponseWriter, typ string, data string) {
	fmt.Fprintf(w, "event: %s\ndata: %s\n\n", typ, data)
	w.(http.Flusher).Flush()
}

// streamText starts a streamed text answer and sends the parts as deltas (no end).
func streamText(w http.ResponseWriter, parts ...string) {
	w.Header().Set("Content-Type", "text/event-stream")
	sse(w, "message_start", `{"type":"message_start","message":{"id":"m","type":"message","role":"assistant","model":"x","content":[],"stop_reason":null,"usage":{"input_tokens":3,"output_tokens":1}}}`)
	sse(w, "content_block_start", `{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`)
	for _, p := range parts {
		b, _ := json.Marshal(p)
		sse(w, "content_block_delta", fmt.Sprintf(`{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":%s}}`, b))
	}
}

// crashCopy copies the data directory's databases as they are on disk now,
// with the turn still running: what a kill -9 of the harness leaves behind.
func crashCopy(t *testing.T, r *rig, pid string) string {
	t.Helper()
	dst := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dst, "projects", pid), 0o755); err != nil {
		t.Fatal(err)
	}
	src := filepath.Dir(filepath.Dir(r.store.ProjectDir(pid)))
	for _, rel := range []string{"registry.sqlite", filepath.Join("projects", pid, "project.sqlite")} {
		db, err := sql.Open("sqlite", filepath.Join(src, rel))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec(`VACUUM INTO ?`, filepath.Join(dst, rel)); err != nil {
			t.Fatal(err)
		}
		_ = db.Close()
	}
	return dst
}

// restart opens a copied data directory the way `harness serve` does after a crash: a new store,
// orchestrator and service, then Recover.
func restart(t *testing.T, dir string, llm http.Handler) *rig {
	t.Helper()
	r := newRigAt(t, dir, llm, orchestrator.Options{})
	if err := r.svc.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}
	return r
}

func partialCount(t *testing.T, r *rig, pid string) (n int, text string) {
	t.Helper()
	db, err := sql.Open("sqlite", filepath.Join(r.store.ProjectDir(pid), "project.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	_ = db.QueryRow(`SELECT COUNT(*), COALESCE(MAX(text), '') FROM partials`).Scan(&n, &text)
	return n, text
}

func orchMessages(t *testing.T, r *rig, pid string) (projectstore.Agent, []projectstore.Message) {
	t.Helper()
	ctx := context.Background()
	db, err := r.store.Get(ctx, pid)
	if err != nil {
		t.Fatal(err)
	}
	orch, err := db.Orchestrator(ctx)
	if err != nil {
		t.Fatal(err)
	}
	msgs, err := db.Messages(ctx, orch.ID)
	if err != nil {
		t.Fatal(err)
	}
	return orch, msgs
}

func onlyExchange(t *testing.T, r *rig, pid string) projectstore.Exchange {
	t.Helper()
	ctx := context.Background()
	db, err := r.store.Get(ctx, pid)
	if err != nil {
		t.Fatal(err)
	}
	sid, err := db.CurrentSessionID(ctx)
	if err != nil {
		t.Fatal(err)
	}
	_, exs, err := db.SessionOf(ctx, sid)
	if err != nil || len(exs) != 1 {
		t.Fatalf("exchanges = %+v, %v; want one", exs, err)
	}
	return exs[0]
}

// P1-1: the text streamed so far is checkpointed while it streams; after a
// kill and a restart it is the turn's stopped assistant message, the turn is
// closed as interrupted (row, exchange) and the next request sees it closed.
func TestKilledWhileStreamingKeepsTheTextAndClosesTheTurn(t *testing.T) {
	defer orchestrator.SetCheckpointEveryForTest(50 * time.Millisecond)()
	release := make(chan struct{})
	var once sync.Once
	r := newRigWith(t, fakeLLM(func(w http.ResponseWriter, hr *http.Request, req fakeReq) {
		streamText(w, "The first part ", "of a long answer, ", "still going")
		select { // the model is still writing when the harness dies
		case <-release:
		case <-hr.Context().Done():
		}
	}), orchestrator.Options{Stream: true})
	t.Cleanup(func() { once.Do(func() { close(release) }) })
	pid := r.project(t, 1)
	if _, err := r.orch.Start(context.Background(), pid, "write an essay"); err != nil {
		t.Fatal(err)
	}
	want := "The first part of a long answer, still going"
	waitUntil(t, "the checkpoint of the streamed text", func() bool { _, text := partialCount(t, r, pid); return text == want })
	dir := crashCopy(t, r, pid)
	once.Do(func() { close(release) })

	var seen []json.RawMessage
	var mu sync.Mutex
	r2 := restart(t, dir, fakeLLM(func(w http.ResponseWriter, hr *http.Request, req fakeReq) {
		mu.Lock()
		seen = req.Msgs
		mu.Unlock()
		respond(w, "end_turn", textBlock("PONG"))
	}))
	orch, msgs := orchMessages(t, r2, pid)
	if len(msgs) != 2 || msgs[1].Role != "assistant" || !msgs[1].Stopped || *msgs[1].Content[0].Text != want {
		t.Fatalf("messages after restart = %+v, want the request and the kept text flagged stopped", msgs)
	}
	p := usererr.TurnInterrupted()
	if orch.Status != projectstore.StatusIdle || orch.Error == nil || *orch.Error != p.Message || orch.ErrorHint == nil || *orch.ErrorHint != p.Hint || orch.FinishedAt == nil {
		t.Fatalf("orchestrator after restart = %+v", orch)
	}
	if n, _ := partialCount(t, r2, pid); n != 0 {
		t.Fatalf("%d checkpoints left after the restart", n)
	}
	x := onlyExchange(t, r2, pid)
	if x.Status != projectstore.ExchangeFailed || !x.Interrupted || x.Answer != want || x.MessageID != msgs[1].ID || x.TurnID != msgs[0].ID {
		t.Fatalf("exchange = %+v", x)
	}
	pr, err := r2.svc.Get(context.Background(), pid)
	if err != nil || pr.Status != "idle" || pr.Attention != "failed" {
		t.Fatalf("project = %+v, %v", pr.Summary, err)
	}

	// The next request carries the interrupted turn closed: the request, the kept text, then the new request.
	if st := r2.run(t, pid, "Reply PONG", nil); st != "completed" {
		t.Fatalf("next turn = %s", st)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(seen) != 3 || !strings.Contains(string(seen[1]), `"assistant"`) || !strings.Contains(string(seen[1]), "still going") ||
		!strings.Contains(string(seen[2]), "Reply PONG") {
		t.Fatalf("history of the next request = %s", seen)
	}
}

// P1-1: a kill during a tool call leaves the call closed with the interruption
// result after the restart, and the turn's duration runs to its last sign of
// life (keepAlive), not to the last message.
func TestKilledDuringAToolCallClosesTheCall(t *testing.T) {
	defer orchestrator.SetTurnAliveEveryForTest(40 * time.Millisecond)()
	started := make(chan struct{})
	var once sync.Once
	r := newRig(t, fakeLLM(func(w http.ResponseWriter, hr *http.Request, req fakeReq) {
		if req.isOrchestrator() {
			respond(w, "tool_use", textBlock("Delegating."), spawnBlock("t1", "a"))
			return
		}
		once.Do(func() { close(started) })
		<-hr.Context().Done() // the sub-agent works for a long time
	}))
	pid := r.project(t, 2)
	if _, err := r.orch.Start(context.Background(), pid, "go"); err != nil {
		t.Fatal(err)
	}
	select {
	case <-started:
	case <-time.After(10 * time.Second):
		t.Fatal("child never started")
	}
	time.Sleep(400 * time.Millisecond)
	dir := crashCopy(t, r, pid)

	r2 := restart(t, dir, fakeLLM(func(w http.ResponseWriter, hr *http.Request, req fakeReq) {
		respond(w, "end_turn", textBlock("ok"))
	}))
	_, msgs := orchMessages(t, r2, pid)
	last := msgs[len(msgs)-1]
	if len(msgs) != 3 || last.Role != "user" || last.Content[0].Type != "tool_result" || *last.Content[0].ToolUseID != "t1" ||
		!*last.Content[0].IsError || *last.Content[0].Content != "interrupted: the tool call did not complete" {
		t.Fatalf("messages after restart = %+v", msgs)
	}
	x := onlyExchange(t, r2, pid)
	if !x.Interrupted || x.Status != projectstore.ExchangeFailed || x.Answer != "Delegating." || x.DurationMS < 300 {
		t.Fatalf("exchange = %+v (want interrupted, the text, at least 300 ms)", x)
	}
	for _, a := range r2.agents(t, pid) {
		if a.ParentID != nil && (a.Status != projectstore.StatusFailed || a.Error == nil || *a.Error != "interrupted") {
			t.Fatalf("sub-agent after restart = %+v", a)
		}
	}
}

// A checkpoint older than the agent's last message is what that message
// already holds (the harness died between storing it and removing the
// checkpoint): it is dropped, not stored twice.
func TestStaleCheckpointIsNotStoredTwice(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	r := newRigAt(t, dir, fakeLLM(func(w http.ResponseWriter, hr *http.Request, req fakeReq) {}), orchestrator.Options{})
	pid := r.project(t, 1)
	db, err := r.store.Get(ctx, pid)
	if err != nil {
		t.Fatal(err)
	}
	orch, _ := db.Orchestrator(ctx)
	if _, err := db.AppendMessage(ctx, orch.ID, "user", []byte(`[{"type":"text","text":"hi"}]`)); err != nil {
		t.Fatal(err)
	}
	if err := db.SavePartial(ctx, orch.ID, "Hello th"); err != nil {
		t.Fatal(err)
	}
	time.Sleep(5 * time.Millisecond)
	if _, err := db.AppendMessage(ctx, orch.ID, "assistant", []byte(`[{"type":"text","text":"Hello there."}]`)); err != nil {
		t.Fatal(err)
	}
	running := projectstore.StatusRunning
	now := projectstore.Now()
	if _, err := db.UpdateAgent(ctx, orch.ID, projectstore.AgentPatch{Status: &running, StartedAt: &now}); err != nil {
		t.Fatal(err)
	}
	if err := r.svc.Recover(ctx); err != nil {
		t.Fatal(err)
	}
	_, msgs := orchMessages(t, r, pid)
	if len(msgs) != 2 || *msgs[1].Content[0].Text != "Hello there." {
		t.Fatalf("messages = %+v", msgs)
	}
	if n, _ := partialCount(t, r, pid); n != 0 {
		t.Fatal("the stale checkpoint was kept")
	}
}

// P1-1: when the upstream breaks off mid-stream, the text it had sent is kept
// (flagged stopped) and the turn fails with the error.
func TestUpstreamBreakingOffKeepsTheStreamedText(t *testing.T) {
	r := newRigWith(t, fakeLLM(func(w http.ResponseWriter, hr *http.Request, req fakeReq) {
		streamText(w, "Half of ", "the answer")
		panic(http.ErrAbortHandler) // the connection drops mid-body: the router or the provider went away
	}), orchestrator.Options{Stream: true})
	pid := r.project(t, 1)
	if st := r.run(t, pid, "write", nil); st != "failed" {
		t.Fatalf("status = %s, want failed", st)
	}
	orch, msgs := orchMessages(t, r, pid)
	if len(msgs) != 2 || msgs[1].Role != "assistant" || !msgs[1].Stopped || *msgs[1].Content[0].Text != "Half of the answer" {
		t.Fatalf("messages = %+v", msgs)
	}
	if orch.Error == nil || *orch.Error == "" {
		t.Fatalf("orchestrator error = %v", orch.Error)
	}
	if x := onlyExchange(t, r, pid); x.Status != projectstore.ExchangeFailed || x.Interrupted || x.Answer != "Half of the answer" {
		t.Fatalf("exchange = %+v", x)
	}
	if n, _ := partialCount(t, r, pid); n != 0 {
		t.Fatal("checkpoint left after the message was stored")
	}
}

// P1-1 for an ACP orchestrator: the text the agent was writing and the tool
// call it had open when the harness died are kept and closed the same way.
func TestKilledDuringAnACPTurnKeepsTheTextAndClosesTheCall(t *testing.T) {
	defer orchestrator.SetCheckpointEveryForTest(50 * time.Millisecond)()
	for _, tc := range []struct{ marker, text string }{
		{"[say-hang]", "Working on it, first the"},    // text only: it was checkpointed, never flushed
		{"[hang]", "I'll look at the project first."}, // text flushed at the tool call, the call left open
	} {
		t.Run(tc.marker, func(t *testing.T) {
			r := newACPRig(t, mockllmStub(), fakeAgent("fake", true))
			name := "p"
			p, err := r.svcWithAgents(t, fakeAgent("fake", true)).Create(context.Background(), project.Input{
				Name: &name, Folders: &[]project.FolderInput{{Path: t.TempDir()}}, Models: &config.Models{Orchestrator: "acp:fake"},
			})
			if err != nil {
				t.Fatal(err)
			}
			pid := p.ID
			if _, err := r.orch.Start(context.Background(), pid, "[acp] "+tc.marker); err != nil {
				t.Fatal(err)
			}
			waitUntil(t, "the agent's text", func() bool {
				_, text := partialCount(t, r, pid)
				_, msgs := orchMessages(t, r, pid)
				return strings.Contains(text, "Working on it") || len(msgs) >= 3
			})
			dir := crashCopy(t, r, pid)

			r2 := restart(t, dir, mockllmStub())
			_, msgs := orchMessages(t, r2, pid)
			var texts []string
			open := map[string]bool{}
			for _, m := range msgs {
				for _, b := range m.Content {
					switch {
					case b.Type == "text" && m.Role == "assistant":
						texts = append(texts, strings.TrimSpace(*b.Text))
					case b.Type == "tool_use":
						open[*b.ID] = true
					case b.Type == "tool_result":
						if !*b.IsError || *b.Content != "interrupted: the tool call did not complete" {
							t.Fatalf("result = %+v", b)
						}
						delete(open, *b.ToolUseID)
					}
				}
			}
			if len(texts) != 1 || texts[0] != tc.text || len(open) != 0 {
				t.Fatalf("after restart: texts %q, open calls %v (messages %+v)", texts, open, msgs)
			}
			if x := onlyExchange(t, r2, pid); !x.Interrupted || x.Status != projectstore.ExchangeFailed || x.Answer != tc.text {
				t.Fatalf("exchange = %+v", x)
			}
		})
	}
}
