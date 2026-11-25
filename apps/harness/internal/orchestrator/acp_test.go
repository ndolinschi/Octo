package orchestrator_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/anthropicclient"
	"github.com/ndolinschi/Octo/apps/harness/internal/config"
	"github.com/ndolinschi/Octo/apps/harness/internal/events"
	"github.com/ndolinschi/Octo/apps/harness/internal/fakeacp"
	"github.com/ndolinschi/Octo/apps/harness/internal/mockllm"
	"github.com/ndolinschi/Octo/apps/harness/internal/orchestrator"
	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
	"github.com/ndolinschi/Octo/apps/harness/internal/project"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

func TestMain(m *testing.M) {
	if fakeacp.ChildMode() {
		os.Exit(fakeacp.Main())
	}
	os.Exit(m.Run())
}

func fakeAgent(id string, available bool) plugins.Agent {
	return plugins.Agent{ID: id, Label: "Fake " + id, Available: available, Launch: plugins.Launch{
		Command: os.Args[0], Env: map[string]string{fakeacp.EnvChild: "1", "GORACE": "atexit_sleep_ms=0"},
	}}
}

func newACPRig(t *testing.T, llm http.Handler, agents ...plugins.Agent) *rig {
	t.Helper()
	return newACPRigOpts(t, llm, nil, agents...)
}

// newACPRigOpts is newACPRig with extra orchestrator options set by mut.
func newACPRigOpts(t *testing.T, llm http.Handler, mut func(*orchestrator.Options), agents ...plugins.Agent) *rig {
	t.Helper()
	srv := httptest.NewServer(llm)
	t.Cleanup(srv.Close)
	store, err := projectstore.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	hub := events.NewHub()
	notes := project.NewNotes(store, hub)
	opts := orchestrator.Options{
		Client: anthropicclient.New("k", srv.URL, ""), MaxTurns: 10, Agents: agents,
	}
	if mut != nil {
		mut(&opts)
	}
	orch := orchestrator.New(store, hub, notes, opts)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = orch.Shutdown(ctx)
	})
	svc := project.NewService(store, hub, orch, project.Defaults{Models: config.DefaultModels(), MaxDepth: 3})
	return &rig{store: store, hub: hub, orch: orch, svc: svc}
}

func (r *rig) projectAt(t *testing.T, dir string) string {
	t.Helper()
	name := "p"
	p, err := r.svc.Create(context.Background(), project.Input{Name: &name, Folders: &[]project.FolderInput{{Path: dir}}})
	if err != nil {
		t.Fatal(err)
	}
	return p.ID
}

type collected struct {
	status string
	events []events.Event
}

func (c collected) of(typ string) []map[string]any {
	var out []map[string]any
	for _, e := range c.events {
		if e.Type != typ {
			continue
		}
		var m map[string]any
		if err := json.Unmarshal(e.Data, &m); err != nil {
			panic(err)
		}
		out = append(out, m)
	}
	return out
}

func (r *rig) runCollect(t *testing.T, pid, text string, during func(<-chan events.Event)) collected {
	t.Helper()
	return r.runCollectFor(t, 30*time.Second, pid, text, during)
}

func (r *rig) runCollectFor(t *testing.T, limit time.Duration, pid, text string, during func(<-chan events.Event)) collected {
	t.Helper()
	ch, cancel := r.hub.Subscribe(pid)
	defer cancel()
	if _, err := r.orch.Start(context.Background(), pid, text); err != nil {
		t.Fatal(err)
	}
	var out collected
	if during != nil {
		during(ch)
	}
	timeout := time.After(limit)
	for {
		select {
		case ev, ok := <-ch:
			if !ok {
				t.Fatal("event stream closed")
			}
			out.events = append(out.events, ev)
			if ev.Type == events.TurnFinished {
				out.status = out.of(events.TurnFinished)[0]["status"].(string)
				return out
			}
		case <-timeout:
			t.Fatal("timed out waiting for turn.finished")
		}
	}
}

func (r *rig) acpChild(t *testing.T, pid string) projectstore.Agent {
	t.Helper()
	for _, a := range r.agents(t, pid) {
		if a.ParentID != nil {
			return a
		}
	}
	t.Fatal("no sub-agent was created")
	return projectstore.Agent{}
}

func (r *rig) transcript(t *testing.T, pid, aid string) []projectstore.Message {
	t.Helper()
	msgs, err := r.svc.Messages(context.Background(), pid, aid)
	if err != nil {
		t.Fatal(err)
	}
	return msgs
}

func orchestratorToolResult(t *testing.T, r *rig, pid string) (string, bool) {
	t.Helper()
	orch, err := r.store.Get(context.Background(), pid)
	if err != nil {
		t.Fatal(err)
	}
	root, err := orch.Orchestrator(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range r.transcript(t, pid, root.ID) {
		for _, b := range m.Content {
			if b.Type == "tool_result" {
				return *b.Content, *b.IsError
			}
		}
	}
	t.Fatal("orchestrator has no tool_result")
	return "", false
}

func TestACPHappyPath(t *testing.T) {
	r := newACPRig(t, mockllm.New(0), fakeAgent("fake", true))
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("# Octo demo\nline two\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	pid := r.projectAt(t, dir)
	got := r.runCollect(t, pid, "[acp] summarize this repo", nil)
	if got.status != "completed" {
		t.Fatalf("turn = %s", got.status)
	}
	child := r.acpChild(t, pid)
	if child.Model != "acp:fake" || child.Status != projectstore.StatusCompleted || child.Role != "External agent" ||
		child.Tier == nil || *child.Tier != projectstore.TierBalanced || child.Depth != 1 {
		t.Fatalf("child = %+v", child)
	}
	if child.Result == nil || !strings.Contains(*child.Result, "Summary:") || !strings.Contains(*child.Result, "# Octo demo") {
		t.Fatalf("child result = %v", child.Result)
	}
	if child.InputTokens != 1800 {
		t.Errorf("input tokens = %d, want 1800 (last usage_update)", child.InputTokens)
	}
	if res, isErr := orchestratorToolResult(t, r, pid); isErr || res != *child.Result {
		t.Errorf("parent saw %q (error=%v), want the final text", res, isErr)
	}

	msgs := r.transcript(t, pid, child.ID)
	uses, results := map[string]string{}, map[string]string{}
	var order []string
	for _, m := range msgs {
		for _, b := range m.Content {
			switch b.Type {
			case "tool_use":
				if m.Role != "assistant" {
					t.Errorf("tool_use in %s message", m.Role)
				}
				var in struct {
					Title     string `json:"title"`
					Locations []struct{ Path string }
				}
				if err := json.Unmarshal(b.Input, &in); err != nil || in.Title == "" || len(in.Locations) == 0 {
					t.Errorf("tool_use input = %s", b.Input)
				}
				uses[*b.ID] = *b.Name
				order = append(order, "use:"+*b.ID)
			case "tool_result":
				if m.Role != "user" {
					t.Errorf("tool_result in %s message", m.Role)
				}
				results[*b.ToolUseID] = *b.Content
				order = append(order, "result:"+*b.ToolUseID)
			case "text":
				order = append(order, m.Role+"-text")
			}
		}
	}
	if uses["call-read"] != "read" || uses["call-edit"] != "edit" || len(uses) != 2 || len(results) != 2 {
		t.Fatalf("uses = %v results = %v", uses, results)
	}
	if !strings.Contains(results["call-edit"], "+# ACP demo note") || !strings.Contains(results["call-edit"], "diff ") {
		t.Errorf("edit result = %q", results["call-edit"])
	}
	want := []string{"user-text", "assistant-text", "use:call-read", "result:call-read", "assistant-text", "use:call-edit", "result:call-edit", "assistant-text"}
	if strings.Join(order, ",") != strings.Join(want, ",") {
		t.Errorf("transcript order = %v\nwant %v", order, want)
	}

	note, err := os.ReadFile(filepath.Join(dir, fakeacp.NoteFile))
	if err != nil || !strings.Contains(string(note), "ACP demo note") {
		t.Fatalf("note = %q, %v", note, err)
	}
	var changed []map[string]any
	for _, e := range got.of(events.FileChanged) {
		if e["path"] == fakeacp.NoteFile {
			changed = append(changed, e)
		}
	}
	if len(changed) != 1 || changed[0]["source"] != "agent" || changed[0]["folder"] == "" {
		t.Errorf("file.changed = %v", changed)
	}
	started, finished := 0, 0
	for _, e := range got.of(events.ToolStarted) {
		if e["agent_id"] == child.ID {
			started++
		}
	}
	for _, e := range got.of(events.ToolFinished) {
		if e["agent_id"] == child.ID && e["is_error"] == false {
			finished++
		}
	}
	if started != 2 || finished != 2 {
		t.Errorf("tool events started=%d finished=%d", started, finished)
	}
	deltas := ""
	for _, e := range got.of(events.MessageDelta) {
		if e["agent_id"] == child.ID {
			deltas += e["text"].(string)
		}
	}
	if !strings.Contains(deltas, "I'll look at the project first.") || !strings.Contains(deltas, "Summary:") {
		t.Errorf("deltas = %q", deltas)
	}
}

func TestACPEscapeRefused(t *testing.T) {
	r := newACPRig(t, mockllm.New(0), fakeAgent("fake", true))
	pid := r.projectAt(t, t.TempDir())
	if got := r.runCollect(t, pid, "[acp] [escape]", nil); got.status != "completed" {
		t.Fatalf("turn = %s", got.status)
	}
	child := r.acpChild(t, pid)
	if child.Status != projectstore.StatusCompleted || child.Result == nil ||
		!strings.Contains(*child.Result, "Escape attempt refused") || !strings.Contains(*child.Result, "outside the project folders") {
		t.Fatalf("child = %+v result=%v", child, child.Result)
	}
}

func TestACPCrashFailsOnlyTheSubAgent(t *testing.T) {
	r := newACPRig(t, mockllm.New(0), fakeAgent("fake", true))
	pid := r.projectAt(t, t.TempDir())
	got := r.runCollect(t, pid, "[acp] [crash]", nil)
	if got.status != "completed" {
		t.Fatalf("parent turn = %s, want completed", got.status)
	}
	child := r.acpChild(t, pid)
	if child.Status != projectstore.StatusFailed || child.Error == nil || !strings.Contains(*child.Error, "stopped in the middle") {
		t.Fatalf("child = %+v error=%v", child, child.Error)
	}
	if res, isErr := orchestratorToolResult(t, r, pid); !isErr || !strings.Contains(res, "sub-agent failed") || !strings.Contains(res, "exit status 3") {
		t.Errorf("parent result = %q error=%v", res, isErr)
	}
	for _, m := range r.transcript(t, pid, child.ID) {
		for _, b := range m.Content {
			if b.Type == "tool_use" {
				for _, m2 := range r.transcript(t, pid, child.ID) {
					for _, b2 := range m2.Content {
						if b2.Type == "tool_result" && *b2.ToolUseID == *b.ID && *b2.IsError {
							return
						}
					}
				}
				t.Fatal("open tool call was not closed with an error result")
			}
		}
	}
}

func TestACPUnknownVariantsTolerated(t *testing.T) {
	r := newACPRig(t, mockllm.New(0), fakeAgent("fake", true))
	pid := r.projectAt(t, t.TempDir())
	if got := r.runCollect(t, pid, "[acp] [unknown]", nil); got.status != "completed" {
		t.Fatalf("turn = %s", got.status)
	}
	child := r.acpChild(t, pid)
	if child.Status != projectstore.StatusCompleted || !strings.Contains(*child.Result, "-32601") {
		t.Fatalf("child = %+v result=%v", child, child.Result)
	}
}

func TestACPCancelStopsProcess(t *testing.T) {
	hangThenStop(t, func(r *rig, pid string) { r.orch.Cancel(pid) })
}

func TestACPShutdownStopsProcess(t *testing.T) {
	hangThenStop(t, func(r *rig, _ string) {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if err := r.orch.Shutdown(ctx); err != nil {
			t.Errorf("shutdown: %v", err)
		}
	})
}

func hangThenStop(t *testing.T, stop func(r *rig, pid string)) {
	t.Helper()
	r := newACPRig(t, mockllm.New(0), fakeAgent("fake", true))
	pid := r.projectAt(t, t.TempDir())
	var childPID int
	got := r.runCollect(t, pid, "[acp] [hang]", func(ch <-chan events.Event) {
		deadline := time.After(20 * time.Second)
		for {
			select {
			case ev := <-ch:
				if ev.Type != events.MessageCreated {
					continue
				}
				if p := hangPID(ev.Data); p > 0 {
					childPID = p
					stop(r, pid)
					return
				}
			case <-deadline:
				t.Fatal("hang tool call never appeared")
			}
		}
	})
	if got.status != "cancelled" {
		t.Fatalf("turn = %s, want cancelled", got.status)
	}
	child := r.acpChild(t, pid)
	if child.Status != projectstore.StatusCancelled {
		t.Fatalf("child = %+v", child)
	}
	if childPID == 0 || processAlive(childPID) {
		t.Fatalf("agent process %d still alive after cancel", childPID)
	}
}

func hangPID(data []byte) int {
	var ev struct {
		Message struct {
			Content []struct {
				Type  string
				Input struct {
					RawInput struct{ Pid int } `json:"raw_input"`
				}
			}
		}
	}
	if json.Unmarshal(data, &ev) != nil {
		return 0
	}
	for _, b := range ev.Message.Content {
		if b.Type == "tool_use" && b.Input.RawInput.Pid > 0 {
			return b.Input.RawInput.Pid
		}
	}
	return 0
}

func processAlive(pid int) bool {
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if err := syscall.Kill(pid, 0); err != nil {
			return false
		}
		time.Sleep(20 * time.Millisecond)
	}
	return true
}

func TestSpawnAgentParameterAndErrors(t *testing.T) {
	type result struct {
		hasAgent bool
		enum     []string
	}
	for _, tc := range []struct {
		name    string
		agents  []plugins.Agent
		folders bool
		input   string
		want    result
		errHas  string
	}{
		{"no agents hides parameter", nil, true, `{}`, result{}, ""},
		{"unavailable agents hidden", []plugins.Agent{fakeAgent("gone", false)}, true, `{}`, result{}, ""},
		{"enum lists available only", []plugins.Agent{fakeAgent("a", true), fakeAgent("b", false), fakeAgent("c", true)}, true, `{}`,
			result{true, []string{"a", "c"}}, ""},
		{"unknown id", []plugins.Agent{fakeAgent("a", true)}, true, `"agent":"nope",`, result{true, []string{"a"}}, "unknown or unavailable ACP agent"},
		{"unavailable id", []plugins.Agent{fakeAgent("a", true), fakeAgent("b", false)}, true, `"agent":"b",`, result{true, []string{"a"}}, "unknown or unavailable ACP agent"},
		{"no folders", []plugins.Agent{fakeAgent("a", true)}, false, `"agent":"a",`, result{true, []string{"a"}}, "has none attached"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var schema []byte
			llm := fakeLLM(func(w http.ResponseWriter, hr *http.Request, req fakeReq) {
				if !req.isOrchestrator() {
					respond(w, "end_turn", textBlock("child"))
					return
				}
				if len(req.Msgs) > 1 {
					respond(w, "end_turn", textBlock("done"))
					return
				}
				for _, tl := range req.Tools {
					if tl.Name == "spawn_agent" {
						schema = tl.InputSchema
					}
				}
				input := `{"role":"R","title":"T","task":"x","tier":"fast"}`
				if strings.HasPrefix(tc.input, `"agent"`) {
					input = `{` + tc.input + `"role":"R","title":"T","task":"x","tier":"fast"}`
				}
				respond(w, "tool_use", `{"type":"tool_use","id":"t1","name":"spawn_agent","input":`+input+`}`)
			})
			r := newACPRig(t, llm, tc.agents...)
			var pid string
			if tc.folders {
				pid = r.projectAt(t, t.TempDir())
			} else {
				name := "p"
				p, err := r.svc.Create(context.Background(), project.Input{Name: &name})
				if err != nil {
					t.Fatal(err)
				}
				pid = p.ID
			}
			if st := r.run(t, pid, "go", nil); st != "completed" {
				t.Fatalf("turn = %s", st)
			}
			var sch struct {
				Properties map[string]struct {
					Enum []string `json:"enum"`
				} `json:"properties"`
			}
			if err := json.Unmarshal(schema, &sch); err != nil {
				t.Fatalf("schema %s: %v", schema, err)
			}
			agentProp, has := sch.Properties["agent"]
			if has != tc.want.hasAgent || strings.Join(agentProp.Enum, ",") != strings.Join(tc.want.enum, ",") {
				t.Fatalf("agent property = %v %v, want %+v", has, agentProp.Enum, tc.want)
			}
			if tc.errHas == "" {
				return
			}
			res, isErr := orchestratorToolResult(t, r, pid)
			if !isErr || !strings.Contains(res, tc.errHas) {
				t.Fatalf("tool result = %q error=%v, want error containing %q", res, isErr, tc.errHas)
			}
			if n := len(r.agents(t, pid)); n != 1 {
				t.Fatalf("%d agents, want only the orchestrator", n)
			}
		})
	}
}

func TestOrchestratorPromptMentionsACPAgents(t *testing.T) {
	var system string
	llm := fakeLLM(func(w http.ResponseWriter, hr *http.Request, req fakeReq) {
		system = string(req.System)
		respond(w, "end_turn", textBlock("hi"))
	})
	r := newACPRig(t, llm, fakeAgent("a", true), fakeAgent("b", false))
	pid := r.projectAt(t, t.TempDir())
	if st := r.run(t, pid, "hello", nil); st != "completed" {
		t.Fatal(st)
	}
	if !strings.Contains(system, "a (Fake a)") || strings.Contains(system, "Fake b") || !strings.Contains(system, "external local agent") {
		t.Fatalf("system prompt lacks ACP paragraph:\n%s", system)
	}
}
