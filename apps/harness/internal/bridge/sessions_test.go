package bridge_test

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/memory"
	"github.com/ndolinschi/Octo/apps/harness/internal/orchestrator"
	"github.com/ndolinschi/Octo/apps/harness/internal/project"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

type sessionList struct {
	Sessions []orchestrator.SessionView `json:"sessions"`
}

type sessionOne struct {
	Session orchestrator.SessionView `json:"session"`
	Outcome string                   `json:"outcome"`
}

func (e *env) sessions(t *testing.T, pid, query string) []orchestrator.SessionView {
	t.Helper()
	var l sessionList
	e.into(t, "GET", "/v1/projects/"+pid+"/sessions"+query, nil, http.StatusOK, &l)
	return l.Sessions
}

func (e *env) sessionDetail(t *testing.T, pid, sid string) project.SessionDetail {
	t.Helper()
	var d project.SessionDetail
	e.into(t, "GET", "/v1/projects/"+pid+"/sessions/"+sid, nil, http.StatusOK, &d)
	return d
}

// lastAnswer is the answer of the newest exchange of a main session.
func (e *env) lastAnswer(t *testing.T, pid, sid string) string {
	t.Helper()
	d := e.sessionDetail(t, pid, sid)
	if len(d.Exchanges) == 0 {
		t.Fatalf("session %s has no exchange", sid)
	}
	return d.Exchanges[len(d.Exchanges)-1].Answer
}

func current(t *testing.T, l []orchestrator.SessionView) orchestrator.SessionView {
	t.Helper()
	var out []orchestrator.SessionView
	for _, s := range l {
		if s.Current {
			out = append(out, s)
		}
	}
	if len(out) != 1 {
		t.Fatalf("want exactly one current session, got %+v", l)
	}
	return out[0]
}

// New session, resume, archive, delete over real turns: the mock model answers [ctx] requests with the user texts
// it was sent, so the answer shows which conversation the harness rebuilt.
func TestMainSessionsNewResumeArchiveDelete(t *testing.T) {
	e := newEnv(t, nil)
	pid, _ := e.v7Project(t, "full")
	stream := e.subscribe(t, pid)
	say := func(text string) {
		e.into(t, "POST", "/v1/projects/"+pid+"/messages", map[string]string{"text": text}, http.StatusAccepted, nil)
		collectUntilTurnFinished(t, stream)
	}
	say("[ctx] alpha")
	l := e.sessions(t, pid, "")
	first := current(t, l)
	if len(l) != 1 || first.Kind != "main" || first.Exchanges != 1 || first.State != "idle" || first.Title != "[ctx] alpha" || !first.CanMessage {
		t.Fatalf("after the first turn: %+v", l)
	}

	var created sessionOne
	e.into(t, "POST", "/v1/projects/"+pid+"/sessions", map[string]string{"title": "Second thoughts"}, http.StatusCreated, &created)
	if !created.Session.Current || created.Session.Title != "Second thoughts" || created.Session.ID == first.ID || created.Session.Exchanges != 0 {
		t.Fatalf("created = %+v", created.Session)
	}
	second := created.Session
	l = e.sessions(t, pid, "")
	if len(l) != 2 || current(t, l).ID != second.ID {
		t.Fatalf("after POST /sessions: %+v", l)
	}
	say("[ctx] beta")
	if a := e.lastAnswer(t, pid, second.ID); !strings.Contains(a, "[ctx] beta") || strings.Contains(a, "[ctx] alpha") {
		t.Fatalf("the new session's context = %q", a)
	}
	if d := e.sessionDetail(t, pid, second.ID); d.Session.Title != "Second thoughts" || d.Session.Exchanges != 1 {
		t.Fatalf("an edited title must survive the first request: %+v", d.Session)
	}

	// Resume the first: the model sees its context, not the second's.
	var resumed sessionOne
	e.into(t, "POST", "/v1/projects/"+pid+"/sessions/"+first.ID+"/resume", nil, http.StatusOK, &resumed)
	if !resumed.Session.Current || resumed.Session.ID != first.ID {
		t.Fatalf("resumed = %+v", resumed.Session)
	}
	if cur := current(t, e.sessions(t, pid, "")); cur.ID != first.ID {
		t.Fatalf("current = %+v", cur)
	}
	say("[ctx] gamma")
	a := e.lastAnswer(t, pid, first.ID)
	if !strings.Contains(a, "[ctx] alpha") || !strings.Contains(a, "[ctx] gamma") || strings.Contains(a, "[ctx] beta") {
		t.Fatalf("the resumed session's context = %q", a)
	}
	if d := e.sessionDetail(t, pid, first.ID); d.Session.Exchanges != 2 {
		t.Fatalf("the resumed session took the exchange: %+v", d.Session)
	}
	if d := e.sessionDetail(t, pid, second.ID); d.Session.Exchanges != 1 {
		t.Fatalf("the other session changed: %+v", d.Session)
	}

	// The transcript of one session holds its own messages only.
	var tr project.SessionMessages
	e.into(t, "GET", "/v1/projects/"+pid+"/sessions/"+first.ID+"/messages", nil, http.StatusOK, &tr)
	var all strings.Builder
	for _, m := range tr.Messages {
		for _, c := range m.Content {
			if c.Text != nil {
				all.WriteString(*c.Text + "\n")
			}
		}
	}
	if !strings.Contains(all.String(), "alpha") || !strings.Contains(all.String(), "gamma") || strings.Contains(all.String(), "beta") {
		t.Fatalf("session transcript = %s", all.String())
	}
	var orchAgent struct {
		Agents []struct {
			ID       string  `json:"id"`
			ParentID *string `json:"parent_id"`
		} `json:"agents"`
	}
	e.into(t, "GET", "/v1/projects/"+pid+"/agents", nil, http.StatusOK, &orchAgent)
	var oid string
	for _, a := range orchAgent.Agents {
		if a.ParentID == nil {
			oid = a.ID
		}
	}
	var viaAgent project.SessionMessages
	e.into(t, "GET", "/v1/projects/"+pid+"/agents/"+oid+"/messages?session_id="+second.ID, nil, http.StatusOK, &viaAgent)
	if len(viaAgent.Messages) == 0 || len(viaAgent.Messages) >= len(tr.Messages)+len(viaAgent.Messages) {
		t.Fatalf("agent messages of session = %+v", viaAgent)
	}
	if len(viaAgent.Conversations) != 1 {
		t.Fatalf("the clear that started the second session is its marker: %+v", viaAgent.Conversations)
	}

	// Edit, archive, filter.
	var patched sessionOne
	e.into(t, "PATCH", "/v1/projects/"+pid+"/sessions/"+second.ID, map[string]any{"title": "Renamed", "archived": true}, http.StatusOK, &patched)
	if patched.Session.Title != "Renamed" || !patched.Session.Archived {
		t.Fatalf("patched = %+v", patched.Session)
	}
	if l := e.sessions(t, pid, ""); len(l) != 1 || l[0].ID != first.ID {
		t.Fatalf("default list hides archived: %+v", l)
	}
	if l := e.sessions(t, pid, "?archived=true"); len(l) != 1 || l[0].ID != second.ID {
		t.Fatalf("archived list: %+v", l)
	}
	if l := e.sessions(t, pid, "?archived=all&kind=main"); len(l) != 2 {
		t.Fatalf("all: %+v", l)
	}
	if l := e.sessions(t, pid, "?state=idle"); len(l) != 1 {
		t.Fatalf("state=idle: %+v", l)
	}
	if l := e.sessions(t, pid, "?state=working"); len(l) != 0 {
		t.Fatalf("state=working: %+v", l)
	}
	e.wantError(t, "PATCH", "/v1/projects/"+pid+"/sessions/"+first.ID, map[string]any{"archived": true}, http.StatusConflict, "current_session")
	e.wantError(t, "PATCH", "/v1/projects/"+pid+"/sessions/"+first.ID, map[string]any{}, http.StatusBadRequest, "invalid_request")
	e.wantError(t, "GET", "/v1/projects/"+pid+"/sessions?kind=x", nil, http.StatusBadRequest, "invalid_request")
	e.wantError(t, "GET", "/v1/projects/"+pid+"/sessions?state=x", nil, http.StatusBadRequest, "invalid_request")
	e.wantError(t, "GET", "/v1/projects/"+pid+"/sessions/ses_nope", nil, http.StatusNotFound, "not_found")
	e.wantError(t, "POST", "/v1/projects/"+pid+"/sessions/ses_nope/resume", nil, http.StatusNotFound, "not_found")

	// Delete: not the current one; the other one's exchanges leave memory and search.
	e.wantError(t, "DELETE", "/v1/projects/"+pid+"/sessions/"+first.ID, nil, http.StatusConflict, "current_session")
	e.into(t, "DELETE", "/v1/projects/"+pid+"/sessions/"+second.ID, nil, http.StatusNoContent, nil)
	e.wantError(t, "GET", "/v1/projects/"+pid+"/sessions/"+second.ID, nil, http.StatusNotFound, "not_found")
	if hits := e.search(t, pid, "beta"); len(hits.Hits) != 0 {
		t.Fatalf("a deleted session is still searchable: %+v", hits.Hits)
	}
	var ms struct {
		Sessions []projectstore.Session `json:"sessions"`
	}
	e.into(t, "GET", "/v1/projects/"+pid+"/memory/sessions", nil, http.StatusOK, &ms)
	if len(ms.Sessions) != 1 || ms.Sessions[0].ID != first.ID {
		t.Fatalf("memory sessions = %+v", ms.Sessions)
	}
	var md memory.SessionDetail
	e.into(t, "GET", "/v1/projects/"+pid+"/memory/sessions/"+first.ID, nil, http.StatusOK, &md)
	if len(md.Exchanges) != 2 {
		t.Fatalf("memory detail = %+v", md)
	}
}

// Events: session.created and session.current for a new session, session.current for a resume, session.updated while a turn runs.
func TestSessionEvents(t *testing.T) {
	e := newEnv(t, nil)
	pid, _ := e.v7Project(t, "full")
	stream := e.subscribe(t, pid)
	e.into(t, "POST", "/v1/projects/"+pid+"/messages", map[string]string{"text": "quick one"}, http.StatusAccepted, nil)
	evs := collectUntilTurnFinished(t, stream)
	if count(evs, "session.updated") < 2 {
		t.Fatalf("a turn announces its session at the start and at the end: %d", count(evs, "session.updated"))
	}
	var first sessionOne
	var l = e.sessions(t, pid, "")
	first.Session = l[0]
	e.into(t, "POST", "/v1/projects/"+pid+"/sessions", nil, http.StatusCreated, nil)
	var got []sseEvent
	deadline := time.After(10 * time.Second)
	for count(got, "session.created") == 0 || count(got, "session.current") == 0 {
		select {
		case ev := <-stream:
			got = append(got, ev)
		case <-deadline:
			t.Fatalf("events = %+v", got)
		}
	}
	for _, ev := range got {
		if ev.Type == "session.current" && ev.Data["previous_session_id"] != first.Session.ID {
			t.Fatalf("session.current = %+v", ev.Data)
		}
	}
	e.into(t, "POST", "/v1/projects/"+pid+"/sessions/"+first.Session.ID+"/resume", nil, http.StatusOK, nil)
	deadline = time.After(10 * time.Second)
	for {
		select {
		case ev := <-stream:
			if ev.Type == "session.current" && ev.Data["session_id"] == first.Session.ID {
				return
			}
		case <-deadline:
			t.Fatal("no session.current for the resume")
		}
	}
}

// Owner's report (decision 95 d): after /clear the new session was announced as "working" with nothing running,
// because the clear holds the project's turn slot while it publishes. No event and no listing may say so.
func TestClearedSessionIsNotWorking(t *testing.T) {
	e := newEnv(t, nil)
	pid, _ := e.v7Project(t, "full")
	e.into(t, "POST", "/v1/projects/"+pid+"/messages", map[string]string{"text": "quick one"}, http.StatusAccepted, nil)
	collectUntilTurnFinished(t, e.subscribe(t, pid))
	stream := e.subscribe(t, pid)
	e.into(t, "POST", "/v1/projects/"+pid+"/clear", nil, http.StatusOK, nil)
	var got []sseEvent
	deadline := time.After(10 * time.Second)
	for count(got, "session.created") == 0 || count(got, "context.updated") == 0 {
		select {
		case ev := <-stream:
			got = append(got, ev)
		case <-deadline:
			t.Fatalf("events = %+v", got)
		}
	}
	for _, ev := range got {
		if ev.Type != "session.created" && ev.Type != "session.updated" {
			continue
		}
		if s, ok := ev.Data["session"].(map[string]any); ok && s["state"] != "idle" {
			t.Fatalf("%s announces %v while nothing runs: %+v", ev.Type, s["state"], s)
		}
	}
	if c := current(t, e.sessions(t, pid, "")); c.State != projectstore.SessionIdle {
		t.Fatalf("listed state = %q", c.State)
	}
}

// A turn in progress: resume and new session are 409 turn_in_progress; the working state is shown; Stop ends it.
func TestSessionsWhileATurnRuns(t *testing.T) {
	gate := make(chan struct{})
	e := newEnv(t, gate)
	pid, _ := e.v7Project(t, "full")
	stream := e.subscribe(t, pid)
	feed, fed := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(fed)
		for {
			select {
			case gate <- struct{}{}:
			case <-feed:
				return
			}
		}
	}()
	// Late side calls of the harness (a digest) may still wait on the model: opening the gate for good frees them at the end.
	t.Cleanup(func() {
		select {
		case <-feed:
		default:
			close(feed)
		}
		<-fed
		close(gate)
	})
	e.into(t, "POST", "/v1/projects/"+pid+"/messages", map[string]string{"text": "quick first"}, http.StatusAccepted, nil)
	collectUntilTurnFinished(t, stream)
	first := e.sessions(t, pid, "")[0]
	var created sessionOne
	e.into(t, "POST", "/v1/projects/"+pid+"/sessions", nil, http.StatusCreated, &created)
	close(feed) // from here the model never answers
	<-fed
	e.into(t, "POST", "/v1/projects/"+pid+"/messages", map[string]string{"text": "quick wait"}, http.StatusAccepted, nil)
	deadline := time.Now().Add(10 * time.Second)
	for {
		if l := e.sessions(t, pid, "?state=working"); len(l) == 1 && l[0].ID == created.Session.ID {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the session never showed as working: %+v", e.sessions(t, pid, ""))
		}
		time.Sleep(20 * time.Millisecond)
	}
	e.wantError(t, "POST", "/v1/projects/"+pid+"/sessions", nil, http.StatusConflict, "turn_in_progress")
	e.wantError(t, "POST", "/v1/projects/"+pid+"/sessions/"+first.ID+"/resume", nil, http.StatusConflict, "turn_in_progress")
	e.wantError(t, "DELETE", "/v1/projects/"+pid+"/sessions/"+created.Session.ID, nil, http.StatusConflict, "current_session")
	e.into(t, "POST", "/v1/projects/"+pid+"/sessions/"+created.Session.ID+"/stop", nil, http.StatusOK, nil)
	collectUntilTurnFinished(t, stream)
	e.wantError(t, "POST", "/v1/projects/"+pid+"/sessions/"+created.Session.ID+"/stop", nil, http.StatusConflict, "not_running")
	if cur := current(t, e.sessions(t, pid, "")); cur.State != "stopped" {
		t.Fatalf("a stopped turn leaves the session stopped: %+v", cur)
	}
}
