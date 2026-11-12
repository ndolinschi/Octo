package bridge_test

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/orchestrator"
	"github.com/ndolinschi/Octo/apps/harness/internal/project"
)

// collectUntil gathers events up to and including the first of type typ.
func collectUntil(t *testing.T, ch <-chan sseEvent, typ string) []sseEvent {
	t.Helper()
	var got []sseEvent
	timeout := time.After(15 * time.Second)
	for {
		select {
		case ev, ok := <-ch:
			if !ok {
				t.Fatalf("stream ended early after %d events", len(got))
			}
			got = append(got, ev)
			if ev.Type == typ {
				return got
			}
		case <-timeout:
			t.Fatalf("timed out waiting for %s after %d events", typ, len(got))
		}
	}
}

func indexOf(evs []sseEvent, typ string) int {
	for i, e := range evs {
		if e.Type == typ {
			return i
		}
	}
	return -1
}

func TestManualCompactionStoresAMarkerAndShrinksTheContext(t *testing.T) {
	e := newEnv(t, nil)
	pid, _ := e.v7Project(t, "full")
	e.wantError(t, "POST", "/v1/projects/"+pid+"/compact", nil, http.StatusConflict, "nothing_to_compact")
	e.runTurn(t, pid, "quick first question about the layout")
	e.runTurn(t, pid, "quick second question about the tests")
	e.waitIdle(t, pid)
	var before orchestrator.ContextReport
	e.into(t, "GET", "/v1/projects/"+pid+"/context", nil, http.StatusOK, &before)

	stream := e.subscribe(t, pid)
	var res orchestrator.CompactResult
	e.into(t, "POST", "/v1/projects/"+pid+"/compact", nil, http.StatusOK, &res)
	if !res.Manual || res.MessageCount < 4 || res.UptoMessageID == 0 || res.SummaryTokens == 0 || res.At == "" {
		t.Fatalf("result = %+v", res)
	}
	var p project.Project
	e.into(t, "GET", "/v1/projects/"+pid, nil, http.StatusOK, &p)
	var msgs struct {
		Messages    []map[string]any     `json:"messages"`
		Compactions []project.Compaction `json:"compactions"`
	}
	e.into(t, "GET", "/v1/projects/"+pid+"/agents/"+p.OrchestratorAgentID+"/messages", nil, http.StatusOK, &msgs)
	if len(msgs.Compactions) != 1 || !msgs.Compactions[0].Manual || msgs.Compactions[0].Label != "history compacted" ||
		msgs.Compactions[0].MessageCount != res.MessageCount || msgs.Compactions[0].UptoMessageID != res.UptoMessageID {
		t.Fatalf("marker = %+v", msgs.Compactions)
	}
	if len(msgs.Messages) < 4 {
		t.Fatalf("the transcript must keep every message: %d", len(msgs.Messages))
	}
	var after orchestrator.ContextReport
	e.into(t, "GET", "/v1/projects/"+pid+"/context", nil, http.StatusOK, &after)
	if after.CompactedAt == "" {
		t.Fatalf("compacted_at missing: %+v", after)
	}
	cat := map[string]int64{}
	for _, c := range after.Categories {
		cat[c.ID] = c.Tokens
	}
	if cat["summary"] == 0 {
		t.Fatalf("the summary has its category: %+v", after.Categories)
	}
	// Events: agent.compacted (manual) and context.updated.
	evs := collectUntil(t, stream, "context.updated")
	if count(evs, "agent.compacted") != 1 || evs[indexOf(evs, "agent.compacted")].Data["manual"] != true {
		t.Fatalf("events = %+v", evs)
	}
	// Nothing new to summarise: refused. And the conversation goes on from the summary.
	e.wantError(t, "POST", "/v1/projects/"+pid+"/compact", nil, http.StatusConflict, "nothing_to_compact")
	e.runTurn(t, pid, "quick third question")
	e.wantError(t, "POST", "/v1/projects/prj_nope/compact", nil, http.StatusNotFound, "not_found")
}

func TestCompactionIsRefusedWhileATurnRunsAndInTheWindowMode(t *testing.T) {
	e := newEnv(t, nil)
	pid, _ := e.v7Project(t, "full")
	e.runTurn(t, pid, "quick a")
	e.into(t, "POST", "/v1/projects/"+pid+"/messages", map[string]string{"text": "Go [bash:sleep 2]"}, http.StatusAccepted, nil)
	e.wantError(t, "POST", "/v1/projects/"+pid+"/compact", nil, http.StatusConflict, "turn_in_progress")
	e.into(t, "POST", "/v1/projects/"+pid+"/cancel", nil, http.StatusAccepted, nil)
	e.waitIdle(t, pid)
	e.into(t, "PATCH", "/v1/projects/"+pid, map[string]any{"memory": map[string]string{"context": "window"}}, http.StatusOK, nil)
	e.wantError(t, "POST", "/v1/projects/"+pid+"/compact", nil, http.StatusConflict, "compact_unsupported")
}

func TestExportMarkdown(t *testing.T) {
	e := newEnv(t, nil)
	pid, _ := e.v7Project(t, "full")
	secret := "sk-export-Zq81xT0pL9vB"
	e.into(t, "PUT", "/v1/projects/"+pid+"/secrets/EXPORT_KEY", map[string]string{"value": secret}, http.StatusNoContent, nil)
	e.runTurn(t, pid, "Go [bash:echo "+secret+"] the key is "+secret)
	e.runTurn(t, pid, "quick second")
	e.waitIdle(t, pid)
	e.into(t, "POST", "/v1/projects/"+pid+"/compact", nil, http.StatusOK, nil)
	e.runTurn(t, pid, "quick third")

	status, body := e.do(t, "GET", "/v1/projects/"+pid+"/export?format=md", nil)
	md := string(body)
	if status != http.StatusOK {
		t.Fatalf("status %d: %s", status, md)
	}
	if strings.Contains(md, secret) {
		t.Fatalf("the export holds a secret:\n%s", md)
	}
	for _, want := range []string{"# v7", "## Request 1", "### Answer", "## Request 2", "## Request 3", "- `spawn_agent` `", "→ ok", "> History compacted on request"} {
		if !strings.Contains(md, want) {
			t.Errorf("export lacks %q:\n%s", want, md)
		}
	}
	// Tool calls are one line each.
	for _, line := range strings.Split(md, "\n") {
		if strings.HasPrefix(line, "- `") && strings.Count(line, "`") < 2 {
			t.Errorf("bad tool line %q", line)
		}
	}
	// The marker sits between request 2 and request 3.
	if i, j, k := strings.Index(md, "## Request 2"), strings.Index(md, "> History compacted"), strings.Index(md, "## Request 3"); !(i < j && j < k) {
		t.Errorf("marker position: request 2 at %d, marker %d, request 3 at %d", i, j, k)
	}
	e.wantError(t, "GET", "/v1/projects/"+pid+"/export?format=txt", nil, http.StatusBadRequest, "invalid_request")
	e.wantError(t, "GET", "/v1/projects/"+pid+"/export", nil, http.StatusBadRequest, "invalid_request")
	e.wantError(t, "GET", "/v1/projects/prj_nope/export?format=md", nil, http.StatusNotFound, "not_found")
}

func TestSearchPastRequestsAcrossProjects(t *testing.T) {
	e := newEnv(t, nil)
	p1, _ := e.v7Project(t, "full")
	p2, _ := e.v7Project(t, "full")
	e.runTurn(t, p1, "quick please investigate the zebrafish migration")
	e.runTurn(t, p2, "quick also the zebrafish importer")
	e.runTurn(t, p2, "quick something unrelated")
	e.waitIdle(t, p1)
	e.waitIdle(t, p2)
	var got struct {
		Results []project.SearchHit `json:"results"`
	}
	e.into(t, "GET", "/v1/search?q=zebrafish", nil, http.StatusOK, &got)
	if len(got.Results) != 2 {
		t.Fatalf("results = %+v", got.Results)
	}
	seen := map[string]bool{}
	for _, r := range got.Results {
		seen[r.ProjectID] = true
		if r.ProjectName == "" || r.MessageID == 0 || !strings.Contains(r.Snippet, "zebrafish") || r.Date == "" {
			t.Fatalf("hit = %+v", r)
		}
	}
	if !seen[p1] || !seen[p2] {
		t.Fatalf("both projects must match: %+v", got.Results)
	}
	// Only requests: not the answers (the mock repeats the request in its answer) and not sub-agent tasks.
	e.into(t, "GET", "/v1/search?q=zebrafish&limit=1", nil, http.StatusOK, &got)
	if len(got.Results) != 1 {
		t.Fatalf("limit: %+v", got.Results)
	}
	e.into(t, "GET", "/v1/search?q=unrelated", nil, http.StatusOK, &got)
	if len(got.Results) != 1 || got.Results[0].ProjectID != p2 {
		t.Fatalf("unrelated: %+v", got.Results)
	}
	e.into(t, "GET", "/v1/search?q=nonexistentword", nil, http.StatusOK, &got)
	if len(got.Results) != 0 {
		t.Fatalf("nothing should match: %+v", got.Results)
	}
	e.wantError(t, "GET", "/v1/search", nil, http.StatusBadRequest, "invalid_request")
	e.wantError(t, "GET", "/v1/search?q=%20%20", nil, http.StatusBadRequest, "invalid_request")
}

func TestContextEndpointKeepsItsShapeAndAddsTheNewFields(t *testing.T) {
	e := newEnv(t, nil)
	pid, _ := e.v7Project(t, "full")
	e.runTurn(t, pid, "quick hello")
	e.waitIdle(t, pid)
	status, body := e.do(t, "GET", "/v1/projects/"+pid+"/context", nil)
	if status != http.StatusOK {
		t.Fatal(status)
	}
	for _, key := range []string{`"agent_id"`, `"model"`, `"window_tokens"`, `"used_tokens"`, `"estimated"`, `"parts"`, // as before
		`"source":"harness"`, `"window"`, `"window_source":"default"`, `"free_tokens"`, `"reserved_tokens"`, `"categories"`, `"last_request"`,
		`"items":[`, `"not_loaded":[]`, `"buffer_tokens":0`, `"largest_messages":[`} { // decision 88, additive
		if !strings.Contains(string(body), key) {
			t.Errorf("context lacks %s: %s", key, body)
		}
	}
	var rep orchestrator.ContextReport
	e.into(t, "GET", "/v1/projects/"+pid+"/context", nil, http.StatusOK, &rep)
	if sum := func() (n int64) {
		for _, c := range rep.Categories {
			n += c.Tokens
			var items int64
			for _, it := range c.Items {
				items += it.Tokens
			}
			if items != c.Tokens {
				t.Fatalf("category %s: items sum %d != %d", c.ID, items, c.Tokens)
			}
		}
		return
	}(); sum != rep.UsedTokens {
		t.Fatalf("categories sum %d != used %d", sum, rep.UsedTokens)
	}
	if rep.LastRequest == nil || rep.LastRequest.Input == 0 {
		t.Fatalf("last_request = %+v", rep.LastRequest)
	}
}
