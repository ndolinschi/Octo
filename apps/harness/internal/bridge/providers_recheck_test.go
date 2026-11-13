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

type apiForceError struct {
	Error struct {
		Code, Message, Provider, Reason string
		CanForce                        *bool `json:"can_force"`
	} `json:"error"`
}

// Decision 2026-11-12: the login probe is advisory. Rule 3 (recheck), rule 4
// (can_force and force_unverified, not_installed never forced).
func TestRecheckAndUseAnywayOverHTTP(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses sh")
	}
	marker := filepath.Join(t.TempDir(), "logged-in")
	e := newProvEnv(t, "", agentManifest("scripted", nil), markerAgent("grok", marker),
		agentManifest("ghost", map[string]any{"command": "definitely-not-installed-xyz", "install": "npm i -g ghost"}))
	waitUntil(t, "the probe", func() bool { return e.providers(t).entry(t, "grok").State == "not_logged_in" })

	// A refusal for a login says it can be forced; one for a missing command cannot.
	var er apiForceError
	e.createProject(t, map[string]string{"orchestrator": "acp:grok"}, http.StatusUnprocessableEntity, &er)
	if er.Error.Code != "model_unavailable" || er.Error.CanForce == nil || !*er.Error.CanForce || er.Error.Provider != "grok" {
		t.Fatalf("grok refusal = %+v", er)
	}
	body := func(model string) map[string]any {
		return map[string]any{"name": "p", "folders": []map[string]string{{"path": e.dir}},
			"models": map[string]string{"orchestrator": model}, "force_unverified": true}
	}
	// An agent that is not installed is refused as unknown to the project (400), force or not.
	e.wantError(t, "POST", "/v1/projects", body("acp:ghost"), http.StatusBadRequest, "invalid_request")

	// Use anyway: accepted and stored; reading still lists it as unusable.
	var p struct {
		ID       string
		Models   struct{ Orchestrator string }
		Unusable []struct{ Field, Model string } `json:"models_unavailable"`
	}
	e.into(t, "POST", "/v1/projects", body("acp:grok"), http.StatusCreated, &p)
	if p.Models.Orchestrator != "acp:grok" {
		t.Fatalf("stored = %q", p.Models.Orchestrator)
	}
	// A model switch on an existing project takes the same path.
	e.into(t, "PATCH", "/v1/projects/"+p.ID, map[string]any{"models": map[string]string{"deep": "acp:grok"}},
		http.StatusUnprocessableEntity, &er)
	if er.Error.CanForce == nil || !*er.Error.CanForce {
		t.Fatalf("patch refusal = %+v", er)
	}
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
