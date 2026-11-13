package orchestrator_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/config"
	"github.com/ndolinschi/Octo/apps/harness/internal/events"
	"github.com/ndolinschi/Octo/apps/harness/internal/orchestrator"
	"github.com/ndolinschi/Octo/apps/harness/internal/project"
)

// steerLLM answers the orchestrator: its first request waits on hold, then calls
// list_dir; every later request is recorded (the user messages it carries) and
// answered with text.
type steerLLM struct {
	hold chan struct{}
	mu   sync.Mutex
	// lastUser is the text of the last user message of each later request.
	lastUser []string
	requests int
}

func (s *steerLLM) handler() http.Handler {
	return fakeLLM(func(w http.ResponseWriter, hr *http.Request, req fakeReq) {
		s.mu.Lock()
		s.requests++
		n := s.requests
		s.mu.Unlock()
		if n == 1 {
			<-s.hold
			respond(w, "tool_use", `{"type":"tool_use","id":"t1","name":"list_dir","input":{}}`)
			return
		}
		var last struct {
			Content []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"content"`
		}
		_ = json.Unmarshal(req.Msgs[len(req.Msgs)-1], &last)
		txt := ""
		for _, c := range last.Content {
			if c.Type == "text" {
				txt += c.Text
			}
		}
		s.mu.Lock()
		s.lastUser = append(s.lastUser, txt)
		s.mu.Unlock()
		respond(w, "end_turn", textBlock("done"))
	})
}

func waitUntil(t *testing.T, what string, ok func() bool) {
	t.Helper()
	for i := 0; i < 500; i++ {
		if ok() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func TestSendNowSteersTheRunningTurnAtTheNextToolBoundary(t *testing.T) {
	llm := &steerLLM{hold: make(chan struct{})}
	r := newRig(t, llm.handler())
	pid, _ := r.projectWith(t, project.Input{})
	ctx := context.Background()
	ch, cancel := r.hub.Subscribe(pid)
	defer cancel()
	if _, _, err := r.orch.Submit(ctx, pid, "first request"); err != nil {
		t.Fatal(err)
	}
	waitUntil(t, "the first model request", func() bool { llm.mu.Lock(); defer llm.mu.Unlock(); return llm.requests == 1 })
	_, q, err := r.orch.Submit(ctx, pid, "also please check the tests")
	if err != nil || q == nil {
		t.Fatalf("queued = %+v %v", q, err)
	}
	if err := r.orch.SendNow(ctx, pid, q.ID, false); err != nil {
		t.Fatal(err)
	}
	if !r.orch.Running(pid) {
		t.Fatal("steering must not cancel the running turn")
	}
	close(llm.hold) // the model now calls its tool; the steered message is injected after the result

	finished, steered := 0, 0
	for finished == 0 {
		ev := <-ch
		switch ev.Type {
		case events.MessageSteered:
			steered++
			var d struct {
				QueueID string `json:"queue_id"`
				Text    string `json:"text"`
			}
			_ = json.Unmarshal(ev.Data, &d)
			if d.QueueID != q.ID || d.Text != "also please check the tests" {
				t.Fatalf("message.steered = %+v", d)
			}
		case events.TurnFinished:
			var f struct{ Status string }
			_ = json.Unmarshal(ev.Data, &f)
			if f.Status != "completed" {
				t.Fatalf("status = %s", f.Status)
			}
			finished++
		}
	}
	waitTurn(t, r, pid)
	if steered != 1 {
		t.Fatalf("message.steered events = %d", steered)
	}
	llm.mu.Lock()
	if len(llm.lastUser) != 1 || llm.lastUser[0] != "also please check the tests" {
		t.Fatalf("the request after the tool result ended with %q: the steered message must be its last user message", llm.lastUser)
	}
	llm.mu.Unlock()
	if qs, _, _ := r.orch.Queue(ctx, pid); len(qs) != 0 {
		t.Fatalf("the steered message is still queued: %+v", qs)
	}
	// Stored in order: request, assistant tool call, tool result, the steered message, the answer.
	db, _ := r.store.Get(ctx, pid)
	orch, _ := db.Orchestrator(ctx)
	var roles []string
	for _, m := range r.transcript(t, pid, orch.ID) {
		roles = append(roles, m.Role)
	}
	if strings.Join(roles, ",") != "user,assistant,user,user,assistant" {
		t.Fatalf("stored roles = %v", roles)
	}
	// One turn only: no second turn was started for the steered message.
	if n := countUserRequests(t, r, pid); n != 2 { // the request and the steered message; both are in this one turn
		t.Fatalf("user text messages = %d", n)
	}
}

func countUserRequests(t *testing.T, r *rig, pid string) int {
	t.Helper()
	db, _ := r.store.Get(context.Background(), pid)
	orch, _ := db.Orchestrator(context.Background())
	n := 0
	for _, m := range r.transcript(t, pid, orch.ID) {
		if m.Role == "user" && len(m.Content) > 0 && m.Content[0].Type == "text" {
			n++
		}
	}
	return n
}

func TestSteeredMessageThatNeverMeetsAToolBoundaryRunsNext(t *testing.T) {
	hold := make(chan struct{})
	var mu sync.Mutex
	seen := 0
	r := newRig(t, fakeLLM(func(w http.ResponseWriter, hr *http.Request, req fakeReq) {
		mu.Lock()
		seen++
		n := seen
		mu.Unlock()
		if n == 1 {
			<-hold
		}
		respond(w, "end_turn", textBlock("answer"))
	}))
	pid, _ := r.projectWith(t, project.Input{})
	ctx := context.Background()
	if _, _, err := r.orch.Submit(ctx, pid, "first"); err != nil {
		t.Fatal(err)
	}
	waitUntil(t, "the first request", func() bool { mu.Lock(); defer mu.Unlock(); return seen == 1 })
	_, q, _ := r.orch.Submit(ctx, pid, "second")
	if err := r.orch.SendNow(ctx, pid, q.ID, false); err != nil {
		t.Fatal(err)
	}
	close(hold) // the turn ends with no tool call: nothing to inject into
	waitUntil(t, "both turns", func() bool { return countUserRequests(t, r, pid) == 2 && !r.orch.Active(pid) })
	waitTurn(t, r, pid)
	if qs, _, _ := r.orch.Queue(ctx, pid); len(qs) != 0 {
		t.Fatalf("queue = %+v", qs)
	}
}

func TestSendNowOnAnACPTurnIsSteerUnsupportedUnlessInterrupting(t *testing.T) {
	r := newACPRig(t, (&modeLLM{}).handler(), fakeAgent("fake", true))
	r.svc = r.svcWithAgents(t, fakeAgent("fake", true))
	name := "p"
	p, err := r.svc.Create(context.Background(), project.Input{Name: &name, Folders: &[]project.FolderInput{{Path: t.TempDir()}},
		Models: &config.Models{Orchestrator: "acp:fake"}})
	if err != nil {
		t.Fatal(err)
	}
	pid := p.ID
	ctx := context.Background()
	if _, _, err := r.orch.Submit(ctx, pid, "[hang] stuck"); err != nil {
		t.Fatal(err)
	}
	waitUntil(t, "the turn to run", func() bool { return r.orch.Running(pid) })
	_, q, err := r.orch.Submit(ctx, pid, "[echo] next")
	if err != nil || q == nil {
		t.Fatalf("queued = %+v %v", q, err)
	}
	if err := r.orch.SendNow(ctx, pid, q.ID, false); !errors.Is(err, orchestrator.ErrSteerUnsupported) {
		t.Fatalf("SendNow = %v, want ErrSteerUnsupported", err)
	}
	if _, err := r.svc.SendNow(ctx, pid, q.ID, false); err == nil || !strings.Contains(err.Error(), "steer_unsupported") {
		t.Fatalf("service SendNow = %v", err)
	}
	if !r.orch.Running(pid) {
		t.Fatal("a refused steer cancelled the turn")
	}
	// With interrupt it is the old behaviour: cancel, then run that message.
	if steered, err := r.svc.SendNow(ctx, pid, q.ID, true); err != nil || steered {
		t.Fatalf("interrupt: steered=%v err=%v", steered, err)
	}
	waitUntil(t, "the queued message to run", func() bool {
		return strings.Contains(r.lastOrchestratorText(t, pid), "prompt<<") && !r.orch.Active(pid)
	})
}
