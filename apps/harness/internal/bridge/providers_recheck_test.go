package bridge_test

import (
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// markerAgent is an agent whose login probe passes while the marker file exists
// and exits 1 (listed as logged out) while it does not.
func markerAgent(id, marker string) map[string]any {
	return agentManifest(id, map[string]any{
		"auth":    map[string]any{"probe": []string{"sh", "-c", "test -f " + marker}, "notLoggedInExit": []int{1}, "hint": "Run `" + id + " login` once."},
		"install": "Install " + id + ".",
	})
}

type recheckEntry struct {
	ID, State, Login string
}

// Decision 2026-11-12: the login probe is advisory. Rule 3 (recheck); creating
// a project is never refused for it (2026-11-15).
func TestRecheckAndUseAnywayOverHTTP(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses sh")
	}
	marker := filepath.Join(t.TempDir(), "logged-in")
	e := newProvEnv(t, "", agentManifest("scripted", nil), markerAgent("grok", marker),
		agentManifest("ghost", map[string]any{"command": "definitely-not-installed-xyz", "install": "npm i -g ghost"}))
	waitUntil(t, "the probe", func() bool { return e.providers(t).entry(t, "grok").State == "not_logged_in" })

	// A model of a logged-out agent is stored as chosen (no refusal, nothing to force) and listed as unusable.
	body := func(model string) map[string]any {
		return map[string]any{"name": "p", "folders": []map[string]string{{"path": e.dir}},
			"models": map[string]string{"orchestrator": model}}
	}
	// An agent that is not installed is refused as unknown to the project (400).
	e.wantError(t, "POST", "/v1/projects", body("acp:ghost"), http.StatusBadRequest, "invalid_request")

	var p struct {
		ID       string
		Models   struct{ Orchestrator string }
		Unusable []struct{ Field, Model string } `json:"models_unavailable"`
	}
	e.into(t, "POST", "/v1/projects", body("acp:grok"), http.StatusCreated, &p)
	if p.Models.Orchestrator != "acp:grok" || len(p.Unusable) != 4 || p.Unusable[0].Field != "orchestrator" {
		t.Fatalf("stored = %+v", p)
	}
	// A model switch on an existing project is the same; force_unverified from an older client is ignored.
	e.into(t, "PATCH", "/v1/projects/"+p.ID, map[string]any{"models": map[string]string{"deep": "acp:grok"}}, http.StatusOK, &p)
	e.into(t, "PATCH", "/v1/projects/"+p.ID, map[string]any{"models": map[string]string{"deep": "acp:grok"}, "force_unverified": true},
		http.StatusOK, &p)
	if p.Models.Orchestrator != "acp:grok" {
		t.Fatalf("after patch = %+v", p)
	}

	// Recheck: still logged out, then the user logs in and the answer changes at once.
	var r recheckEntry
	e.into(t, "POST", "/v1/providers/grok/recheck", nil, http.StatusOK, &r)
	if r.ID != "grok" || r.State != "not_logged_in" {
		t.Fatalf("recheck before login = %+v", r)
	}
	if err := os.WriteFile(marker, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	e.into(t, "POST", "/v1/providers/grok/recheck", nil, http.StatusOK, &r)
	if r.State != "ready" || r.Login != "ok" {
		t.Fatalf("recheck after login = %+v", r)
	}
	if got := e.providers(t).entry(t, "grok").State; got != "ready" {
		t.Fatalf("providers after recheck = %s", got)
	}
	e.createProject(t, map[string]string{"orchestrator": "acp:grok"}, http.StatusCreated, nil)

	for _, id := range []string{"nope", "api"} {
		e.wantError(t, "POST", "/v1/providers/"+id+"/recheck", nil, http.StatusNotFound, "not_found")
	}
	if _, raw := e.do(t, "POST", "/v1/providers/grok/recheck", nil); strings.Contains(string(raw), "logged-in") {
		t.Fatalf("recheck leaked the probe command: %s", raw)
	}
}
