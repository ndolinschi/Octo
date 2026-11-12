package bridge_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/anthropicclient"
	"github.com/ndolinschi/Octo/apps/harness/internal/bridge"
	"github.com/ndolinschi/Octo/apps/harness/internal/config"
	"github.com/ndolinschi/Octo/apps/harness/internal/events"
	"github.com/ndolinschi/Octo/apps/harness/internal/fakeacp"
	"github.com/ndolinschi/Octo/apps/harness/internal/mcp"
	"github.com/ndolinschi/Octo/apps/harness/internal/mockllm"
	"github.com/ndolinschi/Octo/apps/harness/internal/orchestrator"
	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
	"github.com/ndolinschi/Octo/apps/harness/internal/project"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

// acpEnv is the full stack with the scripted ACP agent as plugin agent
// "scripted", the MCP server mounted on the bridge, and one folder to work in.
type acpEnv struct {
	*env
	orch *orchestrator.Orchestrator
	dir  string
}

// newACPEnv starts the stack; flags are extra environment switches of the
// scripted agent (fakeacp.Env*), tune adjusts the orchestrator options.
func newACPEnv(t *testing.T, flags map[string]string, tune func(*orchestrator.Options), bridgeOpts ...bridge.Option) *acpEnv {
	t.Helper()
	agentEnv := map[string]string{fakeacp.EnvChild: "1", "GORACE": "atexit_sleep_ms=0", fakeacp.EnvUniqueSessions: "1"}
	for k, v := range flags {
		agentEnv[k] = v
	}
	data := t.TempDir()
	writeManifest(t, data, "scripted", map[string]any{
		"name": "scripted", "version": "1",
		"agents": []map[string]any{{"id": "scripted", "label": "Scripted", "command": os.Args[0], "env": agentEnv}},
	})
	reg := plugins.Load(context.Background(), data, nil, nil)

	llmSrv := httptest.NewServer(mockllm.New(0))
	t.Cleanup(llmSrv.Close)
	store, err := projectstore.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	hub := events.NewHub()
	notes := project.NewNotes(store, hub)
	opts := orchestrator.Options{
		Client: anthropicclient.New("k", llmSrv.URL, ""), MaxTurns: 12, Stream: true, Agents: reg.Agents(),
		MCPRelay: []string{os.Args[0], "mcp-relay"},
	}
	if tune != nil {
		tune(&opts)
	}
	orch := orchestrator.New(store, hub, notes, opts)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = orch.Shutdown(ctx)
	})
	svc := project.NewService(store, hub, orch, project.Defaults{Models: config.DefaultModels(), MaxDepth: config.DefaultMaxDepth},
		project.WithACPAgents(reg))
	srv := httptest.NewServer(bridge.New(svc, notes, project.NewFiles(store, hub),
		append([]bridge.Option{bridge.WithMCP(orch.MCPHandler(bridge.Version)), bridge.WithPlugins(reg)}, bridgeOpts...)...))
	t.Cleanup(srv.Close)
	orch.SetBridgeURL(srv.URL)

	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("# Scripted demo\n\nHello.\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return &acpEnv{env: &env{url: srv.URL}, orch: orch, dir: dir}
}

type projectJSON struct {
	ID                  string `json:"id"`
	OrchestratorAgentID string `json:"orchestrator_agent_id"`
}

func (e *acpEnv) project(t *testing.T, models map[string]string) projectJSON {
	t.Helper()
	var p projectJSON
	e.into(t, "POST", "/v1/projects", map[string]any{
		"name": "acp", "folders": []map[string]string{{"path": e.dir}}, "models": models,
	}, http.StatusCreated, &p)
	return p
}

func (e *acpEnv) acpProject(t *testing.T) projectJSON {
	return e.project(t, map[string]string{"orchestrator": "acp:scripted"})
}

type turn struct {
	events []sseEvent
	status string
	errMsg any
}

// ask posts a user request and waits for the turn to finish.
func (e *acpEnv) ask(t *testing.T, p projectJSON, text string) turn {
	t.Helper()
	ch := e.subscribe(t, p.ID)
	e.into(t, "POST", "/v1/projects/"+p.ID+"/messages", map[string]string{"text": text}, http.StatusAccepted, nil)
	return finishTurn(t, ch)
}

func finishTurn(t *testing.T, ch <-chan sseEvent) turn {
	t.Helper()
	evs := collectUntilTurnFinished(t, ch)
	last := evs[len(evs)-1]
	return turn{events: evs, status: fmt.Sprint(last.Data["status"]), errMsg: last.Data["error"]}
}

type apiMessage struct {
	ID      int64  `json:"id"`
	Role    string `json:"role"`
	Content []struct {
		Type      string          `json:"type"`
		Text      string          `json:"text"`
		ID        string          `json:"id"`
		Name      string          `json:"name"`
		Input     json.RawMessage `json:"input"`
		ToolUseID string          `json:"tool_use_id"`
		Content   string          `json:"content"`
	} `json:"content"`
}

func (e *acpEnv) messages(t *testing.T, p projectJSON, agentID string) []apiMessage {
	t.Helper()
	var body struct {
		Messages []apiMessage `json:"messages"`
	}
	e.into(t, "GET", "/v1/projects/"+p.ID+"/agents/"+agentID+"/messages", nil, http.StatusOK, &body)
	return body.Messages
}

// lastText is all the assistant text of the orchestrator's latest turn, in order.
func (e *acpEnv) lastText(t *testing.T, p projectJSON) string {
	t.Helper()
	msgs := e.messages(t, p, p.OrchestratorAgentID)
	start := 0
	for i, m := range msgs {
		if m.Role == "user" && len(m.Content) > 0 && m.Content[0].Type == "text" {
			start = i
		}
	}
	var b strings.Builder
	for _, m := range msgs[start:] {
		if m.Role != "assistant" {
			continue
		}
		for _, c := range m.Content {
			if c.Type == "text" {
				b.WriteString(c.Text)
			}
		}
	}
	if b.Len() == 0 {
		t.Fatal("no assistant text in the orchestrator's latest turn")
	}
	return b.String()
}

type apiAgentFull struct {
	ID             string  `json:"id"`
	ParentID       *string `json:"parent_id"`
	Title          string  `json:"title"`
	Model          string  `json:"model"`
	Status         string  `json:"status"`
	Result         *string `json:"result"`
	Error          *string `json:"error"`
	SpawnToolUseID *string `json:"spawn_tool_use_id"`
	ContextUsed    *int64  `json:"context_used"`
	RouteReason    *string `json:"route_reason"`
	RouteChoice    *string `json:"route_choice"`
	RouteBand      *string `json:"route_band"`
}

func (e *acpEnv) agents(t *testing.T, p projectJSON) []apiAgentFull {
	t.Helper()
	var body struct {
		Agents []apiAgentFull `json:"agents"`
	}
	e.into(t, "GET", "/v1/projects/"+p.ID+"/agents", nil, http.StatusOK, &body)
	return body.Agents
}

func (e *acpEnv) agent(t *testing.T, p projectJSON, id string) apiAgentFull {
	t.Helper()
	for _, a := range e.agents(t, p) {
		if a.ID == id {
			return a
		}
	}
	t.Fatalf("agent %s not found", id)
	return apiAgentFull{}
}

var (
	pidRe     = regexp.MustCompile(`pid=(\d+) session=(\S+) loaded=(true|false)`)
	relayRe   = regexp.MustCompile(`relay=(\d+)`)
	mcpInfoRe = regexp.MustCompile(`transport=(\w+) url=(\S+) token=(\S+)`)
)

type identity struct {
	pid, relay int
	session    string
	loaded     bool
}

func parseIdentity(t *testing.T, text string) identity {
	t.Helper()
	m := pidRe.FindStringSubmatch(text)
	if m == nil {
		t.Fatalf("no pid/session in %q", text)
	}
	pid, _ := strconv.Atoi(m[1])
	id := identity{pid: pid, session: m[2], loaded: m[3] == "true"}
	if r := relayRe.FindStringSubmatch(text); r != nil {
		id.relay, _ = strconv.Atoi(r[1])
	}
	return id
}

// processGone reports whether a pid no longer runs (a zombie awaiting its
// parent's wait counts as gone: it holds no resources and runs nothing).
func processGone(pid int) bool {
	raw, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return true
	}
	if i := bytes.LastIndexByte(raw, ')'); i >= 0 && i+2 < len(raw) {
		return raw[i+2] == 'Z'
	}
	return false
}

func waitGone(t *testing.T, what string, pid int) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !processGone(pid) {
		if time.Now().After(deadline) {
			t.Fatalf("%s (pid %d) is still running", what, pid)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func alive(pid int) bool { return !processGone(pid) && syscall.Kill(pid, 0) == nil }

// --- A: streamed text, MCP spawn_agent, a note, the transcript -------------

func checkMCPRun(t *testing.T, e *acpEnv, wantTransport string) identity {
	t.Helper()
	p := e.acpProject(t)
	tr := e.ask(t, p, "[mcp-spawn] look around")
	if tr.status != "completed" || tr.errMsg != nil {
		t.Fatalf("turn = %s, error %v", tr.status, tr.errMsg)
	}
	if count(tr.events, events.MessageDelta) < 3 {
		t.Errorf("want streamed orchestrator text, got %d message.delta events", count(tr.events, events.MessageDelta))
	}
	text := e.lastText(t, p)
	id := parseIdentity(t, text)
	if !strings.Contains(text, "mcp="+wantTransport) {
		t.Errorf("final text = %q, want MCP transport %s", text, wantTransport)
	}
	for _, tool := range []string{"spawn_agent", "save_note", "delete_note", "list_dir", "read_note", "search_notes", "write_note"} {
		if !strings.Contains(text, tool) {
			t.Errorf("tool list in %q lacks %s", text, tool)
		}
	}
	if strings.Contains(text, "read_file") {
		t.Errorf("read_file is covered by fs/read_text_file and must not be exposed over MCP: %q", text)
	}
	if strings.Contains(text, "Permission was not granted") {
		t.Errorf("permission was refused: %q", text)
	}

	// A real sub-agent whose report came back as the tool result.
	var sub *apiAgentFull
	for _, a := range e.agents(t, p) {
		if a.ParentID != nil {
			a := a
			sub = &a
		}
	}
	if sub == nil {
		t.Fatalf("no sub-agent in /agents: %+v", e.agents(t, p))
	}
	if sub.Status != "completed" || sub.Result == nil || !strings.Contains(*sub.Result, "Summary: README.md") || sub.Model != "acp:scripted" {
		t.Fatalf("sub-agent = %+v", sub)
	}
	if !strings.Contains(text, "Sub-agent report: "+*sub.Result) {
		t.Errorf("the ACP agent did not get the report as the tool result: %q", text)
	}
	if sub.SpawnToolUseID == nil || *sub.SpawnToolUseID != "mcp-spawn-1" {
		t.Errorf("spawn_tool_use_id = %v, want the ACP tool call id mcp-spawn-1", sub.SpawnToolUseID)
	}

	// The note written through MCP is in the notes API.
	var notes struct {
		Notes []struct{ ID, Title, Content, Author string } `json:"notes"`
	}
	e.into(t, "GET", "/v1/projects/"+p.ID+"/notes", nil, http.StatusOK, &notes)
	if len(notes.Notes) != 1 || notes.Notes[0].Title != "mcp-note" || notes.Notes[0].Content != "" {
		t.Errorf("notes = %+v (a list carries no body)", notes.Notes)
	} else {
		var got struct{ Content string }
		e.into(t, "GET", "/v1/projects/"+p.ID+"/notes/"+notes.Notes[0].ID, nil, http.StatusOK, &got)
		if got.Content != "written via MCP" {
			t.Errorf("note body = %q", got.Content)
		}
	}

	// The orchestrator agent reads acp:<id>, shows the usage the agent reported.
	orch := e.agent(t, p, p.OrchestratorAgentID)
	if orch.Model != "acp:scripted" {
		t.Errorf("orchestrator model = %q", orch.Model)
	}
	if orch.ContextUsed == nil || *orch.ContextUsed != 900 {
		t.Errorf("orchestrator context_used = %v, want the agent's usage_update (900)", orch.ContextUsed)
	}

	// Transcript: user, then tool call rows with results, then the assistant text.
	msgs := e.messages(t, p, p.OrchestratorAgentID)
	if len(msgs) < 6 || msgs[0].Role != "user" || !strings.Contains(msgs[0].Content[0].Text, "[mcp-spawn]") {
		t.Fatalf("transcript starts wrong: %+v", msgs)
	}
	uses, results := map[string]string{}, map[string]string{}
	firstUse, lastText := -1, -1
	for i, m := range msgs {
		for _, c := range m.Content {
			switch c.Type {
			case "tool_use":
				uses[c.ID] = c.Name
				if firstUse < 0 {
					firstUse = i
				}
			case "tool_result":
				results[c.ToolUseID] = c.Content
			case "text":
				if m.Role == "assistant" {
					lastText = i
				}
			}
		}
	}
	if firstUse != 1 && firstUse != 2 {
		t.Errorf("first tool call row at message %d, want right after the user message", firstUse)
	}
	for _, id := range []string{"mcp-spawn-1", "mcp-note-1"} {
		if _, ok := uses[id]; !ok {
			t.Errorf("no tool_use row for %s (have %v)", id, uses)
		}
		if _, ok := results[id]; !ok {
			t.Errorf("no tool_result row for %s", id)
		}
	}
	if lastText != len(msgs)-1 {
		t.Errorf("the last transcript row is not the assistant text (text at %d of %d)", lastText, len(msgs))
	}
	return id
}

func TestACPOrchestratorOverHTTPMCP(t *testing.T) {
	e := newACPEnv(t, map[string]string{fakeacp.EnvMCPHTTP: "1"}, nil)
	checkMCPRun(t, e, "http")
}

// --- F: stdio relay when the agent has no HTTP MCP; refusal with a warning ---

func TestACPOrchestratorOverStdioRelay(t *testing.T) {
	e := newACPEnv(t, nil, nil) // the agent does not advertise mcpCapabilities.http
	id := checkMCPRun(t, e, "stdio")
	if id.relay == 0 {
		t.Error("no relay process reported")
	}
}

func TestACPOrchestratorAgentRefusesMCP(t *testing.T) {
	e := newACPEnv(t, map[string]string{fakeacp.EnvMCPReject: "1"}, nil)
	p := e.acpProject(t)
	tr := e.ask(t, p, "[mcp-spawn] look around")
	if tr.status != "completed" {
		t.Fatalf("status = %s (%v), want the session to work without harness tools", tr.status, tr.errMsg)
	}
	text := e.lastText(t, p)
	if !strings.Contains(text, "No harness tools") {
		t.Errorf("text = %q", text)
	}
	warn, _ := tr.errMsg.(string)
	if !strings.HasPrefix(warn, "warning: ") || !strings.Contains(warn, "could not use Octo's tools") {
		t.Errorf("turn.finished error = %q, want the one-line warning", warn)
	}
	orch := e.agent(t, p, p.OrchestratorAgentID)
	if orch.Error == nil || *orch.Error != warn {
		t.Errorf("orchestrator agent error = %v, want the same warning", orch.Error)
	}
	// Still answers a plain request, and keeps warning.
	tr = e.ask(t, p, "[echo] still there?")
	if tr.status != "completed" || !strings.Contains(e.lastText(t, p), "still there?") {
		t.Errorf("second request = %s: %s", tr.status, e.lastText(t, p))
	}
	if w, _ := tr.errMsg.(string); !strings.HasPrefix(w, "warning: ") {
		t.Errorf("second turn error = %v, want the standing warning", tr.errMsg)
	}
}

// --- B: the second request reuses process and session ----------------------

func TestACPOrchestratorReusesProcessAndSession(t *testing.T) {
	e := newACPEnv(t, nil, nil)
	p := e.acpProject(t)
	e.ask(t, p, "[echo] first")
	first := parseIdentity(t, e.lastText(t, p))
	e.ask(t, p, "[echo] second")
	second := parseIdentity(t, e.lastText(t, p))
	if first.pid != second.pid || first.session != second.session || second.loaded {
		t.Fatalf("first %+v, second %+v: want the same process and session", first, second)
	}
	// The first prompt carried the briefing; the second only the request.
	text := e.lastText(t, p)
	if strings.Contains(text, "orchestrator of a software project") || !strings.Contains(text, "prompt<<[echo] second>>") {
		t.Errorf("second prompt = %q, want the bare request", text)
	}
}

// --- C: the agent process dies -----------------------------------------------

func killAndWait(t *testing.T, pid int) {
	t.Helper()
	if err := syscall.Kill(pid, syscall.SIGKILL); err != nil {
		t.Fatal(err)
	}
	waitGone(t, "killed agent", pid)
}

func TestACPOrchestratorRecoversWithLoadSession(t *testing.T) {
	e := newACPEnv(t, map[string]string{fakeacp.EnvLoadSession: "1"}, nil)
	p := e.acpProject(t)
	e.ask(t, p, "[echo] one")
	first := parseIdentity(t, e.lastText(t, p))
	killAndWait(t, first.pid)
	tr := e.ask(t, p, "[echo] two")
	if tr.status != "completed" {
		t.Fatalf("status = %s (%v)", tr.status, tr.errMsg)
	}
	text := e.lastText(t, p)
	second := parseIdentity(t, text)
	if second.pid == first.pid || !second.loaded || second.session != first.session {
		t.Fatalf("first %+v, second %+v: want a new process on the same session via session/load", first, second)
	}
	if strings.Contains(text, "Earlier in this conversation") {
		t.Errorf("a resumed session must not get a recap: %q", text)
	}
	if strings.Contains(text, "replayed") {
		t.Errorf("session/load replay leaked into the transcript: %q", text)
	}
}

func TestACPOrchestratorRecoversWithRecap(t *testing.T) {
	e := newACPEnv(t, nil, nil) // no loadSession
	p := e.acpProject(t)
	e.ask(t, p, "[echo] remember the word pelican")
	first := parseIdentity(t, e.lastText(t, p))
	killAndWait(t, first.pid)
	e.ask(t, p, "[echo] what did I say")
	text := e.lastText(t, p)
	second := parseIdentity(t, text)
	if second.pid == first.pid || second.loaded || second.session == first.session {
		t.Fatalf("first %+v, second %+v: want a new process and a new session", first, second)
	}
	for _, want := range []string{"orchestrator of a software project", "Earlier in this conversation", "user: [echo] remember the word pelican",
		"assistant: I'll look at the project first. pid=", "User request:\n[echo] what did I say"} {
		if !strings.Contains(text, want) {
			t.Errorf("first prompt of the new session lacks %q:\n%s", want, text)
		}
	}
}

func TestACPOrchestratorRecoversAfterCrash(t *testing.T) {
	e := newACPEnv(t, map[string]string{fakeacp.EnvLoadSession: "1"}, nil)
	p := e.acpProject(t)
	tr := e.ask(t, p, "[crash] die")
	if tr.status != "failed" {
		t.Fatalf("a crashed agent must fail the turn, got %s", tr.status)
	}
	tr = e.ask(t, p, "[echo] back")
	if tr.status != "completed" || !strings.Contains(e.lastText(t, p), "prompt<<") {
		t.Fatalf("request after the crash = %s: %s", tr.status, e.lastText(t, p))
	}
}

// --- D: cancel ---------------------------------------------------------------

func TestACPOrchestratorCancel(t *testing.T) {
	e := newACPEnv(t, nil, nil)
	p := e.acpProject(t)
	e.ask(t, p, "[echo] before")
	before := parseIdentity(t, e.lastText(t, p))

	ch := e.subscribe(t, p.ID)
	e.into(t, "POST", "/v1/projects/"+p.ID+"/messages", map[string]string{"text": "[hang] wait"}, http.StatusAccepted, nil)
	deadline := time.After(20 * time.Second)
waitTool:
	for {
		select {
		case ev := <-ch:
			if ev.Type == events.ToolStarted {
				break waitTool
			}
		case <-deadline:
			t.Fatal("the agent never started its tool call")
		}
	}
	e.into(t, "POST", "/v1/projects/"+p.ID+"/cancel", nil, http.StatusAccepted, nil)
	tr := finishTurn(t, ch)
	if tr.status != "cancelled" {
		t.Fatalf("status = %s, want cancelled", tr.status)
	}
	if a := e.agent(t, p, p.OrchestratorAgentID); a.Status != "idle" {
		t.Errorf("orchestrator status = %s", a.Status)
	}

	e.ask(t, p, "[echo] after")
	after := parseIdentity(t, e.lastText(t, p))
	if after.pid != before.pid || after.session != before.session {
		t.Errorf("before %+v, after %+v: the session must stay usable after a cancel", before, after)
	}
}

// --- E: MCP authentication ---------------------------------------------------

func (e *acpEnv) mcpCall(t *testing.T, path, token, origin, method string, body any) (int, string) {
	t.Helper()
	raw, _ := json.Marshal(body)
	req, err := http.NewRequest(method, e.url+path, bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	out, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(out)
}

func TestACPOrchestratorMCPAuthentication(t *testing.T) {
	e := newACPEnv(t, map[string]string{fakeacp.EnvMCPHTTP: "1"}, nil)
	a, b := e.acpProject(t), e.acpProject(t)
	var tok [2]string
	var url [2]string
	for i, p := range []projectJSON{a, b} {
		e.ask(t, p, "[mcp-info]")
		m := mcpInfoRe.FindStringSubmatch(e.lastText(t, p))
		if m == nil {
			t.Fatalf("no mcp-info in %q", e.lastText(t, p))
		}
		url[i], tok[i] = m[2], m[3]
		if want := e.url + mcp.Path(p.ID); url[i] != want {
			t.Errorf("project %d endpoint = %s, want %s", i, url[i], want)
		}
	}
	if len(tok[0]) < 32 || tok[0] == tok[1] {
		t.Fatalf("tokens must be long and per session: %q %q", tok[0], tok[1])
	}
	list := map[string]any{"jsonrpc": "2.0", "id": 1, "method": "tools/list"}
	pathA, pathB := mcp.Path(a.ID), mcp.Path(b.ID)

	if code, body := e.mcpCall(t, pathA, tok[0], "", "POST", list); code != 200 || !strings.Contains(body, "spawn_agent") {
		t.Fatalf("valid token: %d %s", code, body)
	}
	for name, c := range map[string]struct {
		path, token, origin, method string
		want                        int
	}{
		"no token":            {pathA, "", "", "POST", http.StatusUnauthorized},
		"wrong token":         {pathA, strings.Repeat("0", 64), "", "POST", http.StatusUnauthorized},
		"truncated token":     {pathA, tok[0][:10], "", "POST", http.StatusUnauthorized},
		"token of A on B":     {pathB, tok[0], "", "POST", http.StatusForbidden},
		"token of B on A":     {pathA, tok[1], "", "POST", http.StatusForbidden},
		"foreign origin":      {pathA, tok[0], "http://evil.example", "POST", http.StatusForbidden},
		"GET is not offered":  {pathA, tok[0], "", "GET", http.StatusMethodNotAllowed},
		"unknown project too": {mcp.Path("prj_nope"), tok[0], "", "POST", http.StatusForbidden},
	} {
		if code, body := e.mcpCall(t, c.path, c.token, c.origin, c.method, list); code != c.want {
			t.Errorf("%s: status %d (%s), want %d", name, code, body, c.want)
		}
	}
	// Between requests nothing may run: tools are for a running turn only.
	call := map[string]any{"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": map[string]any{
		"name": "save_note", "arguments": map[string]any{"title": "x", "content": "y"}}}
	if code, body := e.mcpCall(t, pathA, tok[0], "", "POST", call); code != 200 || !strings.Contains(body, `"isError":true`) {
		t.Errorf("tool call outside a turn: %d %s, want an error result", code, body)
	}
	if code, body := e.mcpCall(t, pathA, tok[0], "", "POST", map[string]any{"jsonrpc": "2.0", "id": 3, "method": "tools/call",
		"params": map[string]any{"name": "bash", "arguments": map[string]any{}}}); code != 200 || !strings.Contains(body, "unknown tool") {
		t.Errorf("unknown tool: %d %s", code, body)
	}

	// Expiry: once A's session ends (project delete) its token is dead.
	e.into(t, "DELETE", "/v1/projects/"+a.ID, nil, http.StatusNoContent, nil)
	if code, _ := e.mcpCall(t, pathA, tok[0], "", "POST", list); code != http.StatusUnauthorized {
		t.Errorf("token of a deleted project: %d, want 401", code)
	}
	if code, _ := e.mcpCall(t, pathB, tok[1], "", "POST", list); code != 200 {
		t.Errorf("project B's token must be unaffected: %d", code)
	}
}

// --- G: a tier mapped to an ACP agent ------------------------------------------

func TestACPTierMappedToACPAgent(t *testing.T) {
	e := newACPEnv(t, nil, nil)
	p := e.project(t, map[string]string{"fast": "acp:scripted"}) // orchestrator stays on the mock Messages model
	tr := e.ask(t, p, "please map the repository")
	if tr.status != "completed" {
		t.Fatalf("status = %s (%v)", tr.status, tr.errMsg)
	}
	var acpRuns, apiRuns int
	for _, a := range e.agents(t, p) {
		if a.ParentID == nil {
			continue
		}
		if a.Title == "Map the repository layout" { // the mock orchestrator's fast-tier task
			if a.Model != "acp:scripted" || a.Result == nil || !strings.Contains(*a.Result, "Summary: README.md") {
				t.Errorf("fast-tier sub-agent = %+v, want a run of the scripted ACP agent", a)
			}
			acpRuns++
		} else if !strings.HasPrefix(a.Model, "acp:") {
			apiRuns++
		}
	}
	if acpRuns != 1 || apiRuns == 0 {
		t.Errorf("acp runs %d, built-in runs %d: only the fast tier maps to the ACP agent", acpRuns, apiRuns)
	}
	if _, err := os.Stat(filepath.Join(e.dir, fakeacp.NoteFile)); err != nil {
		t.Errorf("the ACP sub-agent did not do its work in the project folder: %v", err)
	}
}

// --- H: no process is left behind ----------------------------------------------

func startedPIDs(t *testing.T, e *acpEnv, p projectJSON) identity {
	t.Helper()
	e.ask(t, p, "[mcp-spawn] go")
	id := parseIdentity(t, e.lastText(t, p))
	if !alive(id.pid) || id.relay == 0 || !alive(id.relay) {
		t.Fatalf("agent %d / relay %d should be running", id.pid, id.relay)
	}
	return id
}

func TestACPNoProcessLeftAfterShutdown(t *testing.T) {
	e := newACPEnv(t, nil, nil)
	id := startedPIDs(t, e, e.acpProject(t))
	if e.orch.LiveMCPTokens() == 0 {
		t.Fatal("expected a live MCP token")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := e.orch.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	waitGone(t, "agent", id.pid)
	waitGone(t, "stdio relay", id.relay)
	if n := e.orch.LiveMCPTokens(); n != 0 {
		t.Errorf("%d MCP tokens survived shutdown", n)
	}
}

func TestACPNoProcessLeftAfterIdleTimeout(t *testing.T) {
	e := newACPEnv(t, map[string]string{fakeacp.EnvLoadSession: "1"}, func(o *orchestrator.Options) { o.ACPIdle = 400 * time.Millisecond })
	p := e.acpProject(t)
	id := startedPIDs(t, e, p)
	waitGone(t, "idle agent", id.pid)
	waitGone(t, "idle stdio relay", id.relay)
	if n := e.orch.LiveMCPTokens(); n != 0 {
		t.Errorf("%d MCP tokens survived the idle shutdown", n)
	}
	// The next request starts a fresh process and resumes the session.
	e.ask(t, p, "[echo] awake")
	again := parseIdentity(t, e.lastText(t, p))
	if again.pid == id.pid || !again.loaded || again.session != id.session {
		t.Errorf("before %+v, after idle %+v: want a new process resuming the session", id, again)
	}
}

func TestACPNoProcessLeftAfterProjectDelete(t *testing.T) {
	e := newACPEnv(t, nil, nil)
	p := e.acpProject(t)
	id := startedPIDs(t, e, p)
	e.into(t, "DELETE", "/v1/projects/"+p.ID, nil, http.StatusNoContent, nil)
	waitGone(t, "agent", id.pid)
	waitGone(t, "stdio relay", id.relay)
	if n := e.orch.LiveMCPTokens(); n != 0 {
		t.Errorf("%d MCP tokens survived the project delete", n)
	}
}

// --- configuration and validation -----------------------------------------------

func TestACPModelSettingsValidation(t *testing.T) {
	e := newACPEnv(t, nil, nil)
	var cfg struct {
		Orchestrators []struct {
			Value, ID, Label string
			Models           []string
		} `json:"acp_orchestrators"`
	}
	e.into(t, "GET", "/v1/config", nil, http.StatusOK, &cfg)
	if len(cfg.Orchestrators) != 1 || cfg.Orchestrators[0].Value != "acp:scripted" || cfg.Orchestrators[0].ID != "scripted" {
		t.Fatalf("/v1/config acp_orchestrators = %+v", cfg.Orchestrators)
	}

	bad := func(method, path string, models map[string]string, wantMsg string) {
		t.Helper()
		body := map[string]any{"models": models}
		if method == "POST" {
			body["name"] = "x"
		}
		var resp struct {
			Error struct{ Code, Message, Details string } `json:"error"`
		}
		e.into(t, method, path, body, http.StatusBadRequest, &resp)
		if resp.Error.Code != "invalid_request" || !strings.Contains(resp.Error.Details, wantMsg) {
			t.Errorf("%s %v: error = %+v, want it to mention %q", method, models, resp.Error, wantMsg)
		}
	}
	p := e.acpProject(t)
	bad("POST", "/v1/projects", map[string]string{"orchestrator": "acp:nope"}, `unknown ACP agent "nope"`)
	bad("PATCH", "/v1/projects/"+p.ID, map[string]string{"orchestrator": "acp:nope/x"}, "available: scripted")
	bad("PATCH", "/v1/projects/"+p.ID, map[string]string{"deep": "acp:"}, "not a valid ACP setting")
	bad("PATCH", "/v1/projects/"+p.ID, map[string]string{"side": "acp:nope"}, `unknown ACP agent "nope"`)

	e.into(t, "PATCH", "/v1/projects/"+p.ID, map[string]any{"models": map[string]string{"orchestrator": "acp:scripted/some-model", "deep": "acp:scripted"}},
		http.StatusOK, nil)
	// Anything else is today's loop and is not checked.
	e.into(t, "PATCH", "/v1/projects/"+p.ID, map[string]any{"models": map[string]string{"orchestrator": "claude-sonnet-5-5"}}, http.StatusOK, nil)
}
