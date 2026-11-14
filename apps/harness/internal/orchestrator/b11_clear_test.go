package orchestrator_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/events"
	"github.com/ndolinschi/Octo/apps/harness/internal/mockllm"
	"github.com/ndolinschi/Octo/apps/harness/internal/orchestrator"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

// capture is the mock model that remembers every request body and can refuse the request that asks for
// the summary of a session being cleared.
type capture struct {
	inner       http.Handler
	failSummary bool
	mu          sync.Mutex
	bodies      []string
}

func newCapture(failSummary bool) *capture {
	return &capture{inner: mockllm.New(0), failSummary: failSummary}
}

func (c *capture) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	c.mu.Lock()
	c.bodies = append(c.bodies, string(body))
	c.mu.Unlock()
	if c.failSummary && strings.Contains(string(body), "is being cleared") {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"type":"error","error":{"type":"invalid_request_error","message":"no summary today"}}`))
		return
	}
	r.Body = io.NopCloser(bytes.NewReader(body))
	c.inner.ServeHTTP(w, r)
}

func (c *capture) last() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.bodies[len(c.bodies)-1]
}

// messageTexts are the texts of the messages array of a Messages API request body.
func messageTexts(t *testing.T, body string) []string {
	t.Helper()
	var req struct {
		Messages []struct {
			Content json.RawMessage `json:"content"`
		} `json:"messages"`
	}
	if err := json.Unmarshal([]byte(body), &req); err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, m := range req.Messages {
		var s string
		if json.Unmarshal(m.Content, &s) == nil {
			out = append(out, s)
			continue
		}
		var blocks []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		}
		_ = json.Unmarshal(m.Content, &blocks)
		var parts []string
		for _, b := range blocks {
			if b.Type == "text" {
				parts = append(parts, b.Text)
			}
		}
		out = append(out, strings.Join(parts, "\n"))
	}
	return out
}

func TestClearCarriesASummaryAndDropsTheHistory(t *testing.T) {
	cap := newCapture(false)
	r := newRigWith(t, cap, orchestrator.Options{})
	pid := r.project(t, 1)
	ctx := context.Background()
	for _, text := range []string{"quick question about the zebra crossing", "quick second question about llamas"} {
		if st := r.run(t, pid, text, nil); st != "completed" {
			t.Fatalf("turn = %s", st)
		}
	}
	orch := r.agents(t, pid)[0]
	before, _ := r.svc.Messages(ctx, pid, orch.ID)

	ch, cancelSub := r.hub.Subscribe(pid)
	defer cancelSub()
	res, err := r.svc.Clear(ctx, pid)
	if err != nil {
		t.Fatal(err)
	}
	if res.SummarySource != orchestrator.SummaryModel || res.Summary == "" || res.ConversationID == "" || !strings.Contains(res.Title, "zebra") {
		t.Fatalf("result = %+v", res)
	}
	// Memory M4: the clear ended the memory session (it keeps the summary) and opened the one the next request joins.
	if res.SessionID == "" || res.PreviousSessionID == "" || res.SessionID == res.PreviousSessionID {
		t.Fatalf("clear sessions = %q / %q", res.SessionID, res.PreviousSessionID)
	}
	ended, err := r.svc.MemorySession(ctx, pid, res.PreviousSessionID)
	if err != nil || ended.Session.Summary != res.Summary || ended.Session.SummarySource != res.SummarySource || ended.Session.Reason != "clear" || len(ended.Exchanges) != 2 {
		t.Fatalf("ended session = %+v %v", ended, err)
	}
	if st := r.run(t, pid, "quick third question about otters", nil); st != "completed" {
		t.Fatalf("turn = %s", st)
	}
	if joined, err := r.svc.MemorySession(ctx, pid, res.SessionID); err != nil || len(joined.Exchanges) != 1 {
		t.Fatalf("next session = %+v %v", joined, err)
	}
	// The model's next request: the carry-over and the new question, none of the old messages.
	texts := messageTexts(t, cap.last())
	if len(texts) != 2 || !strings.Contains(texts[0], "Carried over from the previous session") || !strings.Contains(texts[0], res.Summary) ||
		!strings.Contains(texts[0], "recall_message") || texts[1] != "quick third question about otters" {
		t.Fatalf("next request messages = %q", texts)
	}
	for _, old := range []string{"quick question about the zebra crossing", "quick second question about llamas"} {
		for _, m := range texts[1:] {
			if m == old {
				t.Fatalf("old message %q is still sent", old)
			}
		}
	}
	// Nothing was deleted: the old session keeps its transcript (on its own root agent, schema 15), search finds it,
	// and the new default session (its own root, the project's orchestrator_agent_id now) starts with the marker.
	after, _ := r.svc.Messages(ctx, pid, orch.ID)
	if len(after) != len(before) {
		t.Fatalf("old session's messages %d -> %d", len(before), len(after))
	}
	p, _ := r.svc.Get(ctx, pid)
	if p.OrchestratorAgentID == orch.ID {
		t.Fatal("the new default session kept the old root agent")
	}
	if next, _ := r.svc.Messages(ctx, pid, p.OrchestratorAgentID); len(next) != 2 {
		t.Fatalf("new session's messages = %d", len(next))
	}
	hits, err := r.svc.SearchRequests(ctx, "zebra", 10)
	if err != nil || len(hits) == 0 {
		t.Fatalf("an old request is still found: %+v %v", hits, err)
	}
	_, md, err := r.svc.ExportMarkdown(ctx, pid)
	if err != nil || !strings.Contains(md, "otters") || !strings.Contains(md, "New session \u00b7 earlier: quick question about the zebra") {
		t.Fatalf("export (%v):\n%s", err, md)
	}
	convs, err := r.svc.Conversations(ctx, pid, p.OrchestratorAgentID)
	if err != nil || len(convs) != 1 || convs[0].ConversationID != res.ConversationID || convs[0].UptoMessageID != 0 ||
		convs[0].SummarySource != "model" || !strings.Contains(convs[0].Summary, res.Summary) {
		t.Fatalf("conversations = %+v %v", convs, err)
	}
	// conversation.cleared was published.
	found := false
	for drained := false; !drained; {
		select {
		case ev := <-ch:
			found = found || ev.Type == events.ConversationCleared
		case <-time.After(50 * time.Millisecond):
			drained = true
		}
	}
	if !found {
		t.Fatal("no conversation.cleared event")
	}
}

func TestClearFallsBackToTheStoredSummary(t *testing.T) {
	cap := newCapture(true)
	r := newRigWith(t, cap, orchestrator.Options{})
	pid := r.project(t, 1)
	ctx := context.Background()
	for _, text := range []string{"quick one", "quick two", "quick three", "quick four"} {
		r.run(t, pid, text, nil)
	}
	db, err := r.store.Get(ctx, pid)
	if err != nil {
		t.Fatal(err)
	}
	orch := r.agents(t, pid)[0]
	if _, err := db.AddManualCompaction(ctx, orch.ID, "EARLIER COMPACTION SUMMARY", 2); err != nil {
		t.Fatal(err)
	}
	res, err := r.svc.Clear(ctx, pid)
	if err != nil {
		t.Fatal(err)
	}
	if res.SummarySource != orchestrator.SummaryStored {
		t.Fatalf("source = %q", res.SummarySource)
	}
	for _, want := range []string{"EARLIER COMPACTION SUMMARY", "quick two", "quick three", "quick four"} {
		if !strings.Contains(res.Summary, want) {
			t.Errorf("summary lacks %q:\n%s", want, res.Summary)
		}
	}
	if strings.Contains(res.Summary, "quick one") {
		t.Errorf("only the last three requests:\n%s", res.Summary)
	}
	// An empty session clears with an empty summary and still works.
	pid2 := r.project(t, 1)
	if res, err := r.svc.Clear(ctx, pid2); err != nil || res.Summary != "" || res.SummarySource != orchestrator.SummaryStored {
		t.Fatalf("empty clear = %+v %v", res, err)
	}
}

func TestRememberKeepsFactsWithTheirSourceCapsThemAndUndoes(t *testing.T) {
	r := newRigWith(t, newCapture(false), orchestrator.Options{})
	pid := r.project(t, 1)
	ctx := context.Background()
	ch, cancelSub := r.hub.Subscribe(pid)
	defer cancelSub()
	text := "quick keep these [remember: fact | toolchain | Go 1.26 builds it] [remember: decision | | use sqlite per project] " +
		"[remember: todo | | add a retry] [remember: preference | | short answers]"
	if st := r.run(t, pid, text, nil); st != "completed" {
		t.Fatalf("turn = %s", st)
	}
	orch := r.agents(t, pid)[0]
	msgs, _ := r.svc.Messages(ctx, pid, orch.ID)
	var answer string
	for _, m := range msgs {
		for _, b := range m.Content {
			if m.Role == "assistant" && b.Type == "text" && b.Text != nil && strings.HasPrefix(*b.Text, "Remember results:") {
				answer = *b.Text
			}
		}
	}
	if strings.Count(answer, `"remembered":true`) != 3 || !strings.Contains(answer, "at most 3 items can be remembered in one turn") {
		t.Fatalf("results = %q", answer)
	}
	tasks, err := r.svc.Tasks(ctx, pid)
	if err != nil {
		t.Fatal(err)
	}
	var facts []projectstore.Fact
	var holder projectstore.Task
	for _, tk := range tasks {
		for _, f := range tk.Facts {
			if f.RememberedBy != "" {
				facts, holder = append(facts, f), tk
			}
		}
	}
	if len(facts) != 3 {
		t.Fatalf("remembered facts = %+v", facts)
	}
	for _, f := range facts {
		if f.RememberedBy != orch.ID || f.MessageID == 0 || f.Date == "" || f.Kind == "" {
			t.Fatalf("fact = %+v", f)
		}
	}
	if holder.Auto {
		t.Fatalf("the record that holds remembered items is kept: %+v", holder)
	}
	events := 0
	for drained := false; !drained; {
		select {
		case ev := <-ch:
			if ev.Type == "fact.remembered" {
				var e struct {
					TurnID  int64  `json:"turn_id"`
					AgentID string `json:"agent_id"`
				}
				_ = json.Unmarshal(ev.Data, &e)
				if e.TurnID != facts[0].MessageID || e.AgentID != orch.ID {
					t.Fatalf("event = %s", ev.Data)
				}
				events++
			}
		case <-time.After(50 * time.Millisecond):
			drained = true
		}
	}
	if events != 3 {
		t.Fatalf("fact.remembered events = %d", events)
	}
	// Allowed in ask mode (it writes no file), and a new turn has its own budget of three.
	mode := projectstore.ModeAsk
	ch2, cancel2 := r.hub.Subscribe(pid)
	defer cancel2()
	if _, _, err := r.svc.PostMessage(ctx, pid, "quick again [remember: fact | | asked in ask mode]", &mode); err != nil {
		t.Fatal(err)
	}
	for done := false; !done; {
		select {
		case ev := <-ch2:
			done = ev.Type == events_TurnFinished
		case <-time.After(20 * time.Second):
			t.Fatal("ask-mode turn did not finish")
		}
	}
	tasks, _ = r.svc.Tasks(ctx, pid)
	n := 0
	for _, tk := range tasks {
		for _, f := range tk.Facts {
			if f.Text == "asked in ask mode" {
				n++
			}
		}
	}
	if n != 1 {
		t.Fatalf("the ask-mode item was stored %d times", n)
	}
	// Undo.
	if err := r.svc.Forget(ctx, pid, holder.ID, facts[0].ID); err != nil {
		t.Fatal(err)
	}
	got, _ := r.svc.Tasks(ctx, pid)
	for _, tk := range got {
		for _, f := range tk.Facts {
			if tk.ID == holder.ID && f.ID == facts[0].ID {
				t.Fatalf("the fact is still there: %+v", f)
			}
		}
	}
}

const events_TurnFinished = events.TurnFinished
