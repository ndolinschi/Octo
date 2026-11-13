package bridge_test

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/fakeacp"
	"github.com/ndolinschi/Octo/apps/harness/internal/orchestrator"
	"github.com/ndolinschi/Octo/apps/harness/internal/project"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

// agentSessions lists the agent sessions of a project by title.
func (e *env) agentSessions(t *testing.T, pid string) map[string]orchestrator.SessionView {
	t.Helper()
	out := map[string]orchestrator.SessionView{}
	for _, s := range e.sessions(t, pid, "?kind=agent") {
		out[s.Title] = s
	}
	return out
}

func (e *env) waitSession(t *testing.T, pid, sid string, ok func(orchestrator.SessionView) bool) orchestrator.SessionView {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for {
		d := e.sessionDetail(t, pid, sid)
		if ok(d.Session) {
			return d.Session
		}
		if time.Now().After(deadline) {
			t.Fatalf("session never reached the wanted state: %+v", d.Session)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func (e *env) sessionTexts(t *testing.T, pid, sid string) string {
	t.Helper()
	var tr project.SessionMessages
	e.into(t, "GET", "/v1/projects/"+pid+"/sessions/"+sid+"/messages", nil, http.StatusOK, &tr)
	var b strings.Builder
	for _, m := range tr.Messages {
		b.WriteString(m.Role + ": ")
		for _, c := range m.Content {
			if c.Text != nil {
				b.WriteString(*c.Text)
			}
		}
		b.WriteString("\n")
	}
	return b.String()
}

// A sub-agent gets a session when it is spawned: linked to the main session and the turn, with a transcript; a
// finished built-in agent is continued by a message; report_to_parent leaves its answer for the next turn.
func TestAgentSessionsAreCreatedAndContinued(t *testing.T) {
	e := newEnv(t, nil)
	pid, _ := e.v7Project(t, "full")
	stream := e.subscribe(t, pid)
	var posted struct{ Message projectstore.Message }
	e.into(t, "POST", "/v1/projects/"+pid+"/messages", map[string]string{"text": "build it"}, http.StatusAccepted, &posted)
	evs := collectUntilTurnFinished(t, stream)
	if count(evs, "session.created") < 3 {
		t.Fatalf("each sub-agent announces its session: %d", count(evs, "session.created"))
	}
	main := current(t, e.sessions(t, pid, ""))
	agents := e.agentSessions(t, pid)
	if len(agents) < 3 || main.Children != len(agents) {
		t.Fatalf("agent sessions = %+v (children %d)", agents, main.Children)
	}
	explorer := agents["Map the repository layout"]
	if explorer.Kind != "agent" || explorer.ParentSessionID != main.ID || explorer.TurnID != posted.Message.ID || explorer.AgentID == "" ||
		explorer.State != "idle" || explorer.Model == "" || !explorer.CanMessage {
		t.Fatalf("explorer session = %+v", explorer)
	}
	d := e.sessionDetail(t, pid, explorer.ID)
	if d.Agent == nil || d.Agent.Role != "Code explorer" || d.Agent.Task == "" {
		t.Fatalf("detail = %+v", d)
	}
	if tx := e.sessionTexts(t, pid, explorer.ID); !strings.Contains(tx, "user: The user asked") {
		t.Fatalf("transcript = %s", tx)
	}
	if kids := e.sessionDetail(t, pid, main.ID).Children; len(kids) != len(agents) {
		t.Fatalf("children of the main session = %+v", kids)
	}

	// Continue the finished agent.
	var out sessionOne
	e.into(t, "POST", "/v1/projects/"+pid+"/sessions/"+explorer.ID+"/messages", map[string]any{"text": "[ctx] one more thing"}, http.StatusAccepted, &out)
	if out.Outcome != "continued" {
		t.Fatalf("outcome = %q", out.Outcome)
	}
	e.waitSession(t, pid, explorer.ID, func(s orchestrator.SessionView) bool {
		return s.State == "idle" && strings.Contains(e.sessionTexts(t, pid, explorer.ID), "assistant: ctx:")
	})
	if tx := e.sessionTexts(t, pid, explorer.ID); !strings.Contains(tx, "[ctx] one more thing") || !strings.Contains(tx, "The user asked") {
		t.Fatalf("the continued agent saw its own earlier conversation: %s", tx)
	}

	// With report_to_parent the answer reaches the orchestrator at its next turn, as a note, not interrupting anything.
	engineer := agents["Implement the change"]
	e.into(t, "POST", "/v1/projects/"+pid+"/sessions/"+engineer.ID+"/messages", map[string]any{"text": "[ctx] tell the orchestrator", "report_to_parent": true}, http.StatusAccepted, nil)
	e.waitSession(t, pid, engineer.ID, func(s orchestrator.SessionView) bool {
		return s.State == "idle" && strings.Contains(e.sessionTexts(t, pid, engineer.ID), "assistant: ctx:")
	})
	db, err := e.store.Get(context.Background(), pid)
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(10 * time.Second)
	for {
		dump, _ := db.DumpForTest(context.Background(), "session_reports")
		if strings.Contains(dump, "tell the orchestrator") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the report was never queued")
		}
		time.Sleep(20 * time.Millisecond)
	}
	e.into(t, "POST", "/v1/projects/"+pid+"/messages", map[string]string{"text": "[ctx] what came back"}, http.StatusAccepted, nil)
	collectUntilTurnFinished(t, stream)
	if a := e.lastAnswer(t, pid, main.ID); !strings.Contains(a, "Results the user collected") {
		t.Fatalf("the next turn must see the sub-agent's answer: %q", a)
	}
	if tx := e.sessionTexts(t, pid, main.ID); !strings.Contains(tx, "Results the user collected") {
		t.Fatalf("the note is in the main transcript: %s", tx)
	}

	// Refusals.
	e.wantError(t, "POST", "/v1/projects/"+pid+"/sessions/"+main.ID+"/messages", map[string]any{"text": "x"}, http.StatusConflict, "not_agent_session")
	e.wantError(t, "POST", "/v1/projects/"+pid+"/sessions/"+explorer.ID+"/messages", map[string]any{"text": "  "}, http.StatusBadRequest, "invalid_request")
	e.wantError(t, "POST", "/v1/projects/"+pid+"/sessions/"+explorer.ID+"/resume", nil, http.StatusConflict, "not_main_session")
	e.wantError(t, "POST", "/v1/projects/"+pid+"/sessions/"+explorer.ID+"/stop", nil, http.StatusConflict, "not_running")
	e.wantError(t, "POST", "/v1/projects/"+pid+"/sessions/ses_nope/messages", map[string]any{"text": "x"}, http.StatusNotFound, "not_found")

	// Delete an agent session: its transcript goes, the main session no longer counts it.
	e.into(t, "DELETE", "/v1/projects/"+pid+"/sessions/"+explorer.ID, nil, http.StatusNoContent, nil)
	if m := e.sessionDetail(t, pid, main.ID).Session; m.Children != len(agents)-1 {
		t.Fatalf("children after delete = %d", m.Children)
	}
}

// While a built-in sub-agent runs, a message is steered into it at its next tool boundary and Stop ends only that agent.
func TestRunningAgentSessionsSteerAndStop(t *testing.T) {
	gate := make(chan struct{})
	e := newEnv(t, gate)
	pid, _ := e.v7Project(t, "full")
	stream := e.subscribe(t, pid)
	e.into(t, "POST", "/v1/projects/"+pid+"/messages", map[string]string{"text": "build it"}, http.StatusAccepted, nil)
	gate <- struct{}{} // the orchestrator's first request: it delegates; the sub-agents' requests then wait
	var explorer, engineer orchestrator.SessionView
	deadline := time.Now().Add(20 * time.Second)
	for explorer.ID == "" || engineer.ID == "" {
		a := e.agentSessions(t, pid)
		explorer, engineer = a["Map the repository layout"], a["Implement the change"]
		if time.Now().After(deadline) {
			t.Fatalf("sub-agent sessions = %+v", a)
		}
		time.Sleep(20 * time.Millisecond)
	}
	if explorer.State != "working" {
		t.Fatalf("a spawned agent works: %+v", explorer)
	}
	// Steer: retry until the run is registered.
	steered := false
	for i := 0; i < 200 && !steered; i++ {
		status, raw := e.do(t, "POST", "/v1/projects/"+pid+"/sessions/"+engineer.ID+"/messages", map[string]any{"text": "also mention pelicans"})
		switch status {
		case http.StatusAccepted:
			if steered = strings.Contains(string(raw), `"outcome":"steered"`); !steered {
				t.Fatalf("outcome = %s", raw)
			}
		case http.StatusConflict:
			time.Sleep(20 * time.Millisecond)
		default:
			t.Fatalf("steer = %d %s", status, raw)
		}
	}
	if !steered {
		t.Fatal("the message was never accepted")
	}
	stopped := false
	for i := 0; i < 200 && !stopped; i++ {
		status, _ := e.do(t, "POST", "/v1/projects/"+pid+"/sessions/"+explorer.ID+"/stop", nil)
		if stopped = status == http.StatusOK; !stopped {
			time.Sleep(20 * time.Millisecond)
		}
	}
	if !stopped {
		t.Fatal("stop was never accepted")
	}
	e.waitSession(t, pid, explorer.ID, func(s orchestrator.SessionView) bool { return s.State == "stopped" })
	feed, fed := make(chan struct{}), make(chan struct{})
	t.Cleanup(func() {
		close(feed)
		<-fed
		close(gate)
	})
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
	collectUntilTurnFinished(t, stream)
	if tx := e.sessionTexts(t, pid, engineer.ID); !strings.Contains(tx, "user: also mention pelicans") {
		t.Fatalf("the steered text is in the sub-agent's transcript: %s", tx)
	}
	if s := e.sessionDetail(t, pid, engineer.ID).Session; s.State != "idle" {
		t.Fatalf("the steered agent finished: %+v", s)
	}
	if s := e.sessionDetail(t, pid, explorer.ID).Session; s.State != "stopped" {
		t.Fatalf("the stopped agent stays stopped: %+v", s)
	}
}

// --- ACP orchestrator: resume uses session/load when the agent has it, else a new session with a recap ---

func (e *acpEnv) newSession(t *testing.T, p projectJSON) orchestrator.SessionView {
	t.Helper()
	var out sessionOne
	e.into(t, "POST", "/v1/projects/"+p.ID+"/sessions", nil, http.StatusCreated, &out)
	return out.Session
}

func (e *acpEnv) sessions(t *testing.T, p projectJSON) []orchestrator.SessionView {
	t.Helper()
	var l sessionList
	e.into(t, "GET", "/v1/projects/"+p.ID+"/sessions", nil, http.StatusOK, &l)
	return l.Sessions
}

func TestACPOrchestratorResumeLoadsTheAgentsSession(t *testing.T) {
	e := newACPEnv(t, map[string]string{fakeacp.EnvLoadSession: "1"}, nil)
	p := e.acpProject(t)
	e.ask(t, p, "[echo] one")
	s1 := parseIdentity(t, e.lastText(t, p))
	first := current(t, e.sessions(t, p))
	e.newSession(t, p)
	e.ask(t, p, "[echo] two")
	s2 := parseIdentity(t, e.lastText(t, p))
	if s2.session == s1.session || s2.loaded {
		t.Fatalf("a new session is a new agent session: %+v %+v", s1, s2)
	}
	e.into(t, "POST", "/v1/projects/"+p.ID+"/sessions/"+first.ID+"/resume", nil, http.StatusOK, nil)
	e.ask(t, p, "[echo] three")
	text := e.lastText(t, p)
	s3 := parseIdentity(t, text)
	if !s3.loaded || s3.session != s1.session {
		t.Fatalf("resume must session/load the agent's session %s: %+v", s1.session, s3)
	}
	if strings.Contains(text, "Earlier in this conversation") || !strings.Contains(text, "prompt<<[echo] three>>") {
		t.Fatalf("a loaded session needs no recap: %q", text)
	}
}

func TestACPOrchestratorResumeFallsBackToARecap(t *testing.T) {
	for name, flags := range map[string]map[string]string{
		"no session/load":     nil,
		"session/load failed": {fakeacp.EnvLoadSession: "1", fakeacp.EnvLoadFail: "1"},
	} {
		t.Run(name, func(t *testing.T) {
			e := newACPEnv(t, flags, nil)
			p := e.acpProject(t)
			e.ask(t, p, "[echo] remember the word pelican")
			s1 := parseIdentity(t, e.lastText(t, p))
			first := current(t, e.sessions(t, p))
			e.newSession(t, p)
			e.ask(t, p, "[echo] unrelated walrus")
			e.into(t, "POST", "/v1/projects/"+p.ID+"/sessions/"+first.ID+"/resume", nil, http.StatusOK, nil)
			e.ask(t, p, "[echo] what did I say")
			text := e.lastText(t, p)
			s3 := parseIdentity(t, text)
			if s3.loaded || s3.session == s1.session {
				t.Fatalf("a new agent session was expected: %+v", s3)
			}
			recap := text[strings.Index(text, "Earlier in this conversation"):]
			if i := strings.Index(recap, "Previous session:"); i >= 0 {
				recap = recap[:i] // the pointer names the session just left; its text is not part of the recap
			}
			if !strings.Contains(recap, "user: [echo] remember the word pelican") || strings.Contains(recap, "walrus") {
				t.Fatalf("the recap is built from the resumed session only:\n%s", text)
			}
		})
	}
}
