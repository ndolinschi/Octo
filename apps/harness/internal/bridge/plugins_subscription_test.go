package bridge_test

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/events"
	"github.com/ndolinschi/Octo/apps/harness/internal/fakeacp"
	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

type apiAgent struct {
	ID           string   `json:"id"`
	LoggedIn     *bool    `json:"logged_in"`
	Models       []string `json:"models"`
	DefaultModel string   `json:"default_model"`
	Hint         string   `json:"hint"`
}

// subscriptionRegistry loads a plugin whose agent needs authenticate, offers
// two models and has a login probe that checks for loginFile.
func subscriptionRegistry(t *testing.T, loginFile string) *plugins.Registry {
	t.Helper()
	data := t.TempDir()
	writeManifest(t, data, "subs", map[string]any{
		"name": "subs", "version": "1",
		"agents": []map[string]any{
			{
				"id": "fake", "label": "Fake", "command": os.Args[0],
				"models": []string{"alpha", "beta"}, "defaultModel": "alpha",
				"env": map[string]string{
					fakeacp.EnvChild: "1", "GORACE": "atexit_sleep_ms=0", fakeacp.EnvAuth: "ok",
					fakeacp.EnvModels: "alpha,beta", fakeacp.EnvLoginFile: loginFile,
				},
				"auth": map[string]any{"probe": []string{"sh", "-c", `test -f "$0"`, loginFile}, "hint": "Run fake login."},
			},
			{"id": "noprobe", "command": os.Args[0], "env": map[string]string{fakeacp.EnvChild: "1"}},
		},
	})
	reg := plugins.Load(context.Background(), data, nil, nil)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	reg.StartProbes(ctx)
	return reg
}

func fetchAgents(t *testing.T, e *env, wait func([]apiAgent) bool) []apiAgent {
	t.Helper()
	var out []apiAgent
	deadline := time.Now().Add(5 * time.Second)
	for {
		var body struct {
			Plugins []struct{ Agents []apiAgent } `json:"plugins"`
		}
		e.into(t, "GET", "/v1/plugins", nil, http.StatusOK, &body)
		out = nil
		for _, p := range body.Plugins {
			out = append(out, p.Agents...)
		}
		if wait(out) || time.Now().After(deadline) {
			return out
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestPluginsAgentLoginState(t *testing.T) {
	loginFile := filepath.Join(t.TempDir(), "login")
	tests := []struct {
		name     string
		loggedIn bool
	}{{"logged in", true}, {"logged out", false}}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if tc.loggedIn {
				if err := os.WriteFile(loginFile, nil, 0o644); err != nil {
					t.Fatal(err)
				}
			} else if err := os.Remove(loginFile); err != nil && !os.IsNotExist(err) {
				t.Fatal(err)
			}
			e := newEnvWith(t, nil, subscriptionRegistry(t, loginFile))
			agents := fetchAgents(t, e, func(as []apiAgent) bool {
				return len(as) == 2 && as[0].LoggedIn != nil
			})
			fake, plain := agents[0], agents[1]
			if fake.LoggedIn == nil || *fake.LoggedIn != tc.loggedIn {
				t.Fatalf("logged_in = %v, want %v", fake.LoggedIn, tc.loggedIn)
			}
			if len(fake.Models) != 2 || fake.DefaultModel != "alpha" || fake.Hint != "Run fake login." {
				t.Fatalf("agent = %+v", fake)
			}
			if plain.LoggedIn != nil || plain.Models == nil || len(plain.Models) != 0 {
				t.Fatalf("agent without probe = %+v, want logged_in null and an empty model list", plain)
			}
		})
	}
}

func TestACPSubAgentWithChosenModelOverHTTP(t *testing.T) {
	loginFile := filepath.Join(t.TempDir(), "login")
	if err := os.WriteFile(loginFile, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	e := newEnvWith(t, nil, subscriptionRegistry(t, loginFile))
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("# Models\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	var p struct{ ID string }
	e.into(t, "POST", "/v1/projects", map[string]any{"name": "m", "folders": []map[string]string{{"path": dir}}}, http.StatusCreated, &p)
	stream := e.subscribe(t, p.ID)
	e.into(t, "POST", "/v1/projects/"+p.ID+"/messages", map[string]string{"text": "[acp] [model:beta] look"}, http.StatusAccepted, nil)
	if got := count(collectUntilTurnFinished(t, stream), events.AgentCreated); got < 1 {
		t.Fatalf("agent.created events = %d", got)
	}
	var agents struct{ Agents []projectstore.Agent }
	e.into(t, "GET", "/v1/projects/"+p.ID+"/agents", nil, http.StatusOK, &agents)
	for _, a := range agents.Agents {
		if a.ParentID != nil {
			if a.Model != "acp:fake/beta" || a.Status != projectstore.StatusCompleted || a.Result == nil {
				t.Fatalf("sub-agent = %+v", a)
			}
			return
		}
	}
	t.Fatalf("no sub-agent in %+v", agents.Agents)
}
