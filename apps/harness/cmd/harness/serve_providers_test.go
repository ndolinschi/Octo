package main

import (
	"encoding/json"
	"strings"
	"testing"
)

// The whole serve stack with no agent installed and no key: nothing can run, a
// project cannot be created; a key written through the settings screen makes
// the built-in loop ready at once, with no restart.
func TestServeProvidersFollowTheAPIKeyLive(t *testing.T) {
	emptyEnv(t)
	t.Setenv("HARNESS_NO_BUILTIN_PLUGINS", "1")
	dir := t.TempDir()
	base := startServe(t, dir, "127.0.0.1")
	work := t.TempDir()

	type resp struct {
		Connected int
		Suggested struct{ Orchestrator, Fast, Balanced, Deep string }
		Providers []struct{ ID, State string }
	}
	get := func() resp {
		status, raw := request(t, "GET", base+"/v1/providers", nil)
		if status != 200 {
			t.Fatalf("GET /v1/providers = %d %s", status, raw)
		}
		var r resp
		if err := json.Unmarshal(raw, &r); err != nil {
			t.Fatal(err)
		}
		return r
	}
	create := func() (int, string) {
		status, raw := request(t, "POST", base+"/v1/projects", map[string]any{"name": "p", "folders": []map[string]string{{"path": work}}})
		return status, string(raw)
	}

	if r := get(); r.Connected != 0 || len(r.Providers) != 2 || r.Providers[0].ID != "api" || r.Providers[0].State != "not_connected" || r.Providers[1].ID != "ollama" {
		t.Fatalf("before: %+v", r)
	}
	// A project never waits for a provider: it is created and lists its models as unusable.
	if status, body := create(); status != 201 || strings.Contains(body, `"models_unavailable":[]`) {
		t.Fatalf("create without a provider = %d %s", status, body)
	}

	const key = "sk-ant-SERVELIVEKEYSECRET-123456"
	status, raw := request(t, "PUT", base+"/v1/settings", map[string]any{"set": map[string]any{"ANTHROPIC_API_KEY": key}})
	if status != 200 || strings.Contains(string(raw), "SERVELIVEKEYSECRET") {
		t.Fatalf("PUT = %d %s", status, raw)
	}
	r := get()
	if r.Connected != 1 || r.Providers[0].State != "ready" || r.Suggested.Orchestrator == "" {
		t.Fatalf("after: %+v", r)
	}
	if status, body := create(); status != 201 || !strings.Contains(body, `"models_unavailable":[]`) {
		t.Fatalf("create with the key = %d %s", status, body)
	}
	if _, raw := request(t, "GET", base+"/v1/providers", nil); strings.Contains(string(raw), "SERVELIVEKEYSECRET") {
		t.Fatal("the key is in /v1/providers")
	}

	// And it goes away just as fast.
	if status, raw := request(t, "PUT", base+"/v1/settings", map[string]any{"unset": []string{"ANTHROPIC_API_KEY"}}); status != 200 {
		t.Fatalf("PUT unset = %d %s", status, raw)
	}
	if r := get(); r.Connected != 0 {
		t.Fatalf("after unset: %+v", r)
	}
}
