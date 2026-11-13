package orchestrator_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/approval"
	"github.com/ndolinschi/Octo/apps/harness/internal/project"
)

// toolRun scripts a one-level delegation in which the sub-agent makes one tool
// call and then reports what came back; it records the tool lists and the
// call's result.
type toolRun struct {
	mu          sync.Mutex
	orchTools   []string
	subTools    []string
	result      string
	resultError bool
	calls       int
}

func (tr *toolRun) llm(tool string, input map[string]any) http.Handler {
	raw, _ := json.Marshal(input)
	return fakeLLM(func(w http.ResponseWriter, hr *http.Request, req fakeReq) {
		names := make([]string, len(req.Tools))
		for i, t := range req.Tools {
			names[i] = t.Name
		}
		if req.isOrchestrator() {
			tr.mu.Lock()
			tr.orchTools = names
			tr.mu.Unlock()
		}
		switch {
		case req.isOrchestrator() && len(req.Msgs) == 1:
			respond(w, "tool_use", spawnBlock("t1", "worker"))
		case req.isOrchestrator():
			respond(w, "end_turn", textBlock("done"))
		case len(req.Msgs) == 1:
			tr.mu.Lock()
			tr.subTools = names
			tr.calls++
			tr.mu.Unlock()
			respond(w, "tool_use", `{"type":"tool_use","id":"c1","name":`+quote(tool)+`,"input":`+string(raw)+`}`)
		default:
			var last struct {
				Content []struct {
					Type    string `json:"type"`
					IsError bool   `json:"is_error"`
					Content any    `json:"content"`
				} `json:"content"`
			}
			_ = json.Unmarshal(req.Msgs[len(req.Msgs)-1], &last)
			tr.mu.Lock()
			for _, c := range last.Content {
				if c.Type == "tool_result" {
					tr.resultError = c.IsError
					switch v := c.Content.(type) {
					case string:
						tr.result = v
					case []any:
						for _, p := range v {
							if m, ok := p.(map[string]any); ok {
								tr.result += m["text"].(string)
							}
						}
					}
				}
			}
			tr.mu.Unlock()
			respond(w, "end_turn", textBlock("report"))
		}
	})
}

func quote(s string) string { b, _ := json.Marshal(s); return string(b) }

func (r *rig) projectWith(t *testing.T, in project.Input) (string, string) {
	t.Helper()
	name, depth := "p", 2
	dir := t.TempDir()
	in.Name, in.MaxDepth = &name, &depth
	in.Folders = &[]project.FolderInput{{Path: dir}}
	p, err := r.svc.Create(context.Background(), in)
	if err != nil {
		t.Fatal(err)
	}
	return p.ID, dir
}

func sp(s string) *string { return &s }
func yes() *bool          { b := true; return &b }

func has(l []string, s string) bool {
	for _, x := range l {
		if x == s {
			return true
		}
	}
	return false
}

func TestEditAndGlobAreOfferedToTheOrchestratorAndSubAgents(t *testing.T) {
	tr := &toolRun{}
	r := newRig(t, tr.llm("list_dir", map[string]any{}))
	pid, _ := r.projectWith(t, project.Input{})
	if st := r.run(t, pid, "go", nil); st != "completed" {
		t.Fatalf("turn = %s", st)
	}
	for who, names := range map[string][]string{"orchestrator": tr.orchTools, "sub-agent": tr.subTools} {
		for _, want := range []string{"edit", "glob", "read_file", "list_dir"} {
			if !has(names, want) {
				t.Errorf("%s lacks %s: %v", who, want, names)
			}
		}
		if has(names, "web_fetch") {
			t.Errorf("%s has web_fetch while the network is off: %v", who, names)
		}
	}
	if has(tr.orchTools, "write_file") || has(tr.orchTools, "bash") || !has(tr.subTools, "write_file") || !has(tr.subTools, "bash") {
		t.Errorf("the orchestrator still has no write_file/bash and sub-agents keep them: %v / %v", tr.orchTools, tr.subTools)
	}
}

func TestWebFetchIsOfferedOnlyWhenTheNetworkIsOn(t *testing.T) {
	tr := &toolRun{}
	r := newRig(t, tr.llm("list_dir", map[string]any{}))
	pid, _ := r.projectWith(t, project.Input{Network: sp("on")})
	if st := r.run(t, pid, "go", nil); st != "completed" {
		t.Fatalf("turn = %s", st)
	}
	if !has(tr.orchTools, "web_fetch") || !has(tr.subTools, "web_fetch") {
		t.Fatalf("network on: web_fetch missing: %v / %v", tr.orchTools, tr.subTools)
	}
	// Switching it off applies to the next turn.
	if _, err := r.svc.Update(context.Background(), pid, project.Input{Network: sp("off")}); err != nil {
		t.Fatal(err)
	}
	waitTurn(t, r, pid)
	if st := r.run(t, pid, "again", nil); st != "completed" {
		t.Fatalf("turn = %s", st)
	}
	if has(tr.orchTools, "web_fetch") {
		t.Fatalf("network off again: %v", tr.orchTools)
	}
	if _, err := r.svc.Update(context.Background(), pid, project.Input{Network: sp("sometimes")}); err == nil {
		t.Fatal("a bad network value must be refused")
	}
}

func TestEditToolRecordsTheChangeLikeWriteFile(t *testing.T) {
	tr := &toolRun{}
	r := newRig(t, tr.llm("edit", map[string]any{"path": "a.txt", "old_string": "beta", "new_string": "BETA"}))
	pid, dir := r.projectWith(t, project.Input{})
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("alpha\nbeta\ngamma\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if st := r.run(t, pid, "edit it", nil); st != "completed" {
		t.Fatalf("turn = %s", st)
	}
	if got, _ := os.ReadFile(filepath.Join(dir, "a.txt")); string(got) != "alpha\nBETA\ngamma\n" {
		t.Fatalf("file = %q (result %q)", got, tr.result)
	}
	turns, err := r.svc.Changes(context.Background(), pid, 0)
	if err != nil || len(turns) != 1 || len(turns[0].Files) != 1 {
		t.Fatalf("changes = %+v %v", turns, err)
	}
	f := turns[0].Files[0]
	if f.Path != "a.txt" || f.Kind != "modified" || f.Added == nil || *f.Added != 1 || f.Removed == nil || *f.Removed != 1 {
		t.Fatalf("change = %+v", f)
	}
	d, err := r.svc.Change(context.Background(), pid, f.ChangeIDs[0])
	if err != nil || !d.DiffAvailable {
		t.Fatalf("detail = %+v %v", d, err)
	}
}

func TestEditNonUniqueMatchIsAToolErrorAndNeverAsksOrWrites(t *testing.T) {
	tr := &toolRun{}
	r := newRig(t, tr.llm("edit", map[string]any{"path": "a.txt", "old_string": "x", "new_string": "y"}))
	pid, dir := r.projectWith(t, project.Input{Access: sp("supervised")})
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("x x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if st := r.run(t, pid, "go", nil); st != "completed" { // no approval may block it
		t.Fatalf("turn = %s", st)
	}
	if !tr.resultError || !strings.Contains(tr.result, "matches 2 places") {
		t.Fatalf("result = %q error=%v", tr.result, tr.resultError)
	}
	if got, _ := os.ReadFile(filepath.Join(dir, "a.txt")); string(got) != "x x\n" {
		t.Fatalf("file changed: %q", got)
	}
}

// answerApprovals polls until n approvals have been seen, answers each with
// answer(a) and returns them.
func (r *rig) answerApprovals(t *testing.T, pid string, n int, answer func(a approval.Approval) project.ApprovalAnswer) []approval.Approval {
	t.Helper()
	var seen []approval.Approval
	deadline := time.Now().Add(15 * time.Second)
	for len(seen) < n && time.Now().Before(deadline) {
		list, _ := r.svc.Approvals(context.Background(), pid)
		for _, a := range list {
			seen = append(seen, a)
			if err := r.svc.ResolveApproval(context.Background(), pid, a.ID, answer(a)); err != nil {
				t.Fatalf("resolve %s: %v", a.ID, err)
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	if len(seen) < n {
		t.Fatalf("saw %d approvals, want %d", len(seen), n)
	}
	return seen
}

func TestEditApprovalShowsTheDiffAndADenialReachesTheAgent(t *testing.T) {
	tr := &toolRun{}
	r := newRig(t, tr.llm("edit", map[string]any{"path": "a.txt", "old_string": "beta", "new_string": "BETA"}))
	pid, dir := r.projectWith(t, project.Input{Access: sp("supervised")})
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("alpha\nbeta\ngamma\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	done := make(chan []approval.Approval, 1)
	go func() {
		done <- r.answerApprovals(t, pid, 1, func(approval.Approval) project.ApprovalAnswer {
			return project.ApprovalAnswer{Decision: "deny", Note: "use the other file"}
		})
	}()
	if st := r.run(t, pid, "edit it", nil); st != "completed" {
		t.Fatalf("turn = %s", st)
	}
	ap := (<-done)[0]
	if ap.Kind != approval.KindWrite || ap.Tool != "edit" || ap.Title != "Edit a.txt" || ap.Detail.Path != "a.txt" {
		t.Fatalf("approval = %+v", ap)
	}
	for _, want := range []string{"--- a/a.txt", "-beta", "+BETA", " alpha"} {
		if !strings.Contains(ap.Detail.Patch, want) {
			t.Errorf("patch lacks %q:\n%s", want, ap.Detail.Patch)
		}
	}
	if ap.Detail.Diff == nil || ap.Detail.Diff.Added != 1 || ap.Detail.Diff.Removed != 1 {
		t.Errorf("diff stat = %+v", ap.Detail.Diff)
	}
	if tr.result != "Denied by the user: use the other file" || !tr.resultError {
		t.Fatalf("the agent saw %q (error %v)", tr.result, tr.resultError)
	}
	if got, _ := os.ReadFile(filepath.Join(dir, "a.txt")); string(got) != "alpha\nbeta\ngamma\n" {
		t.Fatalf("a denied edit changed the file: %q", got)
	}
}

func TestWriteFileApprovalAlsoCarriesThePatch(t *testing.T) {
	tr := &toolRun{}
	r := newRig(t, tr.llm("write_file", map[string]any{"path": "n.txt", "content": "hello\n"}))
	pid, dir := r.projectWith(t, project.Input{Access: sp("supervised")})
	done := make(chan []approval.Approval, 1)
	go func() {
		done <- r.answerApprovals(t, pid, 1, func(approval.Approval) project.ApprovalAnswer { return project.ApprovalAnswer{Decision: "allow"} })
	}()
	if st := r.run(t, pid, "write it", nil); st != "completed" {
		t.Fatalf("turn = %s", st)
	}
	ap := (<-done)[0]
	if ap.Tool != "write_file" || !strings.Contains(ap.Detail.Patch, "+hello") {
		t.Fatalf("approval = %+v", ap)
	}
	if got, _ := os.ReadFile(filepath.Join(dir, "n.txt")); string(got) != "hello\n" {
		t.Fatalf("file = %q", got)
	}
}

func TestWebFetchThroughAProject(t *testing.T) {
	var hits int
	site := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		w.Header().Set("Content-Type", "text/html")
		w.Write([]byte("<html><body><h1>Docs</h1><p>The answer is 42.</p></body></html>"))
	}))
	defer site.Close()

	t.Run("private address refused unless the project allows it", func(t *testing.T) {
		tr := &toolRun{}
		r := newRig(t, tr.llm("web_fetch", map[string]any{"url": site.URL}))
		pid, _ := r.projectWith(t, project.Input{Network: sp("on")})
		if st := r.run(t, pid, "go", nil); st != "completed" {
			t.Fatalf("turn = %s", st)
		}
		if !tr.resultError || !strings.Contains(tr.result, "private") || hits != 0 {
			t.Fatalf("result %q error=%v hits=%d", tr.result, tr.resultError, hits)
		}
	})
	t.Run("allowed: text comes back", func(t *testing.T) {
		tr := &toolRun{}
		r := newRig(t, tr.llm("web_fetch", map[string]any{"url": site.URL + "/page"}))
		pid, _ := r.projectWith(t, project.Input{Network: sp("on"), NetworkPrivate: yes()})
		if st := r.run(t, pid, "go", nil); st != "completed" {
			t.Fatalf("turn = %s", st)
		}
		if tr.resultError || !strings.Contains(tr.result, "The answer is 42.") || strings.Contains(tr.result, "<p>") {
			t.Fatalf("result %q error=%v", tr.result, tr.resultError)
		}
	})
	t.Run("supervised: every fetch is an approval, and a denial sends nothing", func(t *testing.T) {
		before := hits
		tr := &toolRun{}
		r := newRig(t, tr.llm("web_fetch", map[string]any{"url": site.URL + "/secret"}))
		pid, _ := r.projectWith(t, project.Input{Network: sp("on"), NetworkPrivate: yes(), Access: sp("supervised")})
		done := make(chan []approval.Approval, 1)
		go func() {
			done <- r.answerApprovals(t, pid, 1, func(approval.Approval) project.ApprovalAnswer {
				return project.ApprovalAnswer{Decision: "deny", Note: "no network today"}
			})
		}()
		if st := r.run(t, pid, "go", nil); st != "completed" {
			t.Fatalf("turn = %s", st)
		}
		ap := (<-done)[0]
		if ap.Kind != approval.KindNetwork || ap.Tool != "web_fetch" || ap.Detail.URL != site.URL+"/secret" || ap.SuggestedRule == nil || ap.SuggestedRule.Match != "127.0.0.1" {
			t.Fatalf("approval = %+v", ap)
		}
		if hits != before || tr.result != "Denied by the user: no network today" {
			t.Fatalf("hits %d->%d, agent saw %q", before, hits, tr.result)
		}
	})
}
