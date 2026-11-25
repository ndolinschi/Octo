package bridge_test

import (
	"encoding/json"
	"net/http"
	"slices"
	"strings"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/fakeacp"
	"github.com/ndolinschi/Octo/apps/harness/internal/providers"
)

func withDiscovery(t *testing.T) {
	t.Helper()
	provDiscovery = &providers.Discovery{}
	t.Cleanup(func() { provDiscovery = nil })
}

func rawProvider(t *testing.T, e *provEnv, method, path string, body any, want int) map[string]any {
	t.Helper()
	status, raw := e.do(t, method, path, body)
	if status != want {
		t.Fatalf("%s %s = %d, want %d: %s", method, path, status, want, raw)
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("decode %s: %v", raw, err)
	}
	return out
}

func modelIDsOf(p map[string]any, source string) []string {
	var out []string
	for _, m := range p["models"].([]any) {
		mm := m.(map[string]any)
		if mm["source"] == source {
			out = append(out, mm["id"].(string))
		}
	}
	return out
}

func TestRefreshModelsEndpoint(t *testing.T) {
	t.Run("discovery off", func(t *testing.T) {
		e := newProvEnv(t, "", agentManifest("scripted", nil))
		e.wantError(t, "POST", "/v1/providers/scripted/refresh-models", nil, http.StatusConflict, "discovery_off")
	})
	t.Run("discovers", func(t *testing.T) {
		withDiscovery(t)
		e := newProvEnv(t, "", agentManifest("scripted", map[string]any{
			"env": map[string]string{fakeacp.EnvChild: "1", "GORACE": "atexit_sleep_ms=0",
				fakeacp.EnvModels: "alpha,beta", fakeacp.EnvModelsVia: "config-grouped"},
		}), agentManifest("gone", map[string]any{"command": "/definitely/not/here"}))
		p := rawProvider(t, e, "POST", "/v1/providers/scripted/refresh-models", nil, http.StatusOK)
		if p["id"] != "scripted" || !slices.Equal(modelIDsOf(p, "advertised"), []string{"alpha", "beta"}) || p["models_refreshed_at"] == "" ||
			p["accepts_custom_model"] != true || p["login"] != "unchecked" || p["default_model"] != "alpha" {
			t.Fatalf("provider = %v", p)
		}
		if _, has := p["models_error"]; has {
			t.Fatalf("models_error present on success: %v", p)
		}
		// It is the same entry GET /v1/providers serves.
		got := e.providers(t).entry(t, "scripted")
		if len(got.Models) != 2 || got.Models[0].Source != "advertised" {
			t.Fatalf("GET = %+v", got.Models)
		}
		e.wantError(t, "POST", "/v1/providers/nope/refresh-models", nil, http.StatusNotFound, "not_found")
		e.wantError(t, "POST", "/v1/providers/gone/refresh-models", nil, http.StatusConflict, "not_ready")
	})
	t.Run("a failure is data, not an error response", func(t *testing.T) {
		withDiscovery(t)
		e := newProvEnv(t, "", agentManifest("scripted", map[string]any{
			"env": map[string]string{fakeacp.EnvChild: "1", "GORACE": "atexit_sleep_ms=0", fakeacp.EnvAuth: "interactive"},
		}))
		p := rawProvider(t, e, "POST", "/v1/providers/scripted/refresh-models", nil, http.StatusOK)
		if s, _ := p["models_error"].(string); !strings.Contains(s, "not logged in") || p["models_refreshed_at"] == "" {
			t.Fatalf("provider = %v", p)
		}
	})
}

func TestCustomModelsEndpoint(t *testing.T) {
	e := newProvEnv(t, "", agentManifest("scripted", map[string]any{"models": []string{"alpha"}}))
	p := rawProvider(t, e, "PUT", "/v1/providers/scripted/custom-models", map[string]any{"models": []string{"my-model-9", "vendor/x:7b"}}, http.StatusOK)
	if !slices.Equal(modelIDsOf(p, "custom"), []string{"my-model-9", "vendor/x:7b"}) || !slices.Equal(modelIDsOf(p, "manifest"), []string{"alpha"}) {
		t.Fatalf("provider = %v", p)
	}
	// A typed model is accepted for a project, listed or not, and survives a PATCH.
	var proj struct{ ID string }
	e.createProject(t, map[string]string{"orchestrator": "acp:scripted/never-listed-anywhere"}, http.StatusCreated, &proj)
	e.into(t, "PATCH", "/v1/projects/"+proj.ID, map[string]any{"models": map[string]string{"deep": "acp:scripted/another-typed-one"}}, http.StatusOK, nil)
	for _, bad := range []string{"", "two words", strings.Repeat("a", 81), "-x"} {
		e.wantError(t, "PUT", "/v1/providers/scripted/custom-models", map[string]any{"models": []string{bad}}, http.StatusBadRequest, "invalid_request")
	}
	e.wantError(t, "PUT", "/v1/providers/nope/custom-models", map[string]any{"models": []string{"x"}}, http.StatusNotFound, "not_found")
	e.wantError(t, "PUT", "/v1/providers/api/custom-models", map[string]any{"models": []string{"x"}}, http.StatusNotFound, "not_found")
	// Removable.
	p = rawProvider(t, e, "PUT", "/v1/providers/scripted/custom-models", map[string]any{"models": []string{}}, http.StatusOK)
	if len(modelIDsOf(p, "custom")) != 0 {
		t.Fatalf("provider = %v", p)
	}
}

func TestProviderPrefsEndpoint(t *testing.T) {
	e := newProvEnv(t, "", agentManifest("scripted", map[string]any{
		"models": []string{"opus", "haiku"}, "roles": map[string]string{"fast": "haiku", "deep": "opus"},
	}))
	got := e.providers(t).entry(t, "scripted")
	_ = got
	p := rawProvider(t, e, "PUT", "/v1/providers/scripted/prefs",
		map[string]any{"preferred_model": "opus", "roles": map[string]string{"balanced": "opus", "fast": ""}}, http.StatusOK)
	roles := p["roles"].(map[string]any)
	if p["preferred_model"] != "opus" || roles["fast"] != "" || roles["balanced"] != "opus" || roles["deep"] != "opus" {
		t.Fatalf("provider = %v", p)
	}
	// Seen by GET /v1/providers too.
	again := rawProvider(t, e, "GET", "/v1/providers", nil, http.StatusOK)
	var entry map[string]any
	for _, x := range again["providers"].([]any) {
		if x.(map[string]any)["id"] == "scripted" {
			entry = x.(map[string]any)
		}
	}
	if entry["preferred_model"] != "opus" || entry["roles"].(map[string]any)["balanced"] != "opus" {
		t.Fatalf("entry = %v", entry)
	}
	e.wantError(t, "PUT", "/v1/providers/scripted/prefs", map[string]any{"preferred_model": "has space"}, http.StatusBadRequest, "invalid_request")
	e.wantError(t, "PUT", "/v1/providers/scripted/prefs", map[string]any{"roles": map[string]string{"huge": "x"}}, http.StatusBadRequest, "invalid_request")
	e.wantError(t, "PUT", "/v1/providers/nope/prefs", map[string]any{"preferred_model": "x"}, http.StatusNotFound, "not_found")
}
