package orchestrator_test

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/config"
	"github.com/ndolinschi/Octo/apps/harness/internal/memory"
	"github.com/ndolinschi/Octo/apps/harness/internal/project"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
	"github.com/ndolinschi/Octo/apps/harness/internal/usererr"
)

// modelLog is a fake model that answers PONG and keeps the messages of every request it got.
type modelLog struct {
	mu   sync.Mutex
	seen [][]json.RawMessage
}

func (rc *modelLog) handler() http.Handler {
	return fakeLLM(func(w http.ResponseWriter, _ *http.Request, req fakeReq) { rc.answer(w, req) })
}

func (rc *modelLog) answer(w http.ResponseWriter, req fakeReq) {
	rc.mu.Lock()
	rc.seen = append(rc.seen, req.Msgs)
	rc.mu.Unlock()
	respond(w, "end_turn", textBlock("PONG"))
}

func (rc *modelLog) last(t *testing.T) []json.RawMessage {
	t.Helper()
	rc.mu.Lock()
	defer rc.mu.Unlock()
	if len(rc.seen) == 0 {
		t.Fatal("the model got no request")
	}
	return rc.seen[len(rc.seen)-1]
}

type wireMsg struct {
	Role    string `json:"role"`
	Content []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	} `json:"content"`
}

func wireText(t *testing.T, raw json.RawMessage) (role, text string) {
	t.Helper()
	var m wireMsg
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	var parts []string
	for _, b := range m.Content {
		if b.Type == "text" {
			parts = append(parts, b.Text)
		}
	}
	return m.Role, strings.Join(parts, "\n")
}

// wantClosed checks that the model got exactly: the unanswered request, the harness's note closing it (saying why),
// then the next request.
func wantClosed(t *testing.T, got []json.RawMessage, first, why, next string) {
	t.Helper()
	if len(got) != 3 {
		t.Fatalf("the model got %d messages, want request, note, request: %s", len(got), got)
	}
	if role, text := wireText(t, got[0]); role != "user" || text != first {
		t.Fatalf("first message = %s %q", role, text)
	}
	if role, text := wireText(t, got[1]); role != "assistant" || !strings.Contains(text, "was not carried out") || !strings.Contains(text, why) ||
		!strings.Contains(text, "Do not do it or continue it now") {
		t.Fatalf("closing note = %s %q", role, text)
	}
	if role, text := wireText(t, got[2]); role != "user" || text != next {
		t.Fatalf("last message = %s %q", role, text)
	}
}

// interruptedBeforeAnswer runs a turn the harness dies in before the model wrote anything and restarts it with llm.
func interruptedBeforeAnswer(t *testing.T, llm http.Handler) (*rig, string) {
	t.Helper()
	inModel := make(chan struct{})
	release := make(chan struct{})
	var once, rel sync.Once
	r := newRig(t, fakeLLM(func(w http.ResponseWriter, hr *http.Request, req fakeReq) {
		once.Do(func() { close(inModel) })
		select { // "Thinking…": the model has not written a word when the harness dies
		case <-release:
		case <-hr.Context().Done():
		}
	}))
	t.Cleanup(func() { rel.Do(func() { close(release) }) })
	pid := r.project(t, 1)
	if _, err := r.orch.Start(context.Background(), pid, "write a long essay"); err != nil {
		t.Fatal(err)
	}
	select {
	case <-inModel:
	case <-time.After(10 * time.Second):
		t.Fatal("the turn never reached the model")
	}
	dir := crashCopy(t, r, pid)
	rel.Do(func() { close(release) })
	return restart(t, dir, llm), pid
}

// NEW-8: a turn cut by a restart before any answer is closed for the model: the next request's history is the
// interrupted request, the harness's note (not stored), the new request; nothing new is stored in the transcript.
// NEW-9: the turn's hint and the exchange say that nothing was kept.
func TestInterruptedRequestIsClosedForTheModel(t *testing.T) {
	rc := &modelLog{}
	r, pid := interruptedBeforeAnswer(t, rc.handler())
	orch, msgs := orchMessages(t, r, pid)
	want := usererr.TurnInterrupted(false)
	if len(msgs) != 1 || orch.ErrorHint == nil || *orch.ErrorHint != want.Hint || !strings.Contains(want.Hint, "Nothing had been written") {
		t.Fatalf("after restart: hint %v, messages %+v", orch.ErrorHint, msgs)
	}
	if x := onlyExchange(t, r, pid); !x.Interrupted || x.KeptText == nil || *x.KeptText || x.Error == nil || x.Error.Hint != want.Hint {
		t.Fatalf("exchange = %+v", x)
	}

	if st := r.run(t, pid, "Reply with the single word PONG.", nil); st != "completed" {
		t.Fatalf("next turn = %s", st)
	}
	wantClosed(t, rc.last(t), "write a long essay", "interrupted before any answer", "Reply with the single word PONG.")
	if _, msgs := orchMessages(t, r, pid); len(msgs) != 3 || msgs[0].Role != "user" || msgs[1].Role != "user" || msgs[2].Role != "assistant" {
		t.Fatalf("stored = %+v; the note must not be stored", msgs)
	}
	// A later turn sees the same closed history, so the provider's cached prefix holds.
	if st := r.run(t, pid, "and again", nil); st != "completed" {
		t.Fatal(st)
	}
	if got := rc.last(t); len(got) != 5 {
		t.Fatalf("later history = %d messages, want 5", len(got))
	} else if role, text := wireText(t, got[1]); role != "assistant" || !strings.Contains(text, "was not carried out") {
		t.Fatalf("later history lost the note: %s %q", role, text)
	}
}

// NEW-8: Retry of the interrupted request runs it once: the stored request is run again (not stored twice) and the
// model gets it alone, with no note; the next request then follows the answer without a note.
func TestRetryOfAnInterruptedRequestRunsItOnce(t *testing.T) {
	rc := &modelLog{}
	r, pid := interruptedBeforeAnswer(t, rc.handler())
	if st := r.run(t, pid, "write a long essay", nil); st != "completed" {
		t.Fatalf("retry = %s", st)
	}
	if got := rc.last(t); len(got) != 1 {
		t.Fatalf("the retry sent %d messages, want the request alone: %s", len(got), got)
	}
	_, msgs := orchMessages(t, r, pid)
	if len(msgs) != 2 || msgs[0].Role != "user" || msgs[1].Role != "assistant" {
		t.Fatalf("after retry = %+v", msgs)
	}
	if x := onlyExchange(t, r, pid); x.Status != projectstore.ExchangeCompleted || x.KeptText != nil {
		t.Fatalf("retried exchange = %+v", x)
	}
	if st := r.run(t, pid, "next", nil); st != "completed" {
		t.Fatal(st)
	}
	got := rc.last(t)
	if len(got) != 3 {
		t.Fatalf("history = %s", got)
	}
	if role, text := wireText(t, got[1]); role != "assistant" || text != "PONG" {
		t.Fatalf("second message = %s %q, want the answer", role, text)
	}
}

// NEW-8: the same hole for a turn that failed before any output (the model's service refused) and for one the
// person stopped before any output.
func TestFailedOrStoppedRequestIsClosedForTheModel(t *testing.T) {
	t.Run("failed", func(t *testing.T) {
		var calls atomic.Int32
		rc := &modelLog{}
		r := newRig(t, fakeLLM(func(w http.ResponseWriter, hr *http.Request, req fakeReq) {
			if calls.Add(1) == 1 {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusBadRequest)
				_, _ = w.Write([]byte(`{"type":"error","error":{"type":"invalid_request_error","message":"upstream says no"}}`))
				return
			}
			rc.answer(w, req)
		}))
		pid := r.project(t, 1)
		if st := r.run(t, pid, "first", nil); st != "failed" {
			t.Fatalf("first = %s", st)
		}
		if x := onlyExchange(t, r, pid); x.KeptText == nil || *x.KeptText {
			t.Fatalf("failed exchange = %+v", x)
		}
		if st := r.run(t, pid, "second", nil); st != "completed" {
			t.Fatal(st)
		}
		wantClosed(t, rc.last(t), "first", "it failed before any answer", "second")
	})
	t.Run("failed, window context", func(t *testing.T) {
		var calls atomic.Int32
		rc := &modelLog{}
		r := newRig(t, fakeLLM(func(w http.ResponseWriter, hr *http.Request, req fakeReq) {
			if calls.Add(1) == 1 {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusBadRequest)
				_, _ = w.Write([]byte(`{"type":"error","error":{"type":"invalid_request_error","message":"upstream says no"}}`))
				return
			}
			rc.answer(w, req)
		}))
		pid := r.project(t, 1)
		r.setMemory(t, pid, memory.Settings{Context: memory.ContextWindow, RecentExchanges: 5})
		if st := r.run(t, pid, "first", nil); st != "failed" {
			t.Fatalf("first = %s", st)
		}
		if st := r.run(t, pid, "second", nil); st != "completed" {
			t.Fatal(st)
		}
		got := rc.last(t)
		if len(got) != 3 {
			t.Fatalf("window history = %s", got)
		}
		if role, text := wireText(t, got[0]); role != "user" || !strings.HasSuffix(text, "first") {
			t.Fatalf("first = %s %q", role, text)
		}
		if role, text := wireText(t, got[1]); role != "assistant" || !strings.Contains(text, "it failed before any answer") {
			t.Fatalf("note = %s %q", role, text)
		}
		if role, text := wireText(t, got[2]); role != "user" || !strings.HasSuffix(text, "second") {
			t.Fatalf("last = %s %q", role, text)
		}
	})
	t.Run("stopped", func(t *testing.T) {
		var calls atomic.Int32
		inModel := make(chan struct{})
		rc := &modelLog{}
		r := newRig(t, fakeLLM(func(w http.ResponseWriter, hr *http.Request, req fakeReq) {
			if calls.Add(1) == 1 {
				close(inModel)
				<-hr.Context().Done()
				return
			}
			rc.answer(w, req)
		}))
		pid := r.project(t, 1)
		st := r.run(t, pid, "first", func() {
			<-inModel
			r.orch.Cancel(pid)
		})
		if st != "cancelled" {
			t.Fatalf("first = %s", st)
		}
		if st := r.run(t, pid, "second", nil); st != "completed" {
			t.Fatal(st)
		}
		wantClosed(t, rc.last(t), "first", "the person stopped it before any answer", "second")
	})
}

// NEW-8 for an ACP orchestrator: the agent may hold the unanswered request in its own session, so the next prompt
// starts with the note naming it.
func TestACPPromptClosesTheUnansweredRequest(t *testing.T) {
	r := newACPRig(t, mockllmStub(), fakeAgent("fake", true))
	name := "p"
	p, err := r.svcWithAgents(t, fakeAgent("fake", true)).Create(context.Background(), project.Input{
		Name: &name, Folders: &[]project.FolderInput{{Path: t.TempDir()}}, Models: &config.Models{Orchestrator: "acp:fake"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if st := r.run(t, p.ID, "[silent] build the thing", nil); st != "failed" {
		t.Fatalf("silent turn = %s", st)
	}
	if st := r.run(t, p.ID, "[echo] hello", nil); st != "completed" {
		t.Fatal(st)
	}
	_, msgs := orchMessages(t, r, p.ID)
	echo := messageTextOf(msgs[len(msgs)-1])
	if !strings.Contains(echo, `the previous request ("[silent] build the thing") was not carried out; it failed before any answer`) ||
		!strings.Contains(echo, "they will ask again.]\n\n[echo] hello") {
		t.Fatalf("prompt the agent got = %q", echo)
	}
	// Only the next prompt carries it.
	if st := r.run(t, p.ID, "[echo] again", nil); st != "completed" {
		t.Fatal(st)
	}
	_, msgs = orchMessages(t, r, p.ID)
	if echo := messageTextOf(msgs[len(msgs)-1]); strings.Contains(echo, "not carried out") {
		t.Fatalf("a later prompt repeats the note: %q", echo)
	}
}

func messageTextOf(m projectstore.Message) string {
	var parts []string
	for _, b := range m.Content {
		if b.Type == "text" && b.Text != nil {
			parts = append(parts, *b.Text)
		}
	}
	return strings.Join(parts, "\n")
}
