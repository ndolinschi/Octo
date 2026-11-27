package acp

import (
	"encoding/json"
	"testing"
)

func TestParseAgentErrorShapes(t *testing.T) {
	for _, tc := range []struct {
		name string
		raw  string
		want AgentError
		ok   bool
	}{
		{
			name: "nested opencode error",
			raw:  `{"sessionUpdate":"agent_error","error":{"name":"APIError","data":{"message":"Rate limit","statusCode":429}}}`,
			want: AgentError{Name: "APIError", Message: "Rate limit", StatusCode: 429},
			ok:   true,
		},
		{
			name: "flat error fields",
			raw:  `{"sessionUpdate":"agent_error","name":"AuthError","code":"unauthorized","message":"Token expired","statusCode":401}`,
			want: AgentError{Name: "AuthError", Code: "unauthorized", Message: "Token expired", StatusCode: 401},
			ok:   true,
		},
		{
			name: "string error payload",
			raw:  `{"sessionUpdate":"agent_error","error":"Quota exhausted"}`,
			want: AgentError{Message: "Quota exhausted"},
			ok:   true,
		},
		{
			name: "empty error object",
			raw:  `{"sessionUpdate":"agent_error","error":{}}`,
			ok:   false,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := parseAgentError(json.RawMessage(tc.raw))
			if ok != tc.ok {
				t.Fatalf("ok = %v, want %v (got %+v)", ok, tc.ok, got)
			}
			if got != tc.want {
				t.Fatalf("got %+v, want %+v", got, tc.want)
			}
		})
	}
}

func TestParseCompactionShapes(t *testing.T) {
	ev, ok := parseCompactionUpdate(json.RawMessage(`{"sessionUpdate":"compaction_update","compactionId":"c1","status":"done","summary":[{"type":"text","text":"Short summary."}]}`))
	if !ok || ev.ID != "c1" || ev.Status != CompactionCompleted || ev.Summary != "Short summary." {
		t.Fatalf("parseCompactionUpdate = %+v, %v", ev, ok)
	}

	ev, ok = parseSessionInfoCompaction(json.RawMessage(`{"sessionUpdate":"session_info_update","_meta":{"opencode/compaction":{"status":"error","error":{"name":"ContextError","message":"Out of context"}}}}`))
	if !ok || ev.Status != CompactionFailed || ev.Error != "Out of context" {
		t.Fatalf("parseSessionInfoCompaction = %+v, %v", ev, ok)
	}

	if _, ok := parseSessionInfoCompaction(json.RawMessage(`{"sessionUpdate":"session_info_update","title":"Renamed"}`)); ok {
		t.Fatal("ordinary session_info_update must not parse as compaction")
	}
}

func TestNotifyCurrentModeUpdate(t *testing.T) {
	var got []string
	c := &Client{
		onMode: func(sid, mode string) {
			got = append(got, sid+":"+mode)
		},
	}
	c.notify(t.Context(), methodUpdate, json.RawMessage(`{"sessionId":"s1","update":{"sessionUpdate":"current_mode_update","currentModeId":"plan"}}`))
	c.notify(t.Context(), methodUpdate, json.RawMessage(`{"sessionId":"s1","update":{"sessionUpdate":"current_mode_update","modeId":"https://agentclientprotocol.com/protocol/session-modes#agent"}}`))
	if len(got) != 2 || got[0] != "s1:plan" || got[1] != "s1:https://agentclientprotocol.com/protocol/session-modes#agent" {
		t.Fatalf("got = %v", got)
	}
}
