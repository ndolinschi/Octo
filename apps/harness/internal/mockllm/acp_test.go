package mockllm

import (
	"encoding/json"
	"strings"
	"testing"
)

const (
	acpTools = `"tools":[{"name":"save_note"},{"name":"spawn_agent","input_schema":{"type":"object","properties":` +
		`{"agent":{"type":"string","enum":["fake","other"]}}}}]`
	plainTools = `"tools":[{"name":"save_note"},{"name":"spawn_agent","input_schema":{"type":"object","properties":{}}}]`
)

func TestACPDelegation(t *testing.T) {
	msg := post(t, `{"model":"m",`+acpTools+`,"messages":[{"role":"user","content":"[acp] [hang] review this"}]}`)
	if got := toolNames(msg); len(got) != 1 || got[0] != "spawn_agent" {
		t.Fatalf("tools = %v, want one spawn_agent", got)
	}
	var in map[string]any
	for _, c := range msg["content"].([]any) {
		if b := c.(map[string]any); b["type"] == "tool_use" {
			in = b["input"].(map[string]any)
		}
	}
	if in["agent"] != "fake" || in["role"] != "External agent" || in["tier"] != "balanced" {
		t.Fatalf("input = %v", in)
	}
	task := in["task"].(string)
	if !strings.Contains(task, "review this") || !strings.HasSuffix(task, "[hang]") || strings.HasSuffix(task, "[acp]") {
		t.Fatalf("task = %q", task)
	}

	done := post(t, `{"model":"m",`+acpTools+`,"messages":[{"role":"user","content":"[acp] go"},`+
		`{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"spawn_agent","input":{}}]},`+
		`{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"Agent report text"}]}]}`)
	if got := toolNames(done); len(got) != 0 {
		t.Fatalf("summary step still calls tools: %v", got)
	}
	text := done["content"].([]any)[0].(map[string]any)["text"].(string)
	if !strings.Contains(text, "Agent report text") || !strings.Contains(text, "`fake`") {
		t.Fatalf("summary = %q", text)
	}
}

func TestACPMarkerIgnoredWithoutEnum(t *testing.T) {
	msg := post(t, `{"model":"m",`+plainTools+`,"messages":[{"role":"user","content":"[acp] build it"}]}`)
	if got := toolNames(msg); len(got) != 3 {
		t.Fatalf("without an agent enum the scripted three-way split must remain, got %v", got)
	}
}

func TestACPModelMarker(t *testing.T) {
	tests := []struct {
		name, ask, want string
	}{
		{"chosen", "[acp] [model:gpt-5.1] review", "gpt-5.1"},
		{"none", "[acp] review", ""},
		{"slash", "[acp] [model:vendor/m-2] x", "vendor/m-2"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			msg := post(t, `{"model":"m",`+acpTools+`,"messages":[{"role":"user","content":"`+tc.ask+`"}]}`)
			var in map[string]any
			for _, c := range msg["content"].([]any) {
				if b := c.(map[string]any); b["type"] == "tool_use" {
					in = b["input"].(map[string]any)
				}
			}
			got, _ := in["model"].(string)
			if got != tc.want {
				t.Fatalf("model = %q, want %q (input %v)", got, tc.want, in)
			}
			if task := in["task"].(string); strings.Contains(task, "model:") {
				t.Fatalf("marker leaked into task: %q", task)
			}
		})
	}
}

func TestAutoMarkerSpawnsWithoutTier(t *testing.T) {
	msg := post(t, `{"model":"m",`+plainTools+`,"messages":[{"role":"user","content":"[auto] find the bug"}]}`)
	b, _ := json.Marshal(msg)
	raw := string(b)
	if got := toolNames(msg); len(got) != 1 || got[0] != "spawn_agent" || strings.Contains(raw, `"tier"`) || strings.Contains(raw, "[auto]") {
		t.Fatalf("reply = %s", raw)
	}
}
