package bridge_test

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/fakeacp"
	"github.com/ndolinschi/Octo/apps/harness/internal/memory"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

type tasksResp struct {
	Tasks []projectstore.Task `json:"tasks"`
}

func (e *env) tasks(t *testing.T, pid string) []projectstore.Task {
	t.Helper()
	var r tasksResp
	e.into(t, "GET", "/v1/projects/"+pid+"/tasks", nil, http.StatusOK, &r)
	return r.Tasks
}

// waitTask polls until pred holds for some task (the digest runs after the turn).
func (e *env) waitTask(t *testing.T, pid string, pred func(projectstore.Task) bool) projectstore.Task {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for {
		for _, k := range e.tasks(t, pid) {
			if pred(k) {
				return k
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("no task matched: %+v", e.tasks(t, pid))
		}
		time.Sleep(30 * time.Millisecond)
	}
}

func (e *env) search(t *testing.T, pid, query string) memory.SearchResult {
	t.Helper()
	var r memory.SearchResult
	e.into(t, "GET", "/v1/projects/"+pid+"/memory/search?q="+urlq(query), nil, http.StatusOK, &r)
	return r
}

func urlq(s string) string { return strings.NewReplacer(" ", "%20", "[", "%5B", "]", "%5D").Replace(s) }

func TestTurnOpensATaskRecordAndTheSideModelDigestsIt(t *testing.T) {
	withDigest(t)
	e := newEnv(t, nil)
	pid, _ := e.v7Project(t, "full")
	stream := e.subscribe(t, pid)
	ask := "quick: make the client retry. [goal: Retry failed requests three times] [quote: make the client retry] " +
		"[fact: Retries use exponential backoff] [decision: back off exponentially]"
	var posted struct{ Message projectstore.Message }
	e.into(t, "POST", "/v1/projects/"+pid+"/messages", map[string]string{"text": ask}, http.StatusAccepted, &posted)
	collectUntilTurnFinished(t, stream)

	// The record exists at once with the harness's fallback goal ...
	first := e.tasks(t, pid)
	if len(first) != 1 || first[0].MessageIDs[0] != posted.Message.ID || first[0].Status != "open" || first[0].Title == "" {
		t.Fatalf("tasks = %+v", first)
	}
	// ... and the digest (a side-model call after the turn) fills it in.
	task := e.waitTask(t, pid, func(k projectstore.Task) bool { return len(k.Facts) == 1 })
	if task.Goal != "Retry failed requests three times" || task.GoalBy != "digest" || len(task.Quotes) != 1 ||
		task.Quotes[0].Text != "make the client retry" || task.Quotes[0].MessageID != posted.Message.ID ||
		len(task.Decisions) != 1 || task.Facts[0].Text != "Retries use exponential backoff" || task.Facts[0].Date == "" {
		t.Fatalf("digested task = %+v", task)
	}
	// The digest call is recorded as usage with role digest (no agent totals).
	log, err := e.dbUsage(pid)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, u := range log {
		found = found || u.Role == "digest"
	}
	if !found {
		t.Fatalf("no usage row with role digest: %+v", log)
	}
	// The record's facts and the message are searchable through the API.
	res := e.search(t, pid, "exponential backoff")
	kinds := map[string]bool{}
	for _, h := range res.Hits {
		kinds[h.Kind] = true
	}
	if !kinds["fact"] || !kinds["message"] {
		t.Fatalf("hits = %+v", res.Hits)
	}
	if res = e.search(t, pid, "retry three times"); !hasKind(res, "task") {
		t.Fatalf("the task record is not searchable: %+v", res.Hits)
	}
}

func (e *env) dbUsage(pid string) ([]projectstore.UsageEntry, error) {
	db, err := e.store.Get(context.Background(), pid)
	if err != nil {
		return nil, err
	}
	return db.UsageLog(context.Background())
}

func TestOrchestratorUsesTheMemoryToolsAndTheAPISeesTheResult(t *testing.T) {
	e := newEnv(t, nil)
	pid, _ := e.v7Project(t, "full")
	stream := e.subscribe(t, pid)
	say := func(text string) projectstore.Message {
		var posted struct{ Message projectstore.Message }
		e.into(t, "POST", "/v1/projects/"+pid+"/messages", map[string]string{"text": text}, http.StatusAccepted, &posted)
		collectUntilTurnFinished(t, stream)
		e.waitIdle(t, pid)
		return posted.Message
	}
	m1 := say("Нужно уложиться в бюджет проекта и не больше")
	// A memory file written by the orchestrator through the tool.
	say("[mem-create: notes/arch.md | architecture decisions | we use sqlite with FTS5 and no ORM]")
	list := struct {
		Files []projectstore.MemoryFile `json:"files"`
		Index string                    `json:"index"`
	}{}
	e.into(t, "GET", "/v1/projects/"+pid+"/memory", nil, http.StatusOK, &list)
	if len(list.Files) != 1 || list.Files[0].Path != "notes/arch.md" || !strings.Contains(list.Index, "notes/arch.md: architecture decisions") {
		t.Fatalf("memory = %+v", list)
	}
	// Search through the orchestrator's tool; the result is in its reply.
	say("[search: бюджета]")
	if got := lastAssistantText(t, e, pid); !strings.Contains(got, fmt.Sprintf(`"id":"%d"`, m1.ID)) || !strings.Contains(got, `"kind":"message"`) {
		t.Fatalf("search reply = %s", got)
	}
	// (A query the orchestrator is asked to run is itself part of the user's message, so the
	// "nothing matches" answer is checked on a word that was never said.)
	if r := e.search(t, pid, "hovercraft eels"); len(r.Hits) != 0 || r.Message != memory.NothingMatches {
		t.Fatalf("an empty search must say so: %+v", r)
	}
	say(fmt.Sprintf("[recall: %d]", m1.ID))
	if got := lastAssistantText(t, e, pid); !strings.Contains(got, "Нужно уложиться в бюджет проекта и не больше") {
		t.Fatalf("recall reply = %s", got)
	}
	say("[task-update: Budget work]")
	if ts := e.tasks(t, pid); !hasTitle(ts, "Budget work") {
		t.Fatalf("task_update did not apply: %+v", ts)
	}
	// The user edits and deletes the file through the API; the index follows.
	e.into(t, "PUT", "/v1/projects/"+pid+"/memory/notes/arch.md", map[string]string{"content": "we now use postgres", "summary": "architecture"}, http.StatusOK, nil)
	if r := e.search(t, pid, "postgres"); len(r.Hits) == 0 {
		t.Fatalf("the edited file is not searchable: %+v", r)
	}
	if r := e.search(t, pid, "sqlite FTS5"); hasKind(r, "file") {
		t.Fatalf("the old content is still indexed: %+v", r)
	}
	var f projectstore.MemoryFile
	e.into(t, "GET", "/v1/projects/"+pid+"/memory/notes/arch.md", nil, http.StatusOK, &f)
	if f.Content != "we now use postgres" {
		t.Fatalf("file = %+v", f)
	}
	e.into(t, "DELETE", "/v1/projects/"+pid+"/memory/notes/arch.md", nil, http.StatusNoContent, nil)
	e.wantError(t, "GET", "/v1/projects/"+pid+"/memory/notes/arch.md", nil, http.StatusNotFound, "not_found")
	if r := e.search(t, pid, "postgres"); hasKind(r, "file") {
		t.Fatalf("a deleted file is still found: %+v", r)
	}
	e.wantError(t, "PUT", "/v1/projects/"+pid+"/memory/..%2Fescape.md", map[string]string{"content": "x", "summary": "s"}, http.StatusBadRequest, "invalid_request")
	e.wantError(t, "PUT", "/v1/projects/"+pid+"/memory/INDEX.md", map[string]string{"content": "x", "summary": "s"}, http.StatusBadRequest, "invalid_request")
	e.wantError(t, "GET", "/v1/projects/"+pid+"/memory/search", nil, http.StatusBadRequest, "invalid_request")
	var evs int
	for len(stream) > 0 {
		ev := <-stream
		if ev.Type == "memory.updated" || ev.Type == "task.updated" {
			evs++
		}
	}
	if evs == 0 {
		t.Fatal("no task.updated / memory.updated events were published")
	}
}

func hasTitle(ts []projectstore.Task, title string) bool {
	for _, k := range ts {
		if k.Title == title {
			return true
		}
	}
	return false
}

func hasKind(r memory.SearchResult, kind string) bool {
	for _, h := range r.Hits {
		if h.Kind == kind {
			return true
		}
	}
	return false
}

func lastAssistantText(t *testing.T, e *env, pid string) string {
	t.Helper()
	var proj struct {
		OrchestratorAgentID string `json:"orchestrator_agent_id"`
	}
	e.into(t, "GET", "/v1/projects/"+pid, nil, http.StatusOK, &proj)
	var msgs struct{ Messages []projectstore.Message }
	e.into(t, "GET", "/v1/projects/"+pid+"/agents/"+proj.OrchestratorAgentID+"/messages", nil, http.StatusOK, &msgs)
	for i := len(msgs.Messages) - 1; i >= 0; i-- {
		m := msgs.Messages[i]
		if m.Role == "assistant" {
			var b strings.Builder
			for _, c := range m.Content {
				if c.Type == "text" && c.Text != nil {
					b.WriteString(*c.Text)
				}
			}
			if strings.Contains(b.String(), "Memory result:") {
				return b.String()
			}
		}
	}
	return ""
}

func TestSecretsNeverReachMemoryThroughATurn(t *testing.T) {
	withDigest(t)
	e := newEnv(t, nil)
	pid, _ := e.v7Project(t, "full")
	e.into(t, "PUT", "/v1/projects/"+pid+"/secrets/api_key", map[string]string{"value": testSecret}, http.StatusNoContent, nil)
	stream := e.subscribe(t, pid)
	e.into(t, "POST", "/v1/projects/"+pid+"/messages", map[string]string{"text": "quick: remember that the key is " + testSecret +
		" [fact: the key is " + testSecret + "] [decision: store " + testSecret + "]"}, http.StatusAccepted, nil)
	collectUntilTurnFinished(t, stream)
	e.waitTask(t, pid, func(k projectstore.Task) bool { return len(k.Facts) == 1 })
	e.into(t, "PUT", "/v1/projects/"+pid+"/memory/leak.md", map[string]string{"content": "key " + testSecret, "summary": "holds " + testSecret}, http.StatusOK, nil)
	for _, path := range []string{"/tasks", "/memory", "/memory/leak.md", "/memory/search?q=key", "/memory/search?q=" + testSecret, "/memory/search?q=remember"} {
		_, raw := e.do(t, "GET", "/v1/projects/"+pid+path, nil)
		if strings.Contains(string(raw), testSecret) {
			t.Errorf("GET %s contains the secret: %s", path, raw)
		}
	}
}

func TestACPOrchestratorGetsTheMemoryToolsOverMCP(t *testing.T) {
	e := newACPEnv(t, nil, nil)
	p := e.acpProject(t)
	tr := e.ask(t, p, fakeacp.MarkerMCPSpawn+" look")
	if tr.status != "completed" {
		t.Fatalf("turn = %s %v", tr.status, tr.errMsg)
	}
	text := e.lastText(t, p)
	for _, name := range []string{"task_update", "memory", "memory_search", "recall_message"} {
		if !strings.Contains(text, name) {
			t.Errorf("the MCP tool list lacks %s: %s", name, text)
		}
	}
	// The record of the turn exists (no side model call for an ACP-only run: the fallback goal).
	ts := e.tasks(t, p.ID)
	if len(ts) != 1 || ts[0].GoalBy != "harness" || !strings.Contains(ts[0].Goal, "look") {
		t.Fatalf("tasks = %+v", ts)
	}
}
