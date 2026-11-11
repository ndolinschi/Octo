package orchestrator_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/events"
	"github.com/ndolinschi/Octo/apps/harness/internal/fakerouter"
	"github.com/ndolinschi/Octo/apps/harness/internal/orchestrator"
)

type compactedEvent struct {
	Type          string `json:"type"`
	AgentID       string `json:"agent_id"`
	UptoMessageID int64  `json:"upto_message_id"`
	SummaryTokens int64  `json:"summary_tokens"`
	At            string `json:"at"`
}

func TestCompactionEmitsEventAndTranscriptMarker(t *testing.T) {
	for _, stream := range []bool{false, true} {
		name := "non-streaming"
		if stream {
			name = "streaming"
		}
		t.Run(name, func(t *testing.T) {
			r, _ := newFakeRig(t, compactingUpstream(), fakerouter.Options{CompactAt: 3}, orchestrator.Options{Stream: stream})
			pid := r.project(t, 1)
			ch, cancel := r.hub.Subscribe(pid)
			defer cancel()
			if st := r.run(t, pid, "first", nil); st != "completed" {
				t.Fatalf("turn = %s", st)
			}
			var got []compactedEvent
			for drained := false; !drained; {
				select {
				case ev := <-ch:
					if ev.Type == events.AgentCompacted {
						var e compactedEvent
						if err := json.Unmarshal(ev.Data, &e); err != nil {
							t.Fatal(err)
						}
						got = append(got, e)
					}
				case <-time.After(50 * time.Millisecond):
					drained = true
				}
			}
			orch := r.agents(t, pid)[0]
			msgs, err := r.svc.Messages(context.Background(), pid, orch.ID)
			if err != nil || len(msgs) != 4 {
				t.Fatalf("messages = %d (%v)", len(msgs), err)
			}
			if len(got) != 1 {
				t.Fatalf("agent.compacted events = %d, want 1", len(got))
			}
			e := got[0]
			if e.Type != "agent.compacted" || e.AgentID != orch.ID || e.UptoMessageID != msgs[2].ID || e.At == "" || e.SummaryTokens < 1 {
				t.Fatalf("event = %+v, want agent %s upto %d", e, orch.ID, msgs[2].ID)
			}

			// The transcript response carries the same marker.
			status, body := r.api(t).do("GET", "/v1/projects/"+pid+"/agents/"+orch.ID+"/messages", nil)
			marks, _ := body["compactions"].([]any)
			if status != 200 || len(marks) != 1 {
				t.Fatalf("transcript = %d %v", status, body)
			}
			m := marks[0].(map[string]any)
			if int64(m["upto_message_id"].(float64)) != e.UptoMessageID || m["at"] != e.At {
				t.Fatalf("marker %v does not match event %+v", m, e)
			}
			if n := len(body["messages"].([]any)); n != 4 {
				t.Fatalf("transcript messages = %d", n)
			}
		})
	}
}

func TestTranscriptWithoutCompactionHasEmptyList(t *testing.T) {
	r := newRig(t, compactingUpstream())
	pid := r.project(t, 1)
	orch := r.agents(t, pid)[0]
	_, body := r.api(t).do("GET", "/v1/projects/"+pid+"/agents/"+orch.ID+"/messages", nil)
	marks, ok := body["compactions"].([]any)
	if !ok || len(marks) != 0 {
		t.Fatalf("compactions = %v, want []", body["compactions"])
	}
}
