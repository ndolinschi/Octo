package orchestrator_test

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/events"
	"github.com/ndolinschi/Octo/apps/harness/internal/fakerouter"
	"github.com/ndolinschi/Octo/apps/harness/internal/orchestrator"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

// sideReq is one Messages request as the mock model saw it.
type sideReq struct {
	Model    string
	Tools    []string
	Messages []map[string]any
	Body     string
}

func (q sideReq) isSide() bool { return strings.Contains(q.Body, "You answer a side question") }

// toolResults returns the tool_result blocks of the last message.
func (q sideReq) toolResults() []map[string]any {
	var out []map[string]any
	if len(q.Messages) == 0 {
		return nil
	}
	blocks, _ := q.Messages[len(q.Messages)-1]["content"].([]any)
	for _, b := range blocks {
		if m, _ := b.(map[string]any); m["type"] == "tool_result" {
			out = append(out, m)
		}
	}
	return out
}

// scripted is a mock model whose side requests are answered by side(), and
// whose orchestrator and child requests are answered by other().
type scripted struct {
	mu   sync.Mutex
	seen []sideReq
	side func(q sideReq, n int) string // "stop|block\x00block": the stop reason and the content blocks
	rest func(q sideReq, isOrch bool) string
}

func (s *scripted) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	raw, _ := io.ReadAll(r.Body)
	var body struct {
		Model    string                  `json:"model"`
		Stream   bool                    `json:"stream"`
		Tools    []struct{ Name string } `json:"tools"`
		Messages []map[string]any        `json:"messages"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	q := sideReq{Model: body.Model, Messages: body.Messages, Body: string(raw)}
	for _, t := range body.Tools {
		q.Tools = append(q.Tools, t.Name)
	}
	s.mu.Lock()
	s.seen = append(s.seen, q)
	n := 0
	for _, o := range s.seen {
		if o.isSide() {
			n++
		}
	}
	s.mu.Unlock()
	var out string
	switch {
	case q.isSide() && s.side != nil:
		out = s.side(q, n)
	case s.rest != nil:
		out = s.rest(q, slices.Contains(q.Tools, "save_note"))
	default:
		out = "end_turn|" + textBlock("plain answer")
	}
	stop, blocks, _ := strings.Cut(out, "|")
	respondAs(w, fakeReq{Stream: body.Stream}, stop, strings.Split(blocks, "\x00")...)
}

func (s *scripted) sideRequests() []sideReq {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []sideReq
	for _, q := range s.seen {
		if q.isSide() {
			out = append(out, q)
		}
	}
	return out
}

func toolUse(id, name, input string) string {
	return fmt.Sprintf(`{"type":"tool_use","id":%q,"name":%q,"input":%s}`, id, name, input)
}

type sideEvent struct {
	Type   string                    `json:"type"`
	SideID string                    `json:"side_id"`
	Text   string                    `json:"text"`
	Error  string                    `json:"error"`
	Msg    *projectstore.SideMessage `json:"message"`
}

// awaitSide waits for the side.done or side.error of sideID; deltas on the way are returned too.
func awaitSide(t *testing.T, ch <-chan events.Event, sideID string) (final sideEvent, deltas []string) {
	t.Helper()
	timeout := time.After(20 * time.Second)
	for {
		select {
		case ev, ok := <-ch:
			if !ok {
				t.Fatal("event stream closed")
			}
			if !strings.HasPrefix(ev.Type, "side.") {
				continue
			}
			var e sideEvent
			if err := json.Unmarshal(ev.Data, &e); err != nil {
				t.Fatal(err)
			}
			if e.SideID != sideID {
				t.Fatalf("event %s carries side_id %q, want %q", ev.Type, e.SideID, sideID)
			}
			switch ev.Type {
			case events.SideDelta:
				deltas = append(deltas, e.Text)
			case events.SideDone, events.SideError:
				return e, deltas
			}
		case <-timeout:
			t.Fatal("timed out waiting for side.done")
		}
	}
}

func (a *api) ask(pid, text string) (int, string) {
	a.t.Helper()
	status, body := a.do("POST", "/v1/projects/"+pid+"/side", map[string]string{"text": text})
	id, _ := body["side_id"].(string)
	return status, id
}

func (a *api) sideList(pid string) []map[string]any {
	a.t.Helper()
	status, body := a.do("GET", "/v1/projects/"+pid+"/side", nil)
	if status != 200 {
		a.t.Fatalf("list side = %d", status)
	}
	var out []map[string]any
	for _, m := range body["messages"].([]any) {
		out = append(out, m.(map[string]any))
	}
	return out
}

func orchestratorJSON(t *testing.T, r *rig, pid string) string {
	t.Helper()
	orch := r.agents(t, pid)[0]
	msgs, err := r.svc.Messages(context.Background(), pid, orch.ID)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(msgs)
	return string(raw)
}

func TestSideQuestion(t *testing.T) {
	for _, stream := range []bool{false, true} {
		t.Run(fmt.Sprintf("stream=%v", stream), func(t *testing.T) {
			llm := &scripted{side: func(q sideReq, n int) string {
				if n == 1 {
					return "tool_use|" + toolUse("s1", "search_files", `{"pattern":"needle"}`)
				}
				return "end_turn|" + textBlock(fmt.Sprintf("answer %d", len(q.Messages)))
			}}
			r := newRigWith(t, llm, orchestrator.Options{Stream: stream})
			pid := r.project(t, 1)
			a := r.api(t)
			if st := r.run(t, pid, "quick hello", nil); st != "completed" {
				t.Fatalf("turn = %s", st)
			}
			orchBefore := orchestratorJSON(t, r, pid)
			agentsBefore := r.agents(t, pid)
			ch, cancel := r.hub.Subscribe(pid)
			defer cancel()

			status, id := a.ask(pid, "where is the needle?")
			if status != 202 || !strings.HasPrefix(id, "sid_") {
				t.Fatalf("ask = %d %q", status, id)
			}
			done, deltas := awaitSide(t, ch, id)
			if done.Type != "side.done" || done.Msg == nil || done.Msg.Role != "assistant" || done.Msg.SideID != id || !strings.HasPrefix(done.Msg.Text, "answer ") {
				t.Fatalf("final event = %+v", done)
			}
			if stream && len(deltas) == 0 {
				t.Fatal("no side.delta while streaming")
			}
			if !stream && len(deltas) != 0 {
				t.Fatalf("side.delta without streaming: %v", deltas)
			}

			// Nothing reached the orchestrator.
			if got := orchestratorJSON(t, r, pid); got != orchBefore {
				t.Fatalf("orchestrator messages changed:\nbefore %s\nafter  %s", orchBefore, got)
			}
			for i, ag := range r.agents(t, pid) {
				if ag.InputTokens != agentsBefore[i].InputTokens || ag.OutputTokens != agentsBefore[i].OutputTokens {
					t.Fatalf("side usage leaked into agent totals: %+v -> %+v", agentsBefore[i], ag)
				}
			}

			// The request: read-only tools only, the fast model, the orchestrator's history as context.
			reqs := llm.sideRequests()
			if len(reqs) != 2 {
				t.Fatalf("side requests = %d, want 2 (a tool round and the answer)", len(reqs))
			}
			wantTools := []string{"list_dir", "read_file", "read_notes", "search_files"}
			for _, q := range reqs {
				got := slices.Clone(q.Tools)
				slices.Sort(got)
				if !slices.Equal(got, wantTools) {
					t.Fatalf("side tools = %v, want %v", got, wantTools)
				}
				if q.Model != "claude-haiku-5-5" {
					t.Fatalf("side model = %s, want the fast tier", q.Model)
				}
				if !strings.Contains(q.Body, "quick hello") || !strings.Contains(q.Body, "Side question: where is the needle?") {
					t.Fatalf("request lacks the history or the question: %s", q.Body)
				}
			}
			if !slices.Equal(sortedCopy(orchestrator.SideToolNames), wantTools) {
				t.Fatalf("SideToolNames = %v", orchestrator.SideToolNames)
			}

			// Stored exchange.
			list := a.sideList(pid)
			if len(list) != 2 || list[0]["role"] != "user" || list[0]["text"] != "where is the needle?" ||
				list[1]["role"] != "assistant" || list[0]["side_id"] != id || list[1]["side_id"] != id {
				t.Fatalf("side list = %v", list)
			}

			// A follow-up carries the earlier question and answer.
			status, id2 := a.ask(pid, "and the haystack?")
			if status != 202 || id2 == id {
				t.Fatalf("follow-up = %d %q", status, id2)
			}
			if f, _ := awaitSide(t, ch, id2); f.Type != "side.done" {
				t.Fatalf("follow-up final = %+v", f)
			}
			last := llm.sideRequests()[len(llm.sideRequests())-1]
			for _, want := range []string{"Side question: where is the needle?", done.Msg.Text, "Side question: and the haystack?"} {
				if !strings.Contains(last.Body, want) {
					t.Fatalf("follow-up request lacks %q", want)
				}
			}
			if got := orchestratorJSON(t, r, pid); got != orchBefore {
				t.Fatal("orchestrator messages changed after the follow-up")
			}
			if n := len(a.sideList(pid)); n != 4 {
				t.Fatalf("side list after follow-up = %d", n)
			}

			// Usage rows carry role side: three requests, none counted as the orchestrator's.
			var side, own int
			for _, e := range r.usageLog(t, pid) {
				if e.Role == "side" {
					side++
					if e.AgentID != agentsBefore[0].ID || e.Model != "claude-haiku-5-5" {
						t.Fatalf("side usage row = %+v", e)
					}
				} else {
					own++
				}
			}
			if side != 3 || own == 0 {
				t.Fatalf("usage rows: side=%d own=%d, want 3 side", side, own)
			}

			// Clear.
			if status, _ := a.do("DELETE", "/v1/projects/"+pid+"/side", nil); status != 204 {
				t.Fatalf("clear = %d", status)
			}
			if n := len(a.sideList(pid)); n != 0 {
				t.Fatalf("side list after clear = %d", n)
			}
			status, id3 := a.ask(pid, "fresh start")
			if status != 202 {
				t.Fatalf("ask after clear = %d", status)
			}
			awaitSide(t, ch, id3)
			fresh := llm.sideRequests()[len(llm.sideRequests())-1]
			if strings.Contains(fresh.Body, "haystack") {
				t.Fatal("cleared side conversation still reaches the model")
			}
		})
	}
}

func sortedCopy(s []string) []string {
	out := slices.Clone(s)
	slices.Sort(out)
	return out
}

func TestSideModelOverrideAndRouterHints(t *testing.T) {
	llm := &scripted{}
	r, fr := newFakeRig(t, llm, fakerouter.Options{}, orchestrator.Options{})
	pid := r.project(t, 1)
	a := r.api(t)
	ch, cancel := r.hub.Subscribe(pid)
	defer cancel()

	_, id := a.ask(pid, "default model")
	awaitSide(t, ch, id)
	if status, _ := a.do("PATCH", "/v1/projects/"+pid, map[string]any{"models": map[string]string{"side": "my-side-model"}}); status != 200 {
		t.Fatal("patch models.side")
	}
	_, id = a.ask(pid, "override")
	awaitSide(t, ch, id)
	var seen int
	var models []string
	for _, q := range fr.Requests() {
		h := q.Header
		seen++
		var b struct{ Model string }
		_ = json.Unmarshal(q.Body, &b)
		models = append(models, b.Model)
		if h.Get("x-octo-agent-role") != "sub" || h.Get("x-octo-agent-depth") != "1" || h.Get("x-octo-tier-hint") != "fast" ||
			h.Get("x-octo-budget-key") != pid || h.Get("x-octo-task") != "Side%20question" {
			t.Fatalf("side hints = %v", h)
		}
	}
	if seen != 2 || models[0] != "claude-haiku-5-5" || models[1] != "my-side-model" {
		t.Fatalf("router saw %d requests, models %v", seen, models)
	}
	for _, e := range r.usageLog(t, pid) {
		if e.Role != "side" || e.ServedModel == "" || e.RouterRequestID == "" {
			t.Fatalf("usage row = %+v, want role side with the router's ledger fields", e)
		}
	}
}

func TestSideCannotWrite(t *testing.T) {
	var dir string
	llm := &scripted{side: func(q sideReq, n int) string {
		if n == 1 {
			return "tool_use|" + strings.Join([]string{
				toolUse("w1", "write_file", `{"path":"pwned.txt","content":"x"}`),
				toolUse("b1", "bash", `{"command":"touch pwned-bash.txt"}`),
				toolUse("s1", "spawn_agent", `{"role":"r","title":"t","task":"t","tier":"fast"}`),
				toolUse("n1", "save_note", `{"title":"t","content":"c"}`),
				toolUse("n2", "delete_note", `{"title":"t"}`),
			}, "\x00")
		}
		return "end_turn|" + textBlock("I could not change anything")
	}}
	r := newRigWith(t, llm, orchestrator.Options{})
	pid := r.project(t, 2)
	p, _ := r.svc.Get(context.Background(), pid)
	dir = p.Folders[0].Path
	a := r.api(t)
	ch, cancel := r.hub.Subscribe(pid)
	defer cancel()

	_, id := a.ask(pid, "please write a file")
	if f, _ := awaitSide(t, ch, id); f.Type != "side.done" {
		t.Fatalf("final = %+v", f)
	}
	reqs := llm.sideRequests()
	if len(reqs) != 2 {
		t.Fatalf("side requests = %d", len(reqs))
	}
	for _, name := range []string{"write_file", "bash", "spawn_agent", "save_note", "delete_note"} {
		if slices.Contains(reqs[0].Tools, name) {
			t.Fatalf("side request offers %s", name)
		}
	}
	results := reqs[1].toolResults()
	if len(results) != 5 {
		t.Fatalf("tool results = %d, want 5", len(results))
	}
	for _, res := range results {
		if res["is_error"] != true || !strings.Contains(fmt.Sprint(res["content"]), "unknown tool") {
			t.Fatalf("tool call was not refused: %v", res)
		}
	}
	for _, f := range []string{"pwned.txt", "pwned-bash.txt"} {
		if _, err := os.Stat(filepath.Join(dir, f)); err == nil {
			t.Fatalf("%s was written", f)
		}
	}
	if n := len(r.agents(t, pid)); n != 1 {
		t.Fatalf("agents = %d, a side question must not spawn", n)
	}
	if notes, _ := r.notes.List(context.Background(), pid); len(notes) != 0 {
		t.Fatalf("notes = %v", notes)
	}
}

func TestSideReadsFilesAndNotes(t *testing.T) {
	llm := &scripted{side: func(q sideReq, n int) string {
		switch n {
		case 1:
			return "tool_use|" + strings.Join([]string{
				toolUse("a", "read_file", `{"path":"facts.txt"}`),
				toolUse("b", "read_notes", `{}`),
				toolUse("c", "list_dir", `{}`),
				toolUse("d", "search_files", `{"pattern":"zebra"}`),
			}, "\x00")
		}
		return "end_turn|" + textBlock("done")
	}}
	r := newRigWith(t, llm, orchestrator.Options{})
	pid := r.project(t, 1)
	p, _ := r.svc.Get(context.Background(), pid)
	if err := os.WriteFile(filepath.Join(p.Folders[0].Path, "facts.txt"), []byte("the zebra file"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := r.notes.Create(context.Background(), pid, "Goal", "ship it"); err != nil {
		t.Fatal(err)
	}
	a := r.api(t)
	ch, cancel := r.hub.Subscribe(pid)
	defer cancel()
	_, id := a.ask(pid, "what do we know?")
	awaitSide(t, ch, id)
	var texts []string
	for _, res := range llm.sideRequests()[1].toolResults() {
		if res["is_error"] == true {
			t.Fatalf("read-only tool failed: %v", res)
		}
		texts = append(texts, fmt.Sprint(res["content"]))
	}
	joined := strings.Join(texts, "\n")
	for _, want := range []string{"the zebra file", " · Goal — ship it", "facts.txt", "facts.txt:1: the zebra file"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("tool results lack %q:\n%s", want, joined)
		}
	}
}

func TestSideRoundLimit(t *testing.T) {
	llm := &scripted{side: func(q sideReq, n int) string {
		return "tool_use|" + toolUse(fmt.Sprintf("t%d", n), "list_dir", `{}`)
	}}
	r := newRigWith(t, llm, orchestrator.Options{})
	pid := r.project(t, 1)
	a := r.api(t)
	ch, cancel := r.hub.Subscribe(pid)
	defer cancel()
	_, id := a.ask(pid, "never answer")
	f, _ := awaitSide(t, ch, id)
	if f.Type != "side.error" || !strings.Contains(f.Error, "6 tool rounds") {
		t.Fatalf("final = %+v", f)
	}
	if n := len(llm.sideRequests()); n != orchestrator.SideMaxRounds+1 {
		t.Fatalf("side requests = %d, want %d (6 tool rounds, then the answer that never came)", n, orchestrator.SideMaxRounds+1)
	}
	if n := len(a.sideList(pid)); n != 0 {
		t.Fatalf("a failed question left %d side messages", n)
	}
	// The slot is free again.
	if status, _ := a.ask(pid, "again"); status != 202 {
		t.Fatalf("ask after failure = %d", status)
	}
}

func TestSideWhileTurnIsRunning(t *testing.T) {
	gate := make(chan struct{})
	var once sync.Once
	release := func() { once.Do(func() { close(gate) }) }
	t.Cleanup(release)
	llm := &scripted{
		side: func(q sideReq, n int) string { return "end_turn|" + textBlock("side answer") },
		rest: func(q sideReq, isOrch bool) string {
			switch {
			case isOrch && len(q.Messages) == 1:
				return "tool_use|" + spawnBlock("t1", "worker")
			case isOrch:
				return "end_turn|" + textBlock("all done")
			}
			<-gate // the child holds the turn open
			return "end_turn|" + textBlock("child report")
		},
	}
	r := newRigWith(t, llm, orchestrator.Options{})
	pid := r.project(t, 1)
	a := r.api(t)
	ch, cancel := r.hub.Subscribe(pid)
	defer cancel()
	if _, err := r.orch.Start(context.Background(), pid, "go build it"); err != nil {
		t.Fatal(err)
	}
	// Wait until the orchestrator's tool call is stored and the child is running.
	deadline := time.Now().Add(10 * time.Second)
	for len(r.agents(t, pid)) < 2 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if len(r.agents(t, pid)) < 2 || !r.orch.Running(pid) {
		t.Fatal("turn did not reach the child")
	}
	before := orchestratorJSON(t, r, pid)

	status, id := a.ask(pid, "what is going on?")
	if status != 202 {
		t.Fatalf("ask during a turn = %d", status)
	}
	if f, _ := awaitSide(t, ch, id); f.Type != "side.done" || f.Msg.Text != "side answer" {
		t.Fatalf("final = %+v", f)
	}
	if !r.orch.Running(pid) {
		t.Fatal("the side question ended the turn")
	}
	if got := orchestratorJSON(t, r, pid); got != before {
		t.Fatal("orchestrator messages changed during the side question")
	}

	// The snapshot ends on the user's message: the orchestrator's unanswered tool call is left out.
	q := llm.sideRequests()[0]
	if strings.Contains(q.Body, `"tool_use"`) || !strings.Contains(q.Body, "go build it") {
		t.Fatalf("side request carries a dangling tool call or lacks the history: %s", q.Body)
	}
	last := q.Messages[len(q.Messages)-1]
	if last["role"] != "user" || len(q.Messages) != 1 {
		t.Fatalf("side thread = %v, want one merged user message", q.Messages)
	}

	release()
	deadline = time.Now().Add(10 * time.Second)
	for r.orch.Running(pid) && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if after := orchestratorJSON(t, r, pid); strings.Contains(after, "side answer") || strings.Contains(after, "what is going on") {
		t.Fatal("side conversation leaked into the orchestrator's messages")
	}
	// Once the turn ended, the thread includes the whole finished history, still without side messages.
	_, id = a.ask(pid, "and now?")
	awaitSide(t, ch, id)
	q2 := llm.sideRequests()[1]
	if !strings.Contains(q2.Body, "all done") || !strings.Contains(q2.Body, "child report") {
		t.Fatalf("second side request lacks the finished turn: %s", q2.Body)
	}
}

func TestSideInProgressAndClearCancels(t *testing.T) {
	gate := make(chan struct{})
	var once sync.Once
	t.Cleanup(func() { once.Do(func() { close(gate) }) })
	started := make(chan struct{}, 4)
	llm := &scripted{side: func(q sideReq, n int) string {
		started <- struct{}{}
		<-gate
		return "end_turn|" + textBlock("late answer")
	}}
	r := newRigWith(t, llm, orchestrator.Options{})
	pid := r.project(t, 1)
	a := r.api(t)
	ch, cancel := r.hub.Subscribe(pid)
	defer cancel()

	_, id := a.ask(pid, "slow one")
	<-started
	status, body := a.do("POST", "/v1/projects/"+pid+"/side", map[string]string{"text": "second"})
	if e, _ := body["error"].(map[string]any); status != 409 || e["code"] != "side_in_progress" {
		t.Fatalf("second ask = %d %v", status, body)
	}
	if status, _ := a.do("DELETE", "/v1/projects/"+pid+"/side", nil); status != 204 {
		t.Fatalf("clear = %d", status)
	}
	f, _ := awaitSide(t, ch, id)
	if f.Type != "side.error" || f.Error != "cancelled" {
		t.Fatalf("final after clear = %+v", f)
	}
	once.Do(func() { close(gate) })
	time.Sleep(50 * time.Millisecond)
	if n := len(a.sideList(pid)); n != 0 {
		t.Fatalf("a cleared question left %d side messages", n)
	}
	if status, _ := a.ask(pid, "fresh"); status != 202 {
		t.Fatalf("ask after clear = %d", status)
	}
}

func TestSideValidation(t *testing.T) {
	r := newRig(t, &scripted{})
	pid := r.project(t, 1)
	a := r.api(t)
	for _, tc := range []struct {
		name, method, path string
		body               any
		status             int
	}{
		{"empty text", "POST", "/v1/projects/" + pid + "/side", map[string]string{"text": "  "}, 400},
		{"bad json", "POST", "/v1/projects/" + pid + "/side", nil, 400},
		{"unknown project (ask)", "POST", "/v1/projects/nope/side", map[string]string{"text": "x"}, 404},
		{"unknown project (list)", "GET", "/v1/projects/nope/side", nil, 404},
		{"unknown project (clear)", "DELETE", "/v1/projects/nope/side", nil, 404},
	} {
		if status, _ := a.do(tc.method, tc.path, tc.body); status != tc.status {
			t.Errorf("%s: status = %d, want %d", tc.name, status, tc.status)
		}
	}
}
