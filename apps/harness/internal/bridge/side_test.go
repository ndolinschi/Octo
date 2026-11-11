package bridge_test

import (
	"strings"
	"testing"
	"time"
)

// waitSide reads the stream until side.done / side.error and returns the events seen on the way.
func waitSide(t *testing.T, ch <-chan sseEvent) []sseEvent {
	t.Helper()
	var got []sseEvent
	timeout := time.After(20 * time.Second)
	for {
		select {
		case ev, ok := <-ch:
			if !ok {
				t.Fatal("stream ended early")
			}
			got = append(got, ev)
			if ev.Type == "side.done" || ev.Type == "side.error" {
				return got
			}
		case <-timeout:
			t.Fatal("timed out waiting for the side answer")
		}
	}
}

func TestSideOverHTTPAndSSE(t *testing.T) {
	e := newEnv(t, nil)
	var proj struct {
		ID                  string `json:"id"`
		OrchestratorAgentID string `json:"orchestrator_agent_id"`
	}
	e.into(t, "POST", "/v1/projects", map[string]any{"name": "p", "folders": []map[string]string{{"path": t.TempDir()}}}, 201, &proj)
	ch := e.subscribe(t, proj.ID)

	var started struct {
		SideID  string         `json:"side_id"`
		Message map[string]any `json:"message"`
	}
	e.into(t, "POST", "/v1/projects/"+proj.ID+"/side", map[string]string{"text": "what is in this project?"}, 202, &started)
	if !strings.HasPrefix(started.SideID, "sid_") || started.Message["role"] != "user" || started.Message["text"] != "what is in this project?" ||
		started.Message["side_id"] != started.SideID {
		t.Fatalf("202 body = %+v", started)
	}
	evs := waitSide(t, ch)
	final := evs[len(evs)-1]
	msg, _ := final.Data["message"].(map[string]any)
	if final.Type != "side.done" || final.Data["side_id"] != started.SideID || msg["role"] != "assistant" ||
		!strings.Contains(msg["text"].(string), "what is in this project?") {
		t.Fatalf("final = %+v", final)
	}
	if count(evs, "side.delta") == 0 {
		t.Fatalf("no side.delta in a streaming harness: %v", evs)
	}
	for _, ev := range evs {
		if ev.Type == "side.delta" && ev.Data["side_id"] != started.SideID {
			t.Fatalf("delta without the side_id: %+v", ev)
		}
		if ev.Type == "message.created" || ev.Type == "message.delta" || ev.Type == "agent.updated" {
			t.Fatalf("a side question published an agent event: %+v", ev)
		}
	}

	var list struct {
		Messages []map[string]any `json:"messages"`
	}
	e.into(t, "GET", "/v1/projects/"+proj.ID+"/side", nil, 200, &list)
	if len(list.Messages) != 2 {
		t.Fatalf("list = %v", list.Messages)
	}
	var transcript struct {
		Messages []any `json:"messages"`
	}
	e.into(t, "GET", "/v1/projects/"+proj.ID+"/agents/"+proj.OrchestratorAgentID+"/messages", nil, 200, &transcript)
	if len(transcript.Messages) != 0 {
		t.Fatalf("orchestrator transcript = %v, want none", transcript.Messages)
	}

	var ctx struct {
		AgentID      string `json:"agent_id"`
		WindowTokens *int64 `json:"window_tokens"`
		UsedTokens   int64  `json:"used_tokens"`
		Estimated    bool   `json:"estimated"`
		Parts        []struct {
			Key    string `json:"key"`
			Tokens int64  `json:"tokens"`
		} `json:"parts"`
	}
	e.into(t, "GET", "/v1/projects/"+proj.ID+"/context", nil, 200, &ctx)
	if ctx.AgentID != proj.OrchestratorAgentID || !ctx.Estimated || ctx.WindowTokens != nil || ctx.UsedTokens <= 0 || len(ctx.Parts) != 6 {
		t.Fatalf("context = %+v", ctx)
	}
	e.wantError(t, "GET", "/v1/projects/"+proj.ID+"/context?agent=nope", nil, 404, "not_found")

	e.wantError(t, "POST", "/v1/projects/"+proj.ID+"/side", map[string]string{"text": ""}, 400, "invalid_request")
	if status, _ := e.do(t, "DELETE", "/v1/projects/"+proj.ID+"/side", nil); status != 204 {
		t.Fatalf("clear = %d", status)
	}
	e.into(t, "GET", "/v1/projects/"+proj.ID+"/side", nil, 200, &list)
	if len(list.Messages) != 0 {
		t.Fatalf("list after clear = %v", list.Messages)
	}
}
