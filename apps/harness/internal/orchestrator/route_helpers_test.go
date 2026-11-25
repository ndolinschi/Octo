package orchestrator_test

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"strings"
	"sync"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/config"
	"github.com/ndolinschi/Octo/apps/harness/internal/fakerouter"
	"github.com/ndolinschi/Octo/apps/harness/internal/orchestrator"
	"github.com/ndolinschi/Octo/apps/harness/internal/project"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

// newFakeRig puts a fake Octo router in front of up; the rig's router detection
// then finds it through /health like the real thing.
func newFakeRig(t *testing.T, up http.Handler, fo fakerouter.Options, o orchestrator.Options) (*rig, *fakerouter.Router) {
	t.Helper()
	fr := fakerouter.New(up, fo)
	return newRigWith(t, fr, o), fr
}

func (r *rig) usageLog(t *testing.T, pid string) []projectstore.UsageEntry {
	t.Helper()
	db, err := r.store.Get(context.Background(), pid)
	if err != nil {
		t.Fatal(err)
	}
	log, err := db.UsageLog(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return log
}

func (r *rig) update(t *testing.T, pid string, in project.Input) project.Project {
	t.Helper()
	p, err := r.svc.Update(context.Background(), pid, in)
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func budgetInput(usd float64) project.Input {
	return project.Input{BudgetUSD: project.OptionalFloat{Set: true, Value: &usd}}
}

func policyInput(p string) project.Input {
	return project.Input{Models: &config.Models{TierPolicy: p}}
}

func near(a, b float64) bool { return math.Abs(a-b) < 1e-9 }

// messageCount is the number of messages in a recorded Messages request body.
func messageCount(t *testing.T, body []byte) int {
	t.Helper()
	return len(decode(t, body).Messages)
}

// headerLog records the headers of every request that reaches next.
type headerLog struct {
	next http.Handler
	mu   sync.Mutex
	seen []http.Header
	urls []string
}

func (h *headerLog) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h.mu.Lock()
	h.seen = append(h.seen, r.Header.Clone())
	h.urls = append(h.urls, r.URL.Path)
	h.mu.Unlock()
	h.next.ServeHTTP(w, r)
}

func (h *headerLog) octoHeaders() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	var out []string
	for _, hdr := range h.seen {
		for k := range hdr {
			if strings.HasPrefix(strings.ToLower(k), "x-octo-") {
				out = append(out, k)
			}
		}
	}
	return out
}

func toolResultTexts(t *testing.T, r *rig, pid, agentID string) []string {
	t.Helper()
	msgs, err := r.svc.Messages(context.Background(), pid, agentID)
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, m := range msgs {
		raw, err := json.Marshal(m.Content)
		if err != nil {
			t.Fatal(err)
		}
		out = append(out, string(raw))
	}
	return out
}

// respondAs answers like respond, as an SSE stream when the request asked for one.
func respondAs(w http.ResponseWriter, req fakeReq, stop string, blocks ...string) {
	if !req.Stream {
		respond(w, stop, blocks...)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	emit := func(name string, data any) {
		b, _ := json.Marshal(data)
		fmt.Fprintf(w, "event: %s\ndata: %s\n\n", name, b)
	}
	emit("message_start", map[string]any{"type": "message_start", "message": map[string]any{
		"id": "m", "type": "message", "role": "assistant", "model": "x", "content": []any{},
		"stop_reason": nil, "usage": map[string]any{"input_tokens": 3, "output_tokens": 1}}})
	for i, raw := range blocks {
		var b map[string]any
		_ = json.Unmarshal([]byte(raw), &b)
		start, delta := map[string]any{"type": "text", "text": ""}, map[string]any{"type": "text_delta", "text": b["text"]}
		if b["type"] == "tool_use" {
			in, _ := json.Marshal(b["input"])
			start = map[string]any{"type": "tool_use", "id": b["id"], "name": b["name"], "input": map[string]any{}}
			delta = map[string]any{"type": "input_json_delta", "partial_json": string(in)}
		}
		emit("content_block_start", map[string]any{"type": "content_block_start", "index": i, "content_block": start})
		emit("content_block_delta", map[string]any{"type": "content_block_delta", "index": i, "delta": delta})
		emit("content_block_stop", map[string]any{"type": "content_block_stop", "index": i})
	}
	emit("message_delta", map[string]any{"type": "message_delta", "delta": map[string]any{"stop_reason": stop}, "usage": map[string]any{"output_tokens": 2}})
	emit("message_stop", map[string]any{"type": "message_stop"})
}
