package bridge_test

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// An agent whose manifest says `unsupported` is listed as not_supported with
// that reason, never ready, never probed, and refused with 422 model_unavailable
// and the reason (not forceable). Verified agents are not experimental.
func TestUnsupportedAndExperimentalAgents(t *testing.T) {
	const why = "This CLI has no Agent Client Protocol mode."
	ran := filepath.Join(t.TempDir(), "probe-ran")
	e := newProvEnv(t, "", agentManifest("scripted", map[string]any{"verified": true}),
		agentManifest("nope", map[string]any{
			"unsupported": why, "install": "npm i -g nope",
			"auth": map[string]any{"probe": []string{"sh", "-c", "touch " + ran}},
		}))
	r := e.providers(t)
	nope := r.entry(t, "nope")
	if nope.State != "not_supported" || nope.Reason != "Nope does not work with Octo yet." || nope.InstallHint != "npm i -g nope" {
		t.Fatalf("nope = %+v", nope)
	}
	if r.Connected != 1 {
		t.Fatalf("connected = %d, only the scripted agent is ready", r.Connected)
	}
	var raw struct {
		Providers []struct {
			ID           string
			Experimental bool
		}
	}
	e.into(t, "GET", "/v1/providers", nil, http.StatusOK, &raw)
	for _, p := range raw.Providers {
		if p.ID == "scripted" && p.Experimental {
			t.Error("a verified agent is experimental")
		}
		if p.ID == "nope" && !p.Experimental {
			t.Error("an unverified agent is not experimental")
		}
	}

	var er apiForceError
	e.createProject(t, map[string]string{"orchestrator": "acp:nope"}, http.StatusUnprocessableEntity, &er)
	if er.Error.Code != "model_unavailable" || er.Error.Provider != "nope" || er.Error.Reason != "Nope does not work with Octo yet." || er.Error.CanForce == nil || *er.Error.CanForce {
		t.Fatalf("refusal = %+v", er)
	}
	body := map[string]any{"name": "p", "folders": []map[string]string{{"path": e.dir}},
		"models": map[string]string{"orchestrator": "acp:nope/x"}, "force_unverified": true}
	e.into(t, "POST", "/v1/projects", body, http.StatusUnprocessableEntity, &er)
	if !strings.Contains(er.Error.Reason, "does not work") {
		t.Fatalf("forced refusal = %+v", er)
	}
	if status, _ := e.do(t, "POST", "/v1/providers/nope/recheck", nil); status != http.StatusOK {
		t.Fatalf("recheck status = %d", status)
	}
	if _, err := os.Stat(ran); err == nil {
		t.Fatal("the probe of an unsupported agent ran")
	}
}
