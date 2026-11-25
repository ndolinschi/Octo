package mockllm

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func post(t *testing.T, body string) map[string]any {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/messages", strings.NewReader(body))
	New(0).ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body)
	}
	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func toolNames(msg map[string]any) []string {
	var names []string
	for _, c := range msg["content"].([]any) {
		if b := c.(map[string]any); b["type"] == "tool_use" {
			names = append(names, b["name"].(string))
		}
	}
	return names
}

func TestScriptSteps(t *testing.T) {
	const orchTools = `"tools":[{"name":"save_note"},{"name":"spawn_agent"}]`
	for _, tc := range []struct {
		name, body string
		wantTools  []string
		wantStop   string
	}{
		{"quick answers directly", `{"model":"m",` + orchTools + `,"messages":[{"role":"user","content":"a quick question"}]}`, nil, "end_turn"},
		{"orchestrator spawns three", `{"model":"m",` + orchTools + `,"messages":[{"role":"user","content":"build it"}]}`,
			[]string{"spawn_agent", "spawn_agent", "spawn_agent"}, "tool_use"},
		{"sub-agent lists dir first", `{"model":"m","system":"Role: Code explorer\n","tools":[{"name":"list_dir"},{"name":"read_file"}],"messages":[{"role":"user","content":"look"}]}`,
			[]string{"list_dir"}, "tool_use"},
		{"sub-agent without tools reports", `{"model":"m","system":"Role: Code explorer\n","messages":[{"role":"user","content":"look"}]}`, nil, "end_turn"},
		{"architect delegates", `{"model":"m","system":[{"type":"text","text":"Role: Systems architect"}],"tools":[{"name":"list_dir"},{"name":"read_file"},{"name":"spawn_agent"}],"messages":[` +
			`{"role":"user","content":"look"},{"role":"assistant","content":[{"type":"tool_use","id":"a","name":"list_dir","input":{}}]},` +
			`{"role":"user","content":[{"type":"tool_result","tool_use_id":"a","content":"x.go"}]}]}`,
			[]string{"spawn_agent"}, "tool_use"},
		{"nested architect reads file", `{"model":"m","system":"Role: Systems architect","tools":[{"name":"list_dir"},{"name":"read_file"},{"name":"spawn_agent"}],"messages":[` +
			`{"role":"user","content":"[nested] look"},{"role":"assistant","content":[{"type":"tool_use","id":"a","name":"list_dir","input":{}}]},` +
			`{"role":"user","content":[{"type":"tool_result","tool_use_id":"a","content":"x.go"}]}]}`,
			[]string{"read_file"}, "tool_use"},
		{"marked sub-agent writes second", `{"model":"m","system":"Role: Code explorer","tools":[{"name":"list_dir"},{"name":"read_file"},{"name":"write_file"}],"messages":[` +
			`{"role":"user","content":"go [write]"},{"role":"assistant","content":[{"type":"tool_use","id":"a","name":"list_dir","input":{}}]},` +
			`{"role":"user","content":[{"type":"tool_result","tool_use_id":"a","content":"x.go"}]}]}`,
			[]string{"write_file"}, "tool_use"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			msg := post(t, tc.body)
			got := toolNames(msg)
			if strings.Join(got, ",") != strings.Join(tc.wantTools, ",") || msg["stop_reason"] != tc.wantStop {
				t.Fatalf("tools = %v stop = %v, want %v / %s", got, msg["stop_reason"], tc.wantTools, tc.wantStop)
			}
			if u := msg["usage"].(map[string]any); u["input_tokens"].(float64) <= 0 || u["output_tokens"].(float64) <= 0 {
				t.Fatalf("usage = %v", u)
			}
		})
	}
}

func TestStreamIsWellFormed(t *testing.T) {
	rec := httptest.NewRecorder()
	body := `{"model":"m","stream":true,"tools":[{"name":"save_note"}],"messages":[{"role":"user","content":"build it"}]}`
	New(0).ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/v1/messages", strings.NewReader(body)))
	out := rec.Body.String()
	for _, want := range []string{"event: message_start", "event: content_block_start", `"type":"input_json_delta"`,
		`"type":"text_delta"`, "event: message_delta", `"stop_reason":"tool_use"`, "event: message_stop"} {
		if !strings.Contains(out, want) {
			t.Errorf("stream missing %q", want)
		}
	}
}

func TestSideQuestionScript(t *testing.T) {
	const sys = `"system":[{"type":"text","text":"You answer a side question about a software project"}],"tools":[{"name":"list_dir"},{"name":"read_file"}]`
	first := post(t, `{`+sys+`,"messages":[{"role":"user","content":[{"type":"text","text":"earlier ask"}]},{"role":"assistant","content":[{"type":"text","text":"done"}]},`+
		`{"role":"user","content":[{"type":"text","text":"Side question: what is here?"}]}]}`)
	if got := toolNames(first); len(got) != 1 || got[0] != "list_dir" {
		t.Fatalf("first step tools = %v, want one list_dir", got)
	}
	final := post(t, `{`+sys+`,"messages":[{"role":"user","content":[{"type":"text","text":"Side question: what is here?"}]},`+
		`{"role":"assistant","content":[{"type":"tool_use","id":"t","name":"list_dir","input":{}}]},`+
		`{"role":"user","content":[{"type":"tool_result","tool_use_id":"t","content":"a.txt"}]}]}`)
	text := final["content"].([]any)[0].(map[string]any)["text"].(string)
	if len(toolNames(final)) != 0 || !strings.Contains(text, "what is here?") || !strings.Contains(text, "nothing was changed") {
		t.Fatalf("final = %v", final["content"])
	}
}

// The [hold:NAME] marker keeps a streamed reply open after its first words until Release(NAME).
func TestHoldMarkerWaitsForRelease(t *testing.T) {
	h := NewHolds()
	srv := httptest.NewServer(New(0, WithHolds(h)))
	defer srv.Close()
	body := `{"model":"m","stream":true,"max_tokens":10,"messages":[{"role":"user","content":"please [hold:a] now"}],"tools":[{"name":"save_note","input_schema":{}}]}`
	done := make(chan string)
	go func() {
		resp, err := http.Post(srv.URL+"/v1/messages", "application/json", strings.NewReader(body))
		if err != nil {
			done <- err.Error()
			return
		}
		b, _ := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		done <- string(b)
	}()
	deadline := time.Now().Add(5 * time.Second)
	for h.Waiting("a") == 0 {
		if time.Now().After(deadline) {
			t.Fatal("the reply was never held")
		}
		time.Sleep(5 * time.Millisecond)
	}
	select {
	case <-done:
		t.Fatal("the held reply ended before its release")
	case <-time.After(100 * time.Millisecond):
	}
	h.Release("a")
	select {
	case out := <-done:
		if !strings.Contains(out, "Held reply") || !strings.Contains(out, "message_stop") {
			t.Fatalf("reply = %s", out)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the released reply did not finish")
	}
}
