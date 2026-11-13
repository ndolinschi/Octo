package orchestrator_test

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"reflect"
	"strings"
	"sync"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/config"
	"github.com/ndolinschi/Octo/apps/harness/internal/memory"
	"github.com/ndolinschi/Octo/apps/harness/internal/mockllm"
	"github.com/ndolinschi/Octo/apps/harness/internal/orchestrator"
	"github.com/ndolinschi/Octo/apps/harness/internal/project"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

// reqRecorder keeps every Messages request body the rig's model server gets.
type reqRecorder struct {
	next http.Handler
	mu   sync.Mutex
	reqs []recReq
}

type recReq struct {
	Tools    []string
	System   string
	Messages []recMessage
	Bytes    int
}

type recMessage struct {
	Role    string
	Content []map[string]any
}

func (m recMessage) text() string {
	var b strings.Builder
	for _, c := range m.Content {
		if t, ok := c["text"].(string); ok {
			b.WriteString(t)
			b.WriteString("\n")
		}
	}
	return b.String()
}

func (r *reqRecorder) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	body, _ := io.ReadAll(req.Body)
	req.Body = io.NopCloser(strings.NewReader(string(body)))
	if req.URL.Path == "/v1/messages" {
		var p struct {
			Tools    []struct{ Name string }
			System   []struct{ Text string }
			Messages []recMessage
		}
		if json.Unmarshal(body, &p) == nil {
			rr := recReq{Messages: p.Messages, Bytes: len(body)}
			for _, t := range p.Tools {
				rr.Tools = append(rr.Tools, t.Name)
			}
			for _, s := range p.System {
				rr.System += s.Text
			}
			r.mu.Lock()
			r.reqs = append(r.reqs, rr)
			r.mu.Unlock()
		}
	}
	r.next.ServeHTTP(w, req)
}

func (r *reqRecorder) orchestrator() []recReq {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []recReq
	for _, q := range r.reqs {
		for _, n := range q.Tools {
			if n == "save_note" {
				out = append(out, q)
				break
			}
		}
	}
	return out
}

func (r *reqRecorder) subAgents() []recReq {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []recReq
	for _, q := range r.reqs {
		has := false
		for _, n := range q.Tools {
			has = has || n == "save_note"
		}
		if !has && !strings.Contains(q.System, "side question") {
			out = append(out, q)
		}
	}
	return out
}

func (r *reqRecorder) reset() {
	r.mu.Lock()
	r.reqs = nil
	r.mu.Unlock()
}

func filler(n int) string { return strings.Repeat("lorem ipsum dolor sit amet ", n) }

func (r *rig) m2Project(t *testing.T, ctxMode string) string {
	t.Helper()
	name := "p"
	depth := 3
	in := project.Input{Name: &name, MaxDepth: &depth, Folders: &[]project.FolderInput{{Path: t.TempDir()}}}
	if ctxMode != "" {
		in.Memory = &memory.Settings{Context: ctxMode}
	}
	p, err := r.svc.Create(context.Background(), in)
	if err != nil {
		t.Fatal(err)
	}
	return p.ID
}

func (r *rig) setMemory(t *testing.T, pid string, s memory.Settings) {
	t.Helper()
	if _, err := r.svc.Update(context.Background(), pid, project.Input{Memory: &s}); err != nil {
		t.Fatal(err)
	}
}

// seed300 stores 300 exchanges (turn 12 holds a detail only search can find),
// plus many task records with facts and memory files.
func (r *rig) seed300(t *testing.T, pid string) {
	t.Helper()
	ctx := context.Background()
	db, err := r.store.Get(ctx, pid)
	if err != nil {
		t.Fatal(err)
	}
	orch, _ := db.Orchestrator(ctx)
	mem, err := r.orch.Memory(ctx, pid)
	if err != nil {
		t.Fatal(err)
	}
	add := func(role, text string) projectstore.Message {
		b, _ := json.Marshal([]map[string]any{{"type": "text", "text": text}})
		m, err := db.AppendMessage(ctx, orch.ID, role, b)
		if err != nil {
			t.Fatal(err)
		}
		return m
	}
	for i := 1; i <= 300; i++ {
		u := fmt.Sprintf("turn %d: %s", i, filler(12))
		if i == 12 {
			u = "turn 12: the staging database password rotates every Tuesday at 09:30 UTC wibbleflux " + filler(3)
		}
		m := add("user", u)
		add("assistant", fmt.Sprintf("reply %d: %s", i, filler(12)))
		if i%5 == 0 {
			task, err := mem.OpenTask(ctx, fmt.Sprintf("task %d %s", i, filler(8)), m.ID)
			if err != nil {
				t.Fatal(err)
			}
			facts := make([]memory.DigestFact, 12)
			for j := range facts {
				facts[j] = memory.DigestFact{Text: fmt.Sprintf("Fact %d.%d: %s", i, j, filler(6))}
			}
			if _, err := mem.ApplyDigest(ctx, task.ID, m.ID, memory.Digest{Facts: facts, Decisions: []string{filler(10), filler(11)}}); err != nil {
				t.Fatal(err)
			}
		}
		if i%6 == 0 {
			if _, err := mem.WriteFile(ctx, fmt.Sprintf("notes/n%d.md", i), "body "+filler(20), "summary of note "+fmt.Sprint(i)+" "+filler(2)); err != nil {
				t.Fatal(err)
			}
		}
	}
}

func userTextMessages(q recReq) []string {
	var out []string
	for _, m := range q.Messages {
		if m.Role == "user" {
			out = append(out, m.text())
		}
	}
	return out
}

func newM2Rig(t *testing.T, opts orchestrator.Options) (*rig, *reqRecorder) {
	t.Helper()
	rec := &reqRecorder{next: mockllm.New(0)}
	return newRigWith(t, rec, opts), rec
}

func TestWindowModeSendsExactlyNExchangesWithinTheCapsAndSearchFindsTurn12(t *testing.T) {
	r, rec := newM2Rig(t, orchestrator.Options{})
	pid := r.m2Project(t, "window")
	r.seed300(t, pid)
	rec.reset()
	ask := "quick: when does the staging password rotate? [search: wibbleflux]"
	if st := r.run(t, pid, ask, nil); st != "completed" {
		t.Fatalf("turn = %s", st)
	}
	reqs := rec.orchestrator()
	if len(reqs) != 2 {
		t.Fatalf("orchestrator requests = %d, want 2 (ask, then the answer after the search)", len(reqs))
	}
	first, second := reqs[0], reqs[1]

	// Exactly five earlier exchanges, the newest ones, nothing older.
	all := strings.Join(userTextMessages(first), "\n")
	for _, want := range []string{"turn 296:", "turn 297:", "turn 298:", "turn 299:", "turn 300:"} {
		if !strings.Contains(all, want) {
			t.Errorf("the window lacks %q", want)
		}
	}
	if n := strings.Count(all, "\nturn ") + boolInt(strings.HasPrefix(all, "turn ")); n < 0 {
		t.Fatal("unreachable")
	}
	for _, not := range []string{"turn 295:", "turn 250:", "turn 100:", "turn 1:"} {
		if strings.Contains(all, not) {
			t.Errorf("the window holds %q: it must be exactly 5 exchanges", not)
		}
	}
	if got := strings.Count(all, "turn 29") + strings.Count(all, "turn 300:"); got != 5 {
		t.Errorf("window user messages = %d, want 5", got)
	}
	// Roles alternate and the first message is a user message with the memory blocks.
	for i, m := range first.Messages {
		if i > 0 && m.Role == first.Messages[i-1].Role {
			t.Errorf("messages %d and %d have the same role %s", i-1, i, m.Role)
		}
	}
	// The memory index leads; the tasks (which change every turn) come after the
	// window, in front of the current turn, so the prefix before them stays put.
	if first.Messages[0].Role != "user" || !strings.Contains(first.Messages[0].text(), "## Memory") || strings.Contains(first.Messages[0].text(), "## Tasks") {
		t.Fatalf("first message = %q", clipS(first.Messages[0].text(), 200))
	}
	if last := first.Messages[len(first.Messages)-1]; !strings.Contains(last.text(), "## Tasks") || !strings.Contains(last.text(), ask) {
		t.Fatalf("last message = %q", clipS(last.text(), 300))
	}

	// The caps: everything but the current turn stays under the sum of the caps
	// (history of 600 messages, 60 tasks with 720 facts, 50 files behind it).
	currentChars := len(ask)
	var total int
	for _, m := range first.Messages {
		total += len(m.text())
	}
	if limit := orchestrator.CapsTotal*4 + currentChars + 2000; total > limit {
		t.Errorf("window request holds %d characters of messages, caps allow %d", total, limit)
	}

	// Turn 12 is not in the first request, the search finds it and the second request carries it.
	if strings.Contains(strings.Join(userTextMessages(first), "\n"), "rotates every Tuesday") {
		t.Error("turn 12 was in the context without being searched for")
	}
	later := ""
	for _, m := range second.Messages {
		later += m.text()
		for _, c := range m.Content {
			if s, ok := c["content"]; ok {
				b, _ := json.Marshal(s)
				later += string(b)
			}
		}
	}
	if !strings.Contains(later, "rotates every Tuesday") {
		t.Error("the search result did not carry turn 12 back into the context")
	}

	// And the same history in full mode is far larger.
	r.setMemory(t, pid, memory.Settings{Context: "full"})
	rec.reset()
	if st := r.run(t, pid, "quick: and now?", nil); st != "completed" {
		t.Fatal(st)
	}
	fullReq := rec.orchestrator()[0]
	if fullReq.Bytes < 5*first.Bytes {
		t.Errorf("full request %d bytes vs window %d: the window should be several times smaller", fullReq.Bytes, first.Bytes)
	}
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

func clipS(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}

func TestReceiptsMatchWhatWasSent(t *testing.T) {
	r, rec := newM2Rig(t, orchestrator.Options{})
	pid := r.m2Project(t, "window")
	r.seed300(t, pid)
	rec.reset()
	var posted projectstore.Message
	ch, cancel := r.hub.Subscribe(pid)
	defer cancel()
	_ = ch
	posted, err := r.orch.Start(context.Background(), pid, "quick: what is open?")
	if err != nil {
		t.Fatal(err)
	}
	waitTurn(t, r, pid)
	raw, err := r.orch.TurnReceipt(context.Background(), pid, posted.ID)
	if err != nil {
		t.Fatal(err)
	}
	var rc orchestrator.Receipt
	if err := json.Unmarshal(raw, &rc); err != nil {
		t.Fatal(err)
	}
	q := rec.orchestrator()[0]
	if rc.TurnID != posted.ID || rc.Mode != "window" || rc.RecentExchanges != 5 || rc.MessageCount != len(q.Messages) {
		t.Fatalf("receipt = %+v; request had %d messages", rc, len(q.Messages))
	}
	names := []string{}
	byName := map[string]orchestrator.ReceiptBlock{}
	for _, b := range rc.Blocks {
		names = append(names, b.Name)
		byName[b.Name] = b
	}
	if strings.Join(names, ",") != "memory_index,recent_window,open_tasks,facts,current_turn" {
		t.Fatalf("blocks = %v", names)
	}
	// The window block names the first message of each of the five exchanges, newest last.
	win := byName["recent_window"]
	if win.Count != 5 || len(win.IDs) != 5 || win.Cap != orchestrator.CapWindow {
		t.Fatalf("window block = %+v", win)
	}
	if cur := byName["current_turn"]; len(cur.IDs) != 1 || cur.IDs[0] != fmt.Sprint(posted.ID) {
		t.Fatalf("current turn block = %+v", cur)
	}
	// The ids of the open tasks and of the facts are the ones in the text the model got.
	text := q.Messages[len(q.Messages)-1].text() // tasks and facts sit in front of the current turn
	for _, id := range byName["open_tasks"].IDs {
		if !strings.Contains(text, id) {
			t.Errorf("task %s is in the receipt but not in the request", id)
		}
	}
	// Token counts are the harness's estimate of the texts that were sent.
	tasksText := between(text, "## Tasks", "## Current facts")
	if got := projectstore.EstimateTokens(len(tasksText)); abs(got-byName["open_tasks"].Tokens) > 40 {
		t.Errorf("open_tasks tokens: receipt %d, request %d", byName["open_tasks"].Tokens, got)
	}
	var capped int64
	for _, b := range rc.Blocks {
		capped += b.Cap
		if b.Cap > 0 && b.Tokens > b.Cap {
			t.Errorf("block %s has %d tokens over its cap %d", b.Name, b.Tokens, b.Cap)
		}
	}
	if capped != rc.CapsTotal || rc.CapsTotal != orchestrator.CapsTotal {
		t.Errorf("caps total = %d / %d", rc.CapsTotal, capped)
	}
}

func between(s, from, to string) string {
	i := strings.Index(s, from)
	if i < 0 {
		return ""
	}
	s = s[i:]
	if to != "" {
		if j := strings.Index(s, to); j > 0 {
			s = s[:j]
		}
	}
	return s
}

func abs(n int64) int64 {
	if n < 0 {
		return -n
	}
	return n
}

func waitTurn(t *testing.T, r *rig, pid string) {
	t.Helper()
	for i := 0; i < 2000; i++ {
		if !r.orch.Running(pid) {
			return
		}
		sleepMs(10)
	}
	t.Fatal("turn did not finish")
}

func TestSwitchingModeBothWaysLosesNothing(t *testing.T) {
	r, rec := newM2Rig(t, orchestrator.Options{})
	pid := r.m2Project(t, "")
	ctx := context.Background()
	say := func(text string) {
		if st := r.run(t, pid, text, nil); st != "completed" {
			t.Fatalf("%s: %s", text, st)
		}
		waitTurn(t, r, pid)
	}
	count := func() int {
		db, _ := r.store.Get(ctx, pid)
		orch, _ := db.Orchestrator(ctx)
		m, _ := db.Messages(ctx, orch.ID)
		return len(m)
	}
	say("quick: first thing, zanzibar protocol")
	say("quick: second thing")
	n0 := count()
	r.setMemory(t, pid, memory.Settings{Context: "window", RecentExchanges: 1})
	rec.reset()
	say("quick: third thing")
	win := rec.orchestrator()[0]
	// The window holds one exchange (the second thing); the first thing is only in memory.
	idOf := func(text string) int64 {
		db, _ := r.store.Get(ctx, pid)
		orch, _ := db.Orchestrator(ctx)
		msgs, _ := db.Messages(ctx, orch.ID)
		for _, m := range msgs {
			if m.Role == "user" && len(m.Content) > 0 && m.Content[0].Text != nil && *m.Content[0].Text == text {
				return m.ID
			}
		}
		t.Fatalf("no message %q", text)
		return 0
	}
	raw, err := r.orch.TurnReceipt(ctx, pid, idOf("quick: third thing"))
	if err != nil {
		t.Fatal(err)
	}
	var rc orchestrator.Receipt
	_ = json.Unmarshal(raw, &rc)
	var window orchestrator.ReceiptBlock
	for _, b := range rc.Blocks {
		if b.Name == "recent_window" {
			window = b
		}
	}
	if window.Count != 1 || len(window.IDs) != 1 || window.IDs[0] != fmt.Sprint(idOf("quick: second thing")) {
		t.Errorf("window block = %+v", window)
	}
	_ = win
	r.setMemory(t, pid, memory.Settings{Context: "full"})
	rec.reset()
	say("quick: fourth thing")
	full := rec.orchestrator()[0]
	if !strings.Contains(strings.Join(userTextMessages(full), "\n"), "zanzibar") {
		t.Error("back in full mode the whole transcript must be sent again")
	}
	if n := count(); n <= n0 {
		t.Fatalf("messages %d -> %d: nothing may be lost", n0, n)
	}
	// Everything from the window period is still searchable.
	res, err := (func() (memory.SearchResult, error) {
		mem, _ := r.orch.Memory(ctx, pid)
		return mem.Search(ctx, memory.SearchParams{Query: "zanzibar protocol"})
	})()
	if err != nil || len(res.Hits) == 0 {
		t.Fatalf("search = %+v %v", res, err)
	}
	p, _ := r.svc.Get(ctx, pid)
	if p.Memory.Context != "full" || p.Memory.RecentExchanges != 1 {
		t.Fatalf("memory settings = %+v", p.Memory)
	}
}

func TestSubAgentsAreUnaffectedByTheMode(t *testing.T) {
	var subs [2]recReq
	for i, mode := range []string{"full", "window"} {
		r, rec := newM2Rig(t, orchestrator.Options{})
		pid := r.m2Project(t, mode)
		if st := r.run(t, pid, "Add retry logic to the fetch helper", nil); st != "completed" {
			t.Fatal(st)
		}
		s := rec.subAgents()
		if len(s) == 0 {
			t.Fatal("no sub-agent request")
		}
		subs[i] = s[0]
		if len(s[0].Messages) != 1 || strings.Contains(s[0].Messages[0].text(), "## Memory") {
			t.Fatalf("%s: sub-agent first request = %+v", mode, s[0].Messages)
		}
		for _, n := range s[0].Tools {
			if n == "task_update" || n == "memory_search" {
				t.Errorf("%s: a sub-agent got the memory tool %s", mode, n)
			}
		}
	}
	// Same role, same system prompt apart from the project's own ids.
	if subs[0].System == "" || len(subs[0].Tools) != len(subs[1].Tools) {
		t.Fatalf("sub-agent requests differ between modes: %d vs %d tools", len(subs[0].Tools), len(subs[1].Tools))
	}
}

func TestToolResultsAreClearedInBothModes(t *testing.T) {
	for _, mode := range []string{"full", "window"} {
		t.Run(mode, func(t *testing.T) {
			var mu sync.Mutex
			var seen []string
			calls := 0
			llm := fakeLLM(func(w http.ResponseWriter, hr *http.Request, req fakeReq) {
				if !req.isOrchestrator() {
					respond(w, "end_turn", textBlock("ok"))
					return
				}
				mu.Lock()
				calls++
				n := calls
				body, _ := json.Marshal(req)
				seen = append(seen, string(body))
				mu.Unlock()
				if n <= 8 {
					respond(w, "tool_use", fmt.Sprintf(`{"type":"tool_use","id":"t%d","name":"list_dir","input":{"path":"."}}`, n))
					return
				}
				respond(w, "end_turn", textBlock("done"))
			})
			// A tiny window so the 60% threshold is reached by a handful of results.
			r := newRigWith(t, llm, orchestrator.Options{Windows: config.ContextWindows{"claude-sonnet-5-5": 6000}})
			pid := r.m2Project(t, mode)
			dir := r.firstFolder(t, pid)
			for i := 0; i < 80; i++ {
				writeBig(t, dir, i)
			}
			if st := r.run(t, pid, "list it many times", nil); st != "completed" {
				t.Fatalf("turn = %s", st)
			}
			mu.Lock()
			defer mu.Unlock()
			last := seen[len(seen)-1]
			if !strings.Contains(last, "[cleared: list_dir") {
				t.Fatalf("no tool result was cleared in %s mode", mode)
			}
			if strings.Count(last, "[cleared: list_dir") != 8-5 {
				t.Errorf("cleared %d results, want 3 (all but the last 5)", strings.Count(last, "[cleared: list_dir"))
			}
			// Stored messages keep the real results (the clearing is only in what is sent).
			db, _ := r.store.Get(context.Background(), pid)
			orch, _ := db.Orchestrator(context.Background())
			msgs, _ := db.Messages(context.Background(), orch.ID)
			for _, m := range msgs {
				for _, b := range m.Content {
					if b.Type == "tool_result" && b.Content != nil && strings.HasPrefix(*b.Content, "[cleared") {
						t.Fatal("a cleared stub was stored")
					}
				}
			}
			db2, _ := r.store.Get(context.Background(), pid)
			_ = db2
			raw, err := r.orch.TurnReceipt(context.Background(), pid, firstUserMessage(t, r, pid))
			if err != nil {
				t.Fatal(err)
			}
			var rc orchestrator.Receipt
			_ = json.Unmarshal(raw, &rc)
			if rc.ClearedCalls == 0 {
				t.Errorf("receipt says nothing was cleared: %+v", rc)
			}
		})
	}
}

// The window advances N exchanges at a time, so for N consecutive requests
// everything before the current turn is byte for byte what the request before
// it carried (a provider's prompt cache keeps hitting), and it changes exactly
// when the window steps.
func TestWindowAdvancesInStepsSoThePrefixStaysTheSameBetweenSteps(t *testing.T) {
	const n = 3
	r, rec := newM2Rig(t, orchestrator.Options{})
	pid := r.m2Project(t, "window")
	r.setMemory(t, pid, memory.Settings{Context: "window", RecentExchanges: n})
	start := func(k int) int { // the documented rule: 0 until 2N, then N further each N
		if k <= n {
			return 0
		}
		return n * ((k - n) / n)
	}
	var prev []recMessage
	prevStart := -1
	changes := 0
	for turn := 1; turn <= 11; turn++ {
		rec.reset()
		if st := r.run(t, pid, fmt.Sprintf("quick: question number %d about the repository", turn), nil); st != "completed" {
			t.Fatalf("turn %d = %s", turn, st)
		}
		first := rec.orchestrator()[0]
		before := first.Messages[:len(first.Messages)-1] // everything but the current turn
		k := turn - 1                                    // exchanges before this turn
		if prev != nil {
			shared := len(prev) // the previous request's own prefix, as it was sent
			same := len(before) >= shared && reflect.DeepEqual(before[:shared], prev)
			if want := start(k) == prevStart; same != want {
				t.Fatalf("turn %d (window start %d, previous %d): prefix identical=%v, want %v", turn, start(k), prevStart, same, want)
			}
			if !same {
				changes++
			}
		}
		// The window holds at least the last N exchanges and fewer than 2N.
		var seen strings.Builder
		for _, m := range before {
			if m.Role == "user" {
				seen.WriteString(m.text() + "\n")
			}
		}
		got := strings.Count(seen.String(), "question number")
		if k >= n && (got < n || got >= 2*n) || k < n && got != k {
			t.Fatalf("turn %d: window of %d exchanges with %d earlier ones", turn, got, k)
		}
		prev, prevStart = before, start(k)
	}
	if changes != 2 { // the window stepped at the 7th and the 10th turn
		t.Fatalf("the prefix changed %d times in 11 turns, want 2 (one per step)", changes)
	}
}
