package bridge_test

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/project"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

func (e *env) queueState(t *testing.T, pid string) project.QueueState {
	t.Helper()
	var q project.QueueState
	e.into(t, "GET", "/v1/projects/"+pid+"/queue", nil, http.StatusOK, &q)
	return q
}

func (e *env) post(t *testing.T, pid, text string) (queued bool) {
	t.Helper()
	var out struct {
		Message *projectstore.Message
		Queued  *projectstore.QueuedMessage
	}
	e.into(t, "POST", "/v1/projects/"+pid+"/messages", map[string]string{"text": text}, http.StatusAccepted, &out)
	return out.Queued != nil
}

func userTexts(t *testing.T, e *env, pid string) []string {
	t.Helper()
	var proj project.Project
	e.into(t, "GET", "/v1/projects/"+pid, nil, http.StatusOK, &proj)
	var msgs struct{ Messages []projectstore.Message }
	e.into(t, "GET", "/v1/projects/"+pid+"/agents/"+proj.OrchestratorAgentID+"/messages", nil, http.StatusOK, &msgs)
	var out []string
	for _, m := range msgs.Messages {
		if m.Role == "user" && len(m.Content) > 0 && m.Content[0].Type == "text" {
			out = append(out, *m.Content[0].Text)
		}
	}
	return out
}

func (e *env) waitIdle(t *testing.T, pid string) {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for {
		var p project.Summary
		e.into(t, "GET", "/v1/projects/"+pid, nil, http.StatusOK, &p)
		if p.Status == "idle" && len(e.queueState(t, pid).Messages) == 0 {
			// the queue drains right after a turn ends; look twice
			time.Sleep(50 * time.Millisecond)
			e.into(t, "GET", "/v1/projects/"+pid, nil, http.StatusOK, &p)
			if p.Status == "idle" {
				return
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("project did not go idle: %+v", p)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestQueueRunsInOrderEachAsItsOwnTurn(t *testing.T) {
	gate := make(chan struct{})
	e := newEnv(t, gate)
	pid, _ := e.v7Project(t, "full")
	stream := e.subscribe(t, pid)
	if e.post(t, pid, "quick first") {
		t.Fatal("the first message was queued")
	}
	for _, text := range []string{"quick second", "quick third", "quick fourth"} {
		if !e.post(t, pid, text) {
			t.Fatalf("%q was not queued", text)
		}
	}
	q := e.queueState(t, pid)
	if q.Paused || len(q.Messages) != 3 || q.Messages[0].Text != "quick second" {
		t.Fatalf("queue = %+v", q)
	}
	// Edit and remove.
	var edited projectstore.QueuedMessage
	e.into(t, "PATCH", "/v1/projects/"+pid+"/queue/"+q.Messages[1].ID, map[string]string{"text": "quick third edited"}, http.StatusOK, &edited)
	e.wantError(t, "PATCH", "/v1/projects/"+pid+"/queue/"+q.Messages[1].ID, map[string]string{"text": " "}, http.StatusBadRequest, "invalid_request")
	e.wantError(t, "PATCH", "/v1/projects/"+pid+"/queue/q_nope", map[string]string{"text": "x"}, http.StatusNotFound, "not_found")
	e.into(t, "DELETE", "/v1/projects/"+pid+"/queue/"+q.Messages[2].ID, nil, http.StatusNoContent, nil)
	e.wantError(t, "DELETE", "/v1/projects/"+pid+"/queue/"+q.Messages[2].ID, nil, http.StatusNotFound, "not_found")
	close(gate)
	e.waitIdle(t, pid)

	got := userTexts(t, e, pid)
	want := []string{"quick first", "quick second", "quick third edited"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("user messages = %q, want %q", got, want)
	}
	finished, updates := 0, 0
	for len(stream) > 0 {
		ev := <-stream
		switch ev.Type {
		case "turn.finished":
			finished++
		case "queue.updated":
			updates++
		}
	}
	if finished != 3 || updates < 5 {
		t.Fatalf("turn.finished = %d, queue.updated = %d", finished, updates)
	}
}

func TestQueueFullRefusesThe21stMessage(t *testing.T) {
	gate := make(chan struct{})
	e := newEnv(t, gate)
	defer close(gate)
	pid, _ := e.v7Project(t, "full")
	e.post(t, pid, "quick running")
	for i := 0; i < projectstore.MaxQueue; i++ {
		if !e.post(t, pid, "quick queued") {
			t.Fatal("not queued")
		}
	}
	e.wantError(t, "POST", "/v1/projects/"+pid+"/messages", map[string]string{"text": "one too many"}, http.StatusConflict, "queue_full")
	e.into(t, "DELETE", "/v1/projects/"+pid+"/queue", nil, http.StatusNoContent, nil)
	if n := len(e.queueState(t, pid).Messages); n != 0 {
		t.Fatalf("queue after clear = %d", n)
	}
}

func TestCancelPausesTheQueueAndResumeContinues(t *testing.T) {
	gate := make(chan struct{})
	e := newEnv(t, gate)
	pid, _ := e.v7Project(t, "full")
	stream := e.subscribe(t, pid)
	e.post(t, pid, "quick first")
	e.post(t, pid, "quick second")
	e.into(t, "POST", "/v1/projects/"+pid+"/cancel", nil, http.StatusAccepted, nil)
	collectUntilTurnFinished(t, stream)
	deadline := time.Now().Add(10 * time.Second)
	for !e.queueState(t, pid).Paused {
		if time.Now().After(deadline) {
			t.Fatal("the queue was not paused after a cancel")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if q := e.queueState(t, pid); len(q.Messages) != 1 {
		t.Fatalf("cancel dropped queued messages: %+v", q)
	}
	var p project.Summary
	e.into(t, "GET", "/v1/projects/"+pid, nil, http.StatusOK, &p)
	if p.Status != "idle" {
		t.Fatalf("status = %s", p.Status)
	}
	close(gate)
	e.into(t, "POST", "/v1/projects/"+pid+"/queue/resume", nil, http.StatusAccepted, nil)
	e.waitIdle(t, pid)
	if got := userTexts(t, e, pid); len(got) != 2 || got[1] != "quick second" {
		t.Fatalf("user messages = %q", got)
	}
	if e.queueState(t, pid).Paused {
		t.Fatal("still paused after resume")
	}
}

func TestSendNowCancelsAndRunsThatMessageFirst(t *testing.T) {
	gate := make(chan struct{})
	e := newEnv(t, gate)
	pid, _ := e.v7Project(t, "full")
	e.post(t, pid, "quick first")
	e.post(t, pid, "quick second")
	e.post(t, pid, "quick third")
	q := e.queueState(t, pid)
	e.into(t, "POST", "/v1/projects/"+pid+"/queue/"+q.Messages[1].ID+"/send-now", nil, http.StatusAccepted, nil)
	e.wantError(t, "POST", "/v1/projects/"+pid+"/queue/q_nope/send-now", nil, http.StatusNotFound, "not_found")
	close(gate)
	e.waitIdle(t, pid)
	got := userTexts(t, e, pid)
	want := []string{"quick first", "quick third", "quick second"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("user messages = %q, want %q", got, want)
	}
}
