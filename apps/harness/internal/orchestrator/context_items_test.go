package orchestrator_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/config"
	"github.com/ndolinschi/Octo/apps/harness/internal/memory"
	"github.com/ndolinschi/Octo/apps/harness/internal/orchestrator"
	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
	"github.com/ndolinschi/Octo/apps/harness/internal/project"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
	"github.com/ndolinschi/Octo/apps/harness/internal/tools"
)

// checkItemSums is decision 88's invariant: the items of a category add up to
// the category, the categories add up to used_tokens.
func checkItemSums(t *testing.T, rep orchestrator.ContextReport) {
	t.Helper()
	if got := sum(rep.Categories); got != rep.UsedTokens {
		t.Fatalf("categories sum to %d, used %d: %+v", got, rep.UsedTokens, rep.Categories)
	}
	for _, c := range rep.Categories {
		if c.Items == nil {
			t.Fatalf("category %s has no items array", c.ID)
		}
		var n int64
		for _, it := range c.Items {
			if it.Tokens < 0 || !it.Estimated || it.ID == "" || it.Label == "" {
				t.Fatalf("category %s item %+v", c.ID, it)
			}
			n += it.Tokens
		}
		if n != c.Tokens {
			t.Fatalf("category %s: items sum to %d, category %d: %+v", c.ID, n, c.Tokens, c.Items)
		}
	}
}

func category(rep orchestrator.ContextReport, id string) (orchestrator.ContextCategory, bool) {
	for _, c := range rep.Categories {
		if c.ID == id {
			return c, true
		}
	}
	return orchestrator.ContextCategory{}, false
}

func itemByID(c orchestrator.ContextCategory, id string) (orchestrator.ContextItem, bool) {
	for _, it := range c.Items {
		if it.ID == id {
			return it, true
		}
	}
	return orchestrator.ContextItem{}, false
}

func (r *rig) appendBlocks(t *testing.T, pid, role string, blocks ...map[string]any) {
	t.Helper()
	ctx := context.Background()
	db, _ := r.store.Get(ctx, pid)
	orch, _ := db.Orchestrator(ctx)
	b, _ := json.Marshal(blocks)
	if _, err := db.AppendMessage(ctx, orch.ID, role, b); err != nil {
		t.Fatal(err)
	}
}

func TestContextItemsOfTheBuiltInOrchestrator(t *testing.T) {
	for _, mode := range []string{"full", "window"} {
		t.Run(mode, func(t *testing.T) {
			r := newRigWith(t, mockLLMQuick(), orchestrator.Options{Agents: []plugins.Agent{fakeAgent("fake", true)}})
			name, depth := "p", 1
			dir := t.TempDir()
			p, err := r.svc.Create(context.Background(), project.Input{Name: &name, MaxDepth: &depth,
				Instructions: ptrStr("Always answer in French."),
				Folders:      &[]project.FolderInput{{Path: dir}}, Memory: &memory.Settings{Context: mode}})
			if err != nil {
				t.Fatal(err)
			}
			pid := p.ID
			for path, text := range map[string]string{"AGENTS.md": "RULE: " + strings.Repeat("be careful ", 40)} {
				if err := os.WriteFile(filepath.Join(dir, path), []byte(text), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := r.notes.Create(context.Background(), pid, "Plan", strings.Repeat("note text ", 30)); err != nil {
				t.Fatal(err)
			}
			db, _ := r.store.Get(context.Background(), pid)
			if _, err := db.PutFile(context.Background(), projectstore.MemoryFile{Path: "/memories/arch.md", Summary: "architecture", Content: strings.Repeat("x", 4000)}); err != nil {
				t.Fatal(err)
			}
			r.seed(t, pid, 4)
			r.appendBlocks(t, pid, "assistant", map[string]any{"type": "tool_use", "id": "tu1", "name": "read_file", "input": map[string]any{"path": "a.go"}})
			r.appendBlocks(t, pid, "user", map[string]any{"type": "tool_result", "tool_use_id": "tu1", "content": strings.Repeat("package main ", 200)})
			r.appendBlocks(t, pid, "user", map[string]any{"type": "text", "text": "latest request\nwith a second line"})

			rep, err := r.orch.Context(context.Background(), pid, "")
			if err != nil {
				t.Fatal(err)
			}
			checkItemSums(t, rep)

			tl, _ := category(rep, "tools")
			if it, ok := itemByID(tl, "tool:spawn_agent"); !ok || it.Group != "Harness tools" || it.Tokens == 0 {
				t.Fatalf("tool items = %+v", tl.Items)
			}
			if mc, ok := category(rep, "mcp_tools"); !ok || mc.Tokens != 0 || len(mc.Items) != 0 {
				t.Fatalf("the orchestrator has no tool-server tools: %+v", mc)
			}
			ins, _ := category(rep, "instructions")
			if len(ins.Items) != 1 || !strings.HasSuffix(ins.Items[0].Path, ":AGENTS.md") || ins.Items[0].Actions[0] != "open" {
				t.Fatalf("instruction items = %+v", ins.Items)
			}
			sys, _ := category(rep, "system")
			if _, ok := itemByID(sys, "system:custom"); !ok {
				t.Fatalf("custom instructions row missing: %+v", sys.Items)
			}
			if _, ok := itemByID(sys, "system:guidance"); !ok {
				t.Fatalf("guidance row missing: %+v", sys.Items)
			}
			ag, _ := category(rep, "agents")
			if _, ok := itemByID(ag, "agent:fake"); !ok || ag.Tokens == 0 {
				t.Fatalf("sub-agent definitions = %+v", ag)
			}
			nt, _ := category(rep, "notes")
			if it, ok := itemByID(nt, "notes:index"); !ok || it.Tokens == 0 || len(nt.Items) != 1 {
				t.Fatalf("notes items = %+v (the index row; this note is not pinned)", nt.Items)
			}
			msgs, _ := category(rep, "messages")
			for _, id := range []string{"messages:user", "messages:assistant", "messages:thinking"} {
				if _, ok := itemByID(msgs, id); !ok {
					t.Fatalf("messages rows = %+v, missing %s", msgs.Items, id)
				}
			}
			if think, _ := itemByID(msgs, "messages:thinking"); think.Tokens != 0 {
				t.Fatalf("the built-in loop asks for no thinking: %+v", think)
			}
			if mode == "full" {
				tr, _ := category(rep, "tool_results")
				if it, ok := itemByID(tr, "tool_results:read_file"); !ok || it.Tokens != tr.Tokens || tr.Tokens == 0 {
					t.Fatalf("tool result rows = %+v", tr.Items)
				}
				if len(msgs.Actions) != 1 || msgs.Actions[0] != "compact" {
					t.Fatalf("messages actions = %v", msgs.Actions)
				}
				cur, _ := category(rep, "current_request")
				if cur.Tokens == 0 || len(cur.Items) != 1 {
					t.Fatalf("current request = %+v", cur)
				}
			} else {
				mem, _ := category(rep, "memory")
				if _, ok := itemByID(mem, "memory:"+orchestrator.BlockTasks); !ok || mem.Tokens == 0 {
					t.Fatalf("memory rows = %+v", mem.Items)
				}
				if len(msgs.Actions) != 0 {
					t.Fatalf("window mode compacts nothing: %v", msgs.Actions)
				}
			}

			if len(rep.NotLoaded) != 1 || rep.NotLoaded[0].Path != "/memories/arch.md" || rep.NotLoaded[0].Loaded || rep.NotLoaded[0].Tokens < 900 {
				t.Fatalf("not loaded = %+v", rep.NotLoaded)
			}
			if rep.BufferTokens != 0 {
				t.Fatalf("buffer = %d", rep.BufferTokens)
			}
			if n := len(rep.LargestMessages); n == 0 || n > 5 {
				t.Fatalf("largest messages = %+v", rep.LargestMessages)
			}
			for i, m := range rep.LargestMessages {
				if m.MessageID == 0 || m.Tokens == 0 || len([]rune(m.Preview)) > 80 || strings.Contains(m.Preview, "\n") ||
					(i > 0 && m.Tokens > rep.LargestMessages[i-1].Tokens) {
					t.Fatalf("largest[%d] = %+v", i, m)
				}
			}
			if mode == "full" && !strings.HasPrefix(rep.LargestMessages[0].Preview, "[result] package main") {
				t.Fatalf("the tool result is the largest message: %+v", rep.LargestMessages)
			}

			// Old fields are still there, and the JSON carries the new ones as arrays.
			raw, _ := json.Marshal(rep)
			for _, k := range []string{`"items":[`, `"not_loaded":[`, `"buffer_tokens":0`, `"largest_messages":[`, `"parts":[`, `"free_tokens"`} {
				if !strings.Contains(string(raw), k) {
					t.Fatalf("json lacks %s: %s", k, raw)
				}
			}

			// After a turn the reported total replaces the estimate; the sums still hold.
			if st := r.run(t, pid, "next", nil); st != "completed" {
				t.Fatalf("turn = %s", st)
			}
			rep2, _ := r.orch.Context(context.Background(), pid, "")
			if rep2.Estimated {
				t.Fatalf("expected a reported total: %+v", rep2)
			}
			checkItemSums(t, rep2)
		})
	}
}

func TestContextItemsOfASubAgentNameToolServers(t *testing.T) {
	remote := []tools.Def{
		{Name: "lookup", Description: "look something up on the server", InputSchema: json.RawMessage(`{"type":"object","properties":{"q":{"type":"string"}}}`),
			Server: "tools.local:9000", Handle: func(context.Context, json.RawMessage) (string, bool, error) { return "", false, nil }},
		{Name: "deploy", Description: strings.Repeat("deploy the thing ", 20), InputSchema: json.RawMessage(`{"type":"object"}`),
			Server: "ops.local:9100", Handle: func(context.Context, json.RawMessage) (string, bool, error) { return "", false, nil }},
	}
	r := newRigWith(t, fakeLLM(func(w http.ResponseWriter, _ *http.Request, req fakeReq) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case req.isOrchestrator() && len(req.Msgs) == 1:
			fmt.Fprint(w, `{"id":"m","type":"message","role":"assistant","model":"x","content":[`+spawnBlock("t1", "worker")+`],"stop_reason":"tool_use","usage":{"input_tokens":50,"output_tokens":2}}`)
		case req.isOrchestrator():
			fmt.Fprint(w, `{"id":"m","type":"message","role":"assistant","model":"x","content":[`+textBlock("done")+`],"stop_reason":"end_turn","usage":{"input_tokens":700,"output_tokens":2}}`)
		default:
			fmt.Fprint(w, `{"id":"m","type":"message","role":"assistant","model":"x","content":[`+textBlock("child report")+`],"stop_reason":"end_turn","usage":{"input_tokens":400,"output_tokens":2}}`)
		}
	}), orchestrator.Options{Remote: remote})
	pid := r.project(t, 1)
	if st := r.run(t, pid, "go", nil); st != "completed" {
		t.Fatalf("turn = %s", st)
	}
	child := r.agents(t, pid)[1]
	rep, err := r.orch.Context(context.Background(), pid, child.ID)
	if err != nil {
		t.Fatal(err)
	}
	checkItemSums(t, rep)
	mc, ok := category(rep, "mcp_tools")
	if !ok || mc.Tokens == 0 || len(mc.Items) != 2 {
		t.Fatalf("mcp tools = %+v", mc)
	}
	dep, ok := itemByID(mc, "tool:ops.local:9100:deploy")
	if !ok || dep.Server != "ops.local:9100" || dep.Label != "ops.local:9100 · deploy" || dep.Group != "ops.local:9100" {
		t.Fatalf("deploy row = %+v", dep)
	}
	if mc.Items[0].ID != dep.ID {
		t.Fatalf("largest first: %+v", mc.Items)
	}
	tl, _ := category(rep, "tools")
	if _, ok := itemByID(tl, "tool:run_command"); !ok {
		if _, ok := itemByID(tl, "tool:read_file"); !ok {
			t.Fatalf("built-in tools = %+v", tl.Items)
		}
	}
	// A sub-agent has no notes, memory or sub-agent definitions of its own to itemise.
	for _, id := range []string{"notes", "memory", "agents"} {
		if c, _ := category(rep, id); c.Tokens != 0 || len(c.Items) != 0 {
			t.Fatalf("%s = %+v", id, c)
		}
	}
	if len(rep.NotLoaded) != 0 {
		t.Fatalf("not loaded = %+v", rep.NotLoaded)
	}
	// The old tools part still counts the whole serialized list (built-in and tool-server tools).
	var partTools int64
	for _, p := range rep.Parts {
		if p.Key == "tools" {
			partTools = p.Tokens
		}
	}
	if partTools != tl.Tokens+mc.Tokens {
		t.Fatalf("parts.tools = %d, tools + mcp_tools = %d + %d", partTools, tl.Tokens, mc.Tokens)
	}
}

func TestContextItemsOfAnACPOrchestratorItemiseOnlyWhatTheHarnessSends(t *testing.T) {
	r := newACPRig(t, mockLLMQuick(), fakeAgent("fake", true))
	r.svc = r.svcWithAgents(t, fakeAgent("fake", true))
	name := "p"
	p, err := r.svc.Create(context.Background(), project.Input{Name: &name, Folders: &[]project.FolderInput{{Path: t.TempDir()}},
		Models: &config.Models{Orchestrator: "acp:fake"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := project.NewNotes(r.store, r.hub).Create(context.Background(), p.ID, "Plan", "a note"); err != nil {
		t.Fatal(err)
	}
	// An agent that reported nothing: nothing is invented.
	if st := r.runCollect(t, p.ID, "[echo] hi", nil).status; st != "completed" {
		t.Fatal(st)
	}
	rep, _ := r.orch.Context(context.Background(), p.ID, "")
	raw, _ := json.Marshal(rep)
	if rep.Source != "agent" || len(rep.Categories) != 0 || !strings.Contains(string(raw), `"categories":[]`) || !strings.Contains(string(raw), `"not_loaded":[]`) {
		t.Fatalf("unreported: %s", raw)
	}

	// An agent that reported its size (the scripted agent reports 1800 of 200000).
	if st := r.runCollect(t, p.ID, "[acp] summarize", nil).status; st != "completed" {
		t.Fatal(st)
	}
	rep, err = r.orch.Context(context.Background(), p.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	if rep.Source != "agent" || rep.Estimated || rep.UsedTokens != 1800 {
		t.Fatalf("report = %+v", rep)
	}
	checkItemSums(t, rep)
	ids := []string{}
	for _, c := range rep.Categories {
		ids = append(ids, c.ID)
	}
	// What the harness sends (briefing, the harness MCP server's tools, notes, agents) is itself about 2,500 estimated tokens
	// since the slash, notes and attachment tools joined it, more than the 1,800 the scripted agent reports: the rows are
	// scaled down to the reported size and there is nothing left for an "Inside the agent" row.
	if _, ok := category(rep, "agent"); ok {
		t.Fatalf("categories = %v: the harness's own parts already exceed the reported size", ids)
	}
	if mc, ok := category(rep, "mcp_tools"); !ok {
		t.Fatalf("the harness's MCP tools are itemised: %v", ids)
	} else if it, ok := itemByID(mc, "tool:octo-harness:spawn_agent"); !ok || it.Server != "octo-harness" || it.Label != "octo-harness · spawn_agent" {
		t.Fatalf("mcp rows = %+v", mc.Items)
	}
	if c, ok := category(rep, "notes"); !ok || len(c.Items) == 0 {
		t.Fatalf("notes are sent to the agent: %v", ids)
	}
	for _, id := range []string{"messages", "tool_results", "tools", "instructions"} {
		if _, ok := category(rep, id); ok {
			t.Fatalf("%s is the agent's own: %v", id, ids)
		}
	}
}

func ptrStr(s string) *string { return &s }
