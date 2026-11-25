package bridge_test

import (
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"
)

// Over a real SSE connection: what the scripted agent does before it writes
// (thought, plan, tool call) reaches a subscriber at once, and its text arrives
// chunk by chunk, not in one lump.
func TestLiveACPEventsReachAnSSESubscriberWithoutDelay(t *testing.T) {
	e := newACPEnv(t, nil, nil)
	p := e.acpProject(t)
	ch := e.subscribe(t, p.ID)
	e.into(t, "POST", "/v1/projects/"+p.ID+"/messages", map[string]string{"text": "[live] go"}, http.StatusAccepted, nil)

	type got struct {
		ev sseEvent
		at time.Time
	}
	var all []got
	timeout := time.After(30 * time.Second)
loop:
	for {
		select {
		case ev, ok := <-ch:
			if !ok {
				t.Fatal("stream ended early")
			}
			all = append(all, got{ev, time.Now()})
			if ev.Type == "turn.finished" {
				break loop
			}
		case <-timeout:
			t.Fatal("timed out")
		}
	}
	sent := func(text string) time.Time {
		text = strings.TrimPrefix(text, "t=")
		head, _, _ := strings.Cut(text, ";")
		ns, err := strconv.ParseInt(head, 10, 64)
		if err != nil {
			t.Fatalf("no send time in %q", text)
		}
		return time.Unix(0, ns)
	}
	var thoughts, chunks, plans, tools int
	var firstChunk, lastChunk time.Time
	var firstThoughtLatency time.Duration
	for _, g := range all {
		text, _ := g.ev.Data["text"].(string)
		switch g.ev.Type {
		case "message.thinking_delta":
			if thoughts == 0 {
				firstThoughtLatency = g.at.Sub(sent(text))
			}
			thoughts++
		case "message.delta":
			if !strings.Contains(text, ";c") {
				continue
			}
			if lat := g.at.Sub(sent(text)); lat > 100*time.Millisecond {
				t.Fatalf("chunk %q took %v through the SSE connection", text, lat)
			}
			if chunks == 0 {
				firstChunk = g.at
			}
			lastChunk = g.at
			chunks++
		case "agent.plan":
			plans++
		case "tool.started":
			tools++
		}
	}
	if firstThoughtLatency > 100*time.Millisecond || thoughts == 0 {
		t.Fatalf("first thought: %d deltas, latency %v", thoughts, firstThoughtLatency)
	}
	if chunks != 20 || lastChunk.Sub(firstChunk) < 300*time.Millisecond {
		t.Fatalf("text: %d deltas over %v, want 20 over ~400 ms", chunks, lastChunk.Sub(firstChunk))
	}
	if plans != 2 || tools != 1 {
		t.Fatalf("plans=%d tools=%d", plans, tools)
	}
	// The plan is also on the agent row.
	var agents struct {
		Agents []struct {
			ID   string `json:"id"`
			Plan []struct{ Content, Status, Priority string }
		}
	}
	e.into(t, "GET", "/v1/projects/"+p.ID+"/agents", nil, 200, &agents)
	if len(agents.Agents) != 1 || len(agents.Agents[0].Plan) != 2 || agents.Agents[0].Plan[0].Status != "completed" {
		t.Fatalf("agents = %+v", agents)
	}
}
