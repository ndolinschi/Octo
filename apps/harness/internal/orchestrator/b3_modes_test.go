package orchestrator_test

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/config"
	"github.com/ndolinschi/Octo/apps/harness/internal/events"
	"github.com/ndolinschi/Octo/apps/harness/internal/fakeacp"
	"github.com/ndolinschi/Octo/apps/harness/internal/orchestrator"
	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
	"github.com/ndolinschi/Octo/apps/harness/internal/project"
)

// runWith starts a turn with options and waits for turn.finished.
func (r *rig) runWith(t *testing.T, pid, text string, opts orchestrator.StartOpts) string {
	t.Helper()
	ch, cancel := r.hub.Subscribe(pid)
	defer cancel()
	if _, err := r.orch.StartWith(context.Background(), pid, text, opts); err != nil {
		t.Fatal(err)
	}
	for ev := range ch {
		if ev.Type == events.TurnFinished {
			var f struct{ Status string }
			_ = json.Unmarshal(ev.Data, &f)
			waitTurn(t, r, pid)
			return f.Status
		}
	}
	t.Fatal("stream closed")
	return ""
}

func ReadOnlyCases() map[string]bool {
	return map[string]bool{
		"ls -la": true, "cat README.md": true, "git status": true, "git diff --stat": true, "git log --oneline -5": true,
		"grep -rn foo src": true, "/usr/bin/git status": true, "rg foo": true, "find . -name '*.go'": true,
		"rm -rf x": false, "git commit -m x": false, "git push": false, "git checkout main": false, "git -c core.pager=x log": false,
		"git diff --output=out.patch": false, "git status && rm -rf x": false, "ls; rm x": false, "cat a > b": false, "echo hi > f": false,
		"find . -delete": false, "find . -exec rm {} +": false, "rg --pre ./x foo": false, "sort -o out in": false, "sed -i s/a/b/ f": false,
		"bash -c 'ls'": false, "pnpm test": false, "curl http://x": false, "cat $(echo /etc/passwd)": false, "": false, "tee out": false,
		"git": false, "npm install": false, "python script.py": false, "mkdir x": false, "touch x": false, "cp a b": false, "mv a b": false,
	}
}

func TestReadOnlyCommandAllowList(t *testing.T) {
	for cmd, want := range ReadOnlyCases() {
		if got := orchestrator.ReadOnlyCommand(cmd); got != want {
			t.Errorf("ReadOnlyCommand(%q) = %v, want %v", cmd, got, want)
		}
	}
}

// modeLLM scripts the orchestrator of a mode test: request 1 calls the given
// tools in one message, the next answers with answer; the tool results and
// system prompts it saw are recorded.
type modeLLM struct {
	mu      sync.Mutex
	systems []string
	results []string
	calls   [][2]string // name, input JSON
	answer  string
	count   int
}

func (m *modeLLM) handler() http.Handler {
	return fakeLLM(func(w http.ResponseWriter, hr *http.Request, req fakeReq) {
		var blocks []struct {
			Text string `json:"text"`
		}
		_ = json.Unmarshal(req.System, &blocks)
		sys := ""
		for _, b := range blocks {
			sys += b.Text
		}
		m.mu.Lock()
		if req.isOrchestrator() {
			m.systems = append(m.systems, sys)
		}
		m.mu.Unlock()
		if !req.isOrchestrator() {
			respond(w, "end_turn", textBlock("sub report"))
			return
		}
		last := req.Msgs[len(req.Msgs)-1]
		var lm struct {
			Role    string `json:"role"`
			Content []struct {
				Type    string `json:"type"`
				Content any    `json:"content"`
			} `json:"content"`
		}
		_ = json.Unmarshal(last, &lm)
		hasResult := false
		for _, c := range lm.Content {
			if c.Type == "tool_result" {
				hasResult = true
				s, _ := c.Content.(string)
				if arr, ok := c.Content.([]any); ok {
					for _, p := range arr {
						s += p.(map[string]any)["text"].(string)
					}
				}
				m.mu.Lock()
				m.results = append(m.results, s)
				m.mu.Unlock()
			}
		}
		m.mu.Lock()
		calls := m.calls
		answer := m.answer
		m.mu.Unlock()
		if hasResult || len(calls) == 0 {
			respond(w, "end_turn", textBlock(answer))
			return
		}
		var uses []string
		for i, c := range calls {
			uses = append(uses, `{"type":"tool_use","id":"u`+string(rune('a'+i))+`","name":`+quote(c[0])+`,"input":`+c[1]+`}`)
		}
		respond(w, "tool_use", uses...)
	})
}

func TestAskModeRefusesWritesAndDelegationInTheToolGate(t *testing.T) {
	m := &modeLLM{answer: "ok", calls: [][2]string{
		{"edit", `{"path":"a.txt","old_string":"one","new_string":"two"}`},
		{"spawn_agent", `{"role":"W","title":"w","task":"do","tier":"fast"}`},
		{"read_file", `{"path":"a.txt"}`},
	}}
	r := newRig(t, m.handler())
	pid, dir := r.projectWith(t, project.Input{Mode: sp("ask")})
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("one\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if st := r.runWith(t, pid, "change it", orchestrator.StartOpts{}); st != "completed" {
		t.Fatalf("turn = %s", st)
	}
	if got, _ := os.ReadFile(filepath.Join(dir, "a.txt")); string(got) != "one\n" {
		t.Fatalf("an ask turn changed a file: %q", got)
	}
	if len(r.agents(t, pid)) != 1 {
		t.Fatalf("an ask turn delegated: %d agents", len(r.agents(t, pid)))
	}
	refused := 0
	for _, res := range m.results {
		if strings.HasPrefix(res, "Refused:") && strings.Contains(res, "ask mode") {
			refused++
		}
	}
	if refused != 2 || !strings.Contains(strings.Join(m.results, "|"), "one") {
		t.Fatalf("results = %q: want two refusals and the read to work", m.results)
	}
	if !strings.Contains(m.systems[0], "Mode: ASK") {
		t.Error("the system prompt does not say the mode")
	}
}

func TestPerTurnModeOverridesTheProjectMode(t *testing.T) {
	m := &modeLLM{answer: "ok", calls: [][2]string{{"edit", `{"path":"a.txt","old_string":"one","new_string":"two"}`}}}
	r := newRig(t, m.handler())
	pid, dir := r.projectWith(t, project.Input{Mode: sp("ask")})
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("one\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if st := r.runWith(t, pid, "change it", orchestrator.StartOpts{Mode: "agent"}); st != "completed" {
		t.Fatalf("turn = %s", st)
	}
	if got, _ := os.ReadFile(filepath.Join(dir, "a.txt")); string(got) != "two\n" {
		t.Fatalf("the agent-mode turn could not edit: %q (%q)", got, m.results)
	}
	if strings.Contains(m.systems[0], "Mode: ASK") {
		t.Error("the override still got the ask prompt")
	}
	// And the project mode is unchanged.
	if p, _ := r.svc.Get(context.Background(), pid); p.Mode != "ask" {
		t.Fatalf("project mode = %q", p.Mode)
	}
}

func TestPlanModeStoresAPlanAndApprovingItStartsAnAgentTurnWithItPinned(t *testing.T) {
	m := &modeLLM{answer: "1. edit a.txt\n2. run the tests", calls: nil}
	r := newRig(t, m.handler())
	pid, dir := r.projectWith(t, project.Input{})
	if _, err := r.svc.LatestPlan(context.Background(), pid); err == nil {
		t.Fatal("a project without plans has no latest plan")
	}
	if st := r.runWith(t, pid, "plan the change", orchestrator.StartOpts{Mode: "plan"}); st != "completed" {
		t.Fatalf("turn = %s", st)
	}
	if !strings.Contains(m.systems[0], "Mode: PLAN") {
		t.Error("the system prompt does not ask for a plan")
	}
	p, err := r.svc.LatestPlan(context.Background(), pid)
	if err != nil || p.Status != "pending" || p.Text != "1. edit a.txt\n2. run the tests" || p.TurnID == 0 {
		t.Fatalf("plan = %+v %v", p, err)
	}
	// Approving starts an agent turn (the next request gets the plan pinned, and may edit).
	m.mu.Lock()
	m.answer, m.calls = "done", [][2]string{{"edit", `{"path":"a.txt","old_string":"one","new_string":"two"}`}}
	m.mu.Unlock()
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("one\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	ch, cancel := r.hub.Subscribe(pid)
	defer cancel()
	got, msg, err := r.svc.ApprovePlan(context.Background(), pid, p.ID)
	if err != nil || got.Status != "approved" || msg.ID == 0 {
		t.Fatalf("approve = %+v %+v %v", got, msg, err)
	}
	for ev := range ch {
		if ev.Type == events.TurnFinished {
			break
		}
	}
	waitTurn(t, r, pid)
	last := m.systems[len(m.systems)-1]
	if !strings.Contains(last, "Approved plan (pinned") || !strings.Contains(last, "1. edit a.txt") || strings.Contains(last, "Mode: PLAN") {
		t.Fatalf("the approved turn's system prompt:\n%s", last)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "a.txt")); string(b) != "two\n" {
		t.Fatalf("the approved turn did not run in agent mode: %q", b)
	}
	if _, _, err := r.svc.ApprovePlan(context.Background(), pid, p.ID); err == nil || !strings.Contains(err.Error(), "plan_not_pending") {
		t.Fatalf("a second approval: %v", err)
	}
	if _, _, err := r.svc.ApprovePlan(context.Background(), pid, "pln_nope"); err == nil || !strings.Contains(err.Error(), "not_found") {
		t.Fatalf("unknown plan: %v", err)
	}
}

func TestModeValidationAndQueueKeepsTheMessagesMode(t *testing.T) {
	r := newRig(t, (&modeLLM{answer: "ok"}).handler())
	pid, _ := r.projectWith(t, project.Input{})
	bad := "sometimes"
	if _, _, err := r.svc.PostMessage(context.Background(), pid, "x", &bad); err == nil {
		t.Fatal("a bad mode must be refused")
	}
	if _, err := r.svc.Update(context.Background(), pid, project.Input{Mode: &bad}); err == nil {
		t.Fatal("a bad project mode must be refused")
	}
	if _, err := r.svc.Create(context.Background(), project.Input{Name: &bad, Mode: &bad}); err == nil {
		t.Fatal("a bad mode must be refused on create")
	}
}

func modesAgent() plugins.Agent {
	a := fakeAgent("fake", true)
	a.Launch.Env[fakeacp.EnvModes] = "1"
	a.Launch.Env[fakeacp.EnvUniqueSessions] = "1"
	return a
}

func (r *rig) lastOrchestratorText(t *testing.T, pid string) string {
	t.Helper()
	db, _ := r.store.Get(context.Background(), pid)
	orch, _ := db.Orchestrator(context.Background())
	msgs := r.transcript(t, pid, orch.ID)
	for i := len(msgs) - 1; i >= 0; i-- {
		if msgs[i].Role == "assistant" {
			var s string
			for _, b := range msgs[i].Content {
				if b.Type == "text" && b.Text != nil {
					s += *b.Text
				}
			}
			return s
		}
	}
	return ""
}

func TestACPOrchestratorUsesTheAgentsOwnModes(t *testing.T) {
	r := newACPRig(t, (&modeLLM{}).handler(), modesAgent())
	svc := r.svcWithAgents(t, modesAgent())
	r.svc = svc
	name := "p"
	p, err := svc.Create(context.Background(), project.Input{Name: &name, Folders: &[]project.FolderInput{{Path: t.TempDir()}},
		Models: &config.Models{Orchestrator: "acp:fake"}})
	if err != nil {
		t.Fatal(err)
	}
	pid := p.ID
	cases := []struct{ mode, want string }{{"ask", "mode=ask"}, {"plan", "mode=plan"}, {"agent", "mode=default"}}
	for _, c := range cases {
		if st := r.runWith(t, pid, "[mode] which?", orchestrator.StartOpts{Mode: c.mode}); st != "completed" {
			t.Fatalf("%s: turn = %s", c.mode, st)
		}
		if got := r.lastOrchestratorText(t, pid); !strings.Contains(got, c.want) {
			t.Fatalf("mode %s: the agent said %q, want %q", c.mode, got, c.want)
		}
	}
}

func TestACPWithoutAdvertisedModesGetsItsWritesDenied(t *testing.T) {
	// The default scripted agent advertises no modes: the harness denies instead.
	r := newACPRig(t, (&modeLLM{}).handler(), fakeAgent("fake", true))
	svc := r.svcWithAgents(t, fakeAgent("fake", true))
	r.svc = svc
	dir := t.TempDir()
	name := "p"
	p, err := svc.Create(context.Background(), project.Input{Name: &name, Folders: &[]project.FolderInput{{Path: dir}},
		Models: &config.Models{Orchestrator: "acp:fake"}})
	if err != nil {
		t.Fatal(err)
	}
	pid := p.ID
	if st := r.runWith(t, pid, "[fswrite] write it", orchestrator.StartOpts{Mode: "plan"}); st != "completed" {
		t.Fatalf("turn = %s", st)
	}
	if got := r.lastOrchestratorText(t, pid); !strings.Contains(got, "fswrite refused: Refused:") || !strings.Contains(got, "plan mode") {
		t.Fatalf("the agent said %q", got)
	}
	if _, err := os.Stat(filepath.Join(dir, fakeacp.WriteFile)); err == nil {
		t.Fatal("a plan turn wrote a file through fs/write_text_file")
	}
	// A permission request for a command is denied in a read-only mode; the agent mode still allows it.
	if st := r.runWith(t, pid, "[perm] run the tests", orchestrator.StartOpts{Mode: "ask"}); st != "completed" {
		t.Fatalf("turn = %s", st)
	}
	if _, err := os.Stat(filepath.Join(dir, fakeacp.PermFile)); err == nil {
		t.Fatal("an ask turn ran the agent's command")
	}
	if st := r.runWith(t, pid, "[fswrite] write it", orchestrator.StartOpts{Mode: "agent"}); st != "completed" {
		t.Fatalf("turn = %s", st)
	}
	if _, err := os.Stat(filepath.Join(dir, fakeacp.WriteFile)); err != nil {
		t.Fatalf("an agent turn could not write: %v", err)
	}
}
