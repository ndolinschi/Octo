package bridge_test

import (
	"net/http"
	"strings"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/fakeacp"
)

type slashJSON struct {
	Octo []struct {
		Name      string `json:"name"`
		Args      string `json:"args"`
		Available bool   `json:"available"`
		Reason    string `json:"reason"`
		Endpoint  string `json:"endpoint"`
	} `json:"octo"`
	Agent *struct {
		ID       string `json:"id"`
		Label    string `json:"label"`
		Pending  bool   `json:"pending"`
		Commands []struct {
			Name        string `json:"name"`
			Description string `json:"description"`
			InputHint   string `json:"input_hint"`
		} `json:"commands"`
	} `json:"agent"`
}

func (s slashJSON) octo(t *testing.T, name string) (avail bool, reason string) {
	t.Helper()
	for _, c := range s.Octo {
		if c.Name == name {
			return c.Available, c.Reason
		}
	}
	t.Fatalf("no Octo command %q in %+v", name, s.Octo)
	return
}

func (e *acpEnv) slash(t *testing.T, p projectJSON) slashJSON {
	t.Helper()
	var s slashJSON
	e.into(t, "GET", "/v1/projects/"+p.ID+"/slash-commands", nil, http.StatusOK, &s)
	return s
}

type cmdMessages struct {
	Messages []struct {
		ID      int64  `json:"id"`
		Role    string `json:"role"`
		Command string `json:"command"`
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
	} `json:"messages"`
	Conversations []struct {
		ConversationID string `json:"conversation_id"`
		UptoMessageID  int64  `json:"upto_message_id"`
		Label          string `json:"label"`
		Title          string `json:"title"`
		Summary        string `json:"summary"`
		SummarySource  string `json:"summary_source"`
	} `json:"conversations"`
}

func (e *acpEnv) transcript(t *testing.T, p projectJSON) cmdMessages {
	t.Helper()
	var m cmdMessages
	e.into(t, "GET", "/v1/projects/"+p.ID+"/agents/"+p.OrchestratorAgentID+"/messages", nil, http.StatusOK, &m)
	return m
}

func TestSlashCommandsOfAnACPOrchestrator(t *testing.T) {
	e := newACPEnv(t, map[string]string{fakeacp.EnvCommands: "web|Search the web|query;init|Set up the project"}, nil)
	p := e.acpProject(t)

	// Before the first session the agent list is empty and pending; the harness starts no session to read it.
	s := e.slash(t, p)
	if s.Agent == nil || s.Agent.ID != "scripted" || s.Agent.Label != "Scripted" || !s.Agent.Pending || len(s.Agent.Commands) != 0 {
		t.Fatalf("before the first session: %+v", s.Agent)
	}
	if ok, reason := s.octo(t, "compact"); ok || reason == "" {
		t.Fatalf("compact must be unavailable with a reason: %v %q", ok, reason)
	}
	for _, name := range []string{"clear", "mode", "model", "rewind", "export", "review", "context", "memory", "settings", "remember", "help"} {
		if ok, _ := s.octo(t, name); !ok {
			t.Errorf("/%s is available", name)
		}
	}
	for _, c := range s.Octo {
		if c.Endpoint == "" {
			t.Errorf("/%s names no endpoint", c.Name)
		}
	}

	first := e.ask(t, p, "[echo] first")
	if n := count(first.events, "slash_commands.updated"); n < 1 {
		t.Fatalf("slash_commands.updated events = %d", n)
	}
	s = e.slash(t, p)
	if s.Agent.Pending || len(s.Agent.Commands) != 2 || s.Agent.Commands[0].Name != "web" || s.Agent.Commands[0].InputHint != "query" ||
		s.Agent.Commands[1].Name != "init" || s.Agent.Commands[1].Description != "Set up the project" {
		t.Fatalf("after the first session: %+v", s.Agent)
	}
	if ok, reason := s.octo(t, "compact"); ok || !strings.Contains(reason, "does not advertise") {
		t.Fatalf("compact = %v %q", ok, reason)
	}
	e.wantError(t, "POST", "/v1/projects/"+p.ID+"/compact", nil, http.StatusConflict, "compact_unsupported")

	// An advertised command passes through as the whole prompt and is recorded on the message.
	e.ask(t, p, "/web rust ownership")
	if txt := e.lastText(t, p); !strings.Contains(txt, "command<</web rust ownership>>") {
		t.Fatalf("the agent got %q", txt)
	}
	// An unknown /text is ordinary text.
	e.ask(t, p, "/nonsense x")
	m := e.transcript(t, p)
	var commands []string
	for _, msg := range m.Messages {
		if msg.Role == "user" && len(msg.Content) > 0 && msg.Content[0].Type == "text" {
			commands = append(commands, msg.Command+":"+msg.Content[0].Text)
		}
	}
	want := []string{":[echo] first", "web:/web rust ownership", ":/nonsense x"}
	if strings.Join(commands, "|") != strings.Join(want, "|") {
		t.Fatalf("user messages = %q, want %q", commands, want)
	}
	// An Octo command is refused with the endpoint to call, whatever the orchestrator.
	for text, endpoint := range map[string]string{
		"/compact": "/compact", "/clear now": "/clear", "/mode plan": "PATCH", "/remember a thing": "/facts", "/export": "/export",
	} {
		var resp struct {
			Error struct{ Code, Message, Details string } `json:"error"`
		}
		e.into(t, "POST", "/v1/projects/"+p.ID+"/messages", map[string]string{"text": text}, http.StatusBadRequest, &resp)
		if resp.Error.Code != "octo_command" || !strings.Contains(resp.Error.Details, endpoint) {
			t.Errorf("%q: error = %+v", text, resp.Error)
		}
	}
	if got := e.transcript(t, p); len(got.Messages) != len(m.Messages) {
		t.Fatalf("a refused command stored a message: %d -> %d", len(m.Messages), len(got.Messages))
	}

	// The agent changes its list mid-session: the event fires and /compact becomes available, which sends /compact to it.
	upd := e.ask(t, p, "[set-commands:compact|Compact the context;web]")
	if count(upd.events, "slash_commands.updated") != 1 {
		t.Fatalf("update events = %d", count(upd.events, "slash_commands.updated"))
	}
	s = e.slash(t, p)
	if len(s.Agent.Commands) != 2 || s.Agent.Commands[0].Name != "compact" {
		t.Fatalf("updated list: %+v", s.Agent.Commands)
	}
	if ok, _ := s.octo(t, "compact"); !ok {
		t.Fatal("compact is available once the agent advertises it")
	}
	ch := e.subscribe(t, p.ID)
	var res struct {
		Sent    bool `json:"sent_to_agent"`
		Message struct {
			Command string `json:"command"`
		} `json:"message"`
	}
	e.into(t, "POST", "/v1/projects/"+p.ID+"/compact", nil, http.StatusAccepted, &res)
	if !res.Sent || res.Message.Command != "compact" {
		t.Fatalf("compact = %+v", res)
	}
	finishTurn(t, ch)
	if txt := e.lastText(t, p); !strings.Contains(txt, "command<</compact>>") {
		t.Fatalf("the agent got %q", txt)
	}
}

func TestClearOfAnACPOrchestratorAsksTheAgentForASummary(t *testing.T) {
	e := newACPEnv(t, map[string]string{fakeacp.EnvCommands: "web|Search the web"}, nil)
	p := e.acpProject(t)
	e.ask(t, p, "[echo] first")
	first := parseIdentity(t, e.lastText(t, p))
	e.ask(t, p, "[echo] second")
	before := e.transcript(t, p)

	ch := e.subscribe(t, p.ID)
	var res struct {
		ConversationID string `json:"conversation_id"`
		Title          string `json:"title"`
		Summary        string `json:"summary"`
		SummarySource  string `json:"summary_source"`
	}
	e.into(t, "POST", "/v1/projects/"+p.ID+"/clear", nil, http.StatusOK, &res)
	if res.ConversationID == "" || res.SummarySource != "agent" || !strings.Contains(res.Summary, "Agent summary") || res.Title != "[echo] first" {
		t.Fatalf("clear = %+v", res)
	}
	evs := collectUntil(t, ch, "slash_commands.updated")
	if count(evs, "conversation.cleared") != 1 || indexOf(evs, "context.updated") < 0 {
		t.Fatalf("events = %+v", evs)
	}
	// The summary prompt is not a user turn, and nothing is deleted.
	after := e.transcript(t, p)
	if len(after.Messages) != len(before.Messages) {
		t.Fatalf("messages %d -> %d", len(before.Messages), len(after.Messages))
	}
	if len(after.Conversations) != 1 || after.Conversations[0].ConversationID != res.ConversationID ||
		after.Conversations[0].Label != "New session · earlier: [echo] first" || after.Conversations[0].SummarySource != "agent" ||
		!strings.Contains(after.Conversations[0].Summary, "Agent summary") || after.Conversations[0].UptoMessageID != before.Messages[len(before.Messages)-1].ID {
		t.Fatalf("conversations = %+v", after.Conversations)
	}
	// The agent's commands are pending again until its new session starts.
	if s := e.slash(t, p); !s.Agent.Pending {
		t.Fatalf("after clear: %+v", s.Agent)
	}
	// The next session is new and starts from the carry-over, not from the old exchange.
	e.ask(t, p, "[echo] third")
	txt := e.lastText(t, p)
	second := parseIdentity(t, txt)
	if second.session == first.session || second.pid == first.pid {
		t.Fatalf("a new process and session: %+v vs %+v", first, second)
	}
	// Memory M4: the recap also carries the three-line pointer to the previous session, which names it by its title (the first
	// request); the exchanges themselves are not in the prompt.
	if !strings.Contains(txt, "Carried over from the previous session") || !strings.Contains(txt, "Agent summary") ||
		!strings.Contains(txt, "Previous session: \"[echo] first\"") ||
		strings.Contains(strings.Replace(txt, "Previous session: \"[echo] first\"", "", 1), "[echo] first") || strings.Contains(txt, "[echo] second") {
		t.Fatalf("the new session's prompt = %q", txt)
	}
	// The old request is still found, and the export shows the boundary.
	var hits struct {
		Results []struct{ Snippet string } `json:"results"`
	}
	e.into(t, "GET", "/v1/search?q=first", nil, http.StatusOK, &hits)
	if len(hits.Results) == 0 {
		t.Fatal("an old request is found by search after /clear")
	}
	status, md := e.do(t, "GET", "/v1/projects/"+p.ID+"/export?format=md", nil)
	if status != http.StatusOK || !strings.Contains(string(md), "New session · earlier: [echo] first") || !strings.Contains(string(md), "[echo] first") {
		t.Fatalf("export: %d %s", status, md)
	}
	// A clear during a turn is refused.
	e.into(t, "POST", "/v1/projects/"+p.ID+"/messages", map[string]string{"text": "[hang]"}, http.StatusAccepted, nil)
	e.wantError(t, "POST", "/v1/projects/"+p.ID+"/clear", nil, http.StatusConflict, "turn_in_progress")
	e.into(t, "POST", "/v1/projects/"+p.ID+"/cancel", nil, http.StatusAccepted, nil)
	e.waitIdle(t, p.ID)
}

func TestClearOfAnACPOrchestratorFallsBackToTheStoredSummary(t *testing.T) {
	e := newACPEnv(t, map[string]string{fakeacp.EnvSummary: "fail"}, nil)
	p := e.acpProject(t)
	e.ask(t, p, "[echo] first")
	e.ask(t, p, "[echo] second")
	var res struct {
		Summary       string `json:"summary"`
		SummarySource string `json:"summary_source"`
	}
	e.into(t, "POST", "/v1/projects/"+p.ID+"/clear", nil, http.StatusOK, &res)
	if res.SummarySource != "stored" || !strings.Contains(res.Summary, "Last requests:") || !strings.Contains(res.Summary, "[echo] second ->") {
		t.Fatalf("clear = %+v", res)
	}
	e.ask(t, p, "[echo] third")
	if txt := e.lastText(t, p); !strings.Contains(txt, "Carried over from the previous session") || !strings.Contains(txt, "Last requests:") {
		t.Fatalf("the new session's prompt = %q", txt)
	}
	// With no live session (a project that never ran) nothing is asked: stored, empty.
	p2 := e.acpProject(t)
	var empty struct {
		SummarySource string `json:"summary_source"`
		Summary       string `json:"summary"`
	}
	e.into(t, "POST", "/v1/projects/"+p2.ID+"/clear", nil, http.StatusOK, &empty)
	if empty.SummarySource != "stored" || empty.Summary != "" {
		t.Fatalf("empty clear = %+v", empty)
	}
}

func TestSlashCommandsAndClearOfTheBuiltInLoop(t *testing.T) {
	e := newEnv(t, nil)
	pid, _ := e.v7Project(t, "full")
	var s slashJSON
	e.into(t, "GET", "/v1/projects/"+pid+"/slash-commands", nil, http.StatusOK, &s)
	if s.Agent != nil || len(s.Octo) < 10 {
		t.Fatalf("built-in loop: only the Octo group: %+v", s)
	}
	if ok, _ := s.octo(t, "compact"); !ok {
		t.Fatal("compact is available")
	}
	e.into(t, "PATCH", "/v1/projects/"+pid, map[string]any{"memory": map[string]string{"context": "window"}}, http.StatusOK, nil)
	e.into(t, "GET", "/v1/projects/"+pid+"/slash-commands", nil, http.StatusOK, &s)
	if ok, reason := s.octo(t, "compact"); ok || !strings.Contains(reason, "window") {
		t.Fatalf("compact in window mode = %v %q", ok, reason)
	}
	e.into(t, "PATCH", "/v1/projects/"+pid, map[string]any{"memory": map[string]string{"context": "full"}}, http.StatusOK, nil)

	// A built-in loop has no agent commands: "/foo" is plain text; an Octo command is refused.
	e.wantError(t, "POST", "/v1/projects/"+pid+"/messages", map[string]string{"text": "/compact"}, http.StatusBadRequest, "octo_command")
	e.runTurn(t, pid, "/foo quick bar")
	e.runTurn(t, pid, "quick second")
	e.waitIdle(t, pid)

	var res struct {
		ConversationID string `json:"conversation_id"`
		SummarySource  string `json:"summary_source"`
		Summary        string `json:"summary"`
	}
	e.into(t, "POST", "/v1/projects/"+pid+"/clear", nil, http.StatusOK, &res)
	if res.ConversationID == "" || res.SummarySource != "model" || res.Summary == "" {
		t.Fatalf("clear = %+v", res)
	}
	var p struct {
		OrchestratorAgentID string `json:"orchestrator_agent_id"`
	}
	e.into(t, "GET", "/v1/projects/"+pid, nil, http.StatusOK, &p)
	var m cmdMessages
	e.into(t, "GET", "/v1/projects/"+pid+"/agents/"+p.OrchestratorAgentID+"/messages", nil, http.StatusOK, &m)
	if len(m.Conversations) != 1 || len(m.Messages) < 4 {
		t.Fatalf("transcript = %d messages, conversations %+v", len(m.Messages), m.Conversations)
	}
	// The context report starts over: no compaction time, the history is the carry-over only.
	var ctxRep struct {
		CompactedAt string `json:"compacted_at"`
	}
	e.into(t, "GET", "/v1/projects/"+pid+"/context", nil, http.StatusOK, &ctxRep)
	if ctxRep.CompactedAt != "" {
		t.Fatalf("context = %+v", ctxRep)
	}
	e.runTurn(t, pid, "quick third")
	// 409 while a turn runs.
	e.into(t, "POST", "/v1/projects/"+pid+"/messages", map[string]string{"text": "Go [bash:sleep 2]"}, http.StatusAccepted, nil)
	e.wantError(t, "POST", "/v1/projects/"+pid+"/clear", nil, http.StatusConflict, "turn_in_progress")
	e.into(t, "POST", "/v1/projects/"+pid+"/cancel", nil, http.StatusAccepted, nil)
	e.waitIdle(t, pid)
	e.wantError(t, "POST", "/v1/projects/prj_nope/clear", nil, http.StatusNotFound, "not_found")
}

func TestFactsEndpointsRememberAndUndo(t *testing.T) {
	e := newEnv(t, nil)
	pid, _ := e.v7Project(t, "full")
	var got struct {
		TaskID string `json:"task_id"`
		Fact   struct {
			ID           string `json:"id"`
			Text         string `json:"text"`
			Kind         string `json:"kind"`
			RememberedBy string `json:"remembered_by"`
			Date         string `json:"date"`
		} `json:"fact"`
	}
	e.into(t, "POST", "/v1/projects/"+pid+"/facts", map[string]string{"text": "deploys go through make ship"}, http.StatusCreated, &got)
	if got.TaskID == "" || got.Fact.ID == "" || got.Fact.Kind != "fact" || got.Fact.RememberedBy != "user" || got.Fact.Date == "" {
		t.Fatalf("fact = %+v", got)
	}
	e.wantError(t, "POST", "/v1/projects/"+pid+"/facts", map[string]string{"text": ""}, http.StatusBadRequest, "invalid_request")
	e.wantError(t, "POST", "/v1/projects/"+pid+"/facts", map[string]string{"text": "x", "kind": "gossip"}, http.StatusBadRequest, "invalid_request")
	var hits struct {
		Hits []struct{ Kind string } `json:"hits"`
	}
	e.into(t, "GET", "/v1/projects/"+pid+"/memory/search?q=ship&in=facts", nil, http.StatusOK, &hits)
	if len(hits.Hits) != 1 {
		t.Fatalf("search = %+v", hits)
	}
	status, _ := e.do(t, "DELETE", "/v1/projects/"+pid+"/facts/"+got.TaskID+"/"+got.Fact.ID, nil)
	if status != http.StatusNoContent {
		t.Fatalf("delete = %d", status)
	}
	e.wantError(t, "DELETE", "/v1/projects/"+pid+"/facts/"+got.TaskID+"/"+got.Fact.ID, nil, http.StatusNotFound, "not_found")
	e.into(t, "GET", "/v1/projects/"+pid+"/memory/search?q=ship&in=facts", nil, http.StatusOK, &hits)
	if len(hits.Hits) != 0 {
		t.Fatalf("the undone fact is still found: %+v", hits)
	}
}
