package bridge_test

import (
	"net/http"
	"os"
	"path/filepath"
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

	// Creating a project on an unsupported agent is not refused either: it is stored and listed as unusable.
	var p struct {
		Unusable []struct{ Provider, Reason string } `json:"models_unavailable"`
	}
	e.createProject(t, map[string]string{"orchestrator": "acp:nope"}, http.StatusCreated, &p)
	if len(p.Unusable) != 1 || p.Unusable[0].Provider != "nope" || p.Unusable[0].Reason != "Nope does not work with Octo yet." {
		t.Fatalf("create = %+v", p)
	}
	if status, _ := e.do(t, "POST", "/v1/providers/nope/recheck", nil); status != http.StatusOK {
		t.Fatalf("recheck status = %d", status)
	}
	if _, err := os.Stat(ran); err == nil {
		t.Fatal("the probe of an unsupported agent ran")
	}
}
