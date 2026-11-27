package acp

import (
	"encoding/json"
	"reflect"
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
			data := got.Data
			got.Data = nil
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("got %+v, want %+v", got, tc.want)
			}
			if tc.ok && tc.want.Name != "" && !json.Valid(data) {
				t.Fatalf("data = %q, want the error object", data)
			}
		})
	}
}

func TestParseAgentErrorKeepsData(t *testing.T) {
	ae, ok := parseAgentError(json.RawMessage(`{"sessionUpdate":"agent_error","error":{"message":"Limit","data":{"errorKind":"rate_limit","rateLimit":{"resetsAt":1767225600}}}}`))
	if !ok || ae.Message != "Limit" {
		t.Fatalf("parse = %+v, %v", ae, ok)
	}
	var obj struct {
		Data struct {
			ErrorKind string `json:"errorKind"`
		} `json:"data"`
	}
	if err := json.Unmarshal(ae.Data, &obj); err != nil || obj.Data.ErrorKind != "rate_limit" {
		t.Fatalf("data = %s (%v)", ae.Data, err)
	}
	if ae, _ := parseAgentError(json.RawMessage(`{"sessionUpdate":"agent_error","error":"plain"}`)); ae.Data != nil {
		t.Fatalf("a string payload has no data: %s", ae.Data)
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
