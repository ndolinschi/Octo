package orchestrator_test

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/fakeacp"
	"github.com/ndolinschi/Octo/apps/harness/internal/mockllm"
	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

func modelAgent(env map[string]string, edit func(*plugins.Agent)) plugins.Agent {
	a := fakeAgent("fake", true)
	for k, v := range env {
		a.Env[k] = v
	}
	if edit != nil {
		edit(&a)
	}
	return a
}

func projectWithReadme(t *testing.T, r *rig) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("# models\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return r.projectAt(t, dir)
}

func usageModels(t *testing.T, r *rig, pid, agentID string) []string {
	t.Helper()
	db, err := r.store.Get(context.Background(), pid)
	if err != nil {
		t.Fatal(err)
	}
	rows, err := db.UsageRows(context.Background(), "0000", "9999", projectstore.GroupAgent)
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, row := range rows {
		if row.Key == agentID {
			out = append(out, row.Model)
		}
	}
	return out
}

func TestACPModelSelectionRecorded(t *testing.T) {
	withModels := func(a *plugins.Agent) { a.Models, a.DefaultModel = []string{"alpha", "beta"}, "alpha" }
	tests := []struct {
		name      string
		env       map[string]string
		edit      func(*plugins.Agent)
		prompt    string
		wantModel string
		wantText  string
	}{
		{"requested model via set_model", map[string]string{fakeacp.EnvModels: "alpha,beta"}, withModels,
			"[acp] [model:beta] go", "acp:fake/beta", "Model in use: beta."},
		{"requested model via config option", map[string]string{fakeacp.EnvModels: "alpha,beta", fakeacp.EnvModelsVia: "config"}, withModels,
			"[acp] [model:beta] go", "acp:fake/beta", "Model in use: beta."},
		{"manifest default", map[string]string{fakeacp.EnvModels: "alpha,beta"}, withModels,
			"[acp] go", "acp:fake/alpha", "Model in use: alpha."},
		{"no models anywhere", nil, nil, "[acp] go", "acp:fake", "Summary:"},
		{"modelArg at spawn", nil, func(a *plugins.Agent) { a.ModelArg = []string{"--model", "{model}"} },
			"[acp] [model:custom-1] go", "acp:fake/custom-1", "Model in use: custom-1."},
		{"auth then model", map[string]string{fakeacp.EnvAuth: "ok", fakeacp.EnvModels: "alpha,beta"}, withModels,
			"[acp] [model:beta] go", "acp:fake/beta", "Model in use: beta."},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			r := newACPRig(t, mockllm.New(0), modelAgent(tc.env, tc.edit))
			pid := projectWithReadme(t, r)
			if got := r.runCollect(t, pid, tc.prompt, nil); got.status != "completed" {
				t.Fatalf("turn = %s", got.status)
			}
			child := r.acpChild(t, pid)
			if child.Model != tc.wantModel || child.Status != projectstore.StatusCompleted {
				t.Fatalf("child = %+v, want model %s", child, tc.wantModel)
			}
			if child.Result == nil || !strings.Contains(*child.Result, tc.wantText) {
				t.Fatalf("result = %v, want %q", child.Result, tc.wantText)
			}
			rows := usageModels(t, r, pid, child.ID)
			if len(rows) != 1 || rows[0] != tc.wantModel {
				t.Fatalf("usage models = %v, want [%s] (kept consistent with the agent)", rows, tc.wantModel)
			}
		})
	}
}

func TestACPModelRejectedBeforeSpawn(t *testing.T) {
	withModels := func(a *plugins.Agent) { a.Models, a.DefaultModel = []string{"alpha", "beta"}, "alpha" }
	tests := []struct {
		name, prompt, wantMsg string
	}{
		{"not in the manifest list", "[acp] [model:gamma] go", `has no model "gamma"; choose one of: alpha, beta`},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			r := newACPRig(t, mockllm.New(0), modelAgent(map[string]string{fakeacp.EnvModels: "alpha,beta"}, withModels))
			pid := projectWithReadme(t, r)
			r.runCollect(t, pid, tc.prompt, nil)
			res, isErr := orchestratorToolResult(t, r, pid)
			if !isErr || !strings.Contains(res, tc.wantMsg) {
				t.Fatalf("tool result = %q (error=%v), want %q", res, isErr, tc.wantMsg)
			}
			for _, a := range r.agents(t, pid) {
				if a.ParentID != nil {
					t.Fatalf("a sub-agent was created for a rejected model: %+v", a)
				}
			}
		})
	}
}

func TestACPModelRefusedByAgentFailsSubAgent(t *testing.T) {
	// The manifest lists no models, so the request reaches the agent, which refuses it.
	env := map[string]string{fakeacp.EnvModels: "alpha", fakeacp.EnvRefuseModel: "1"}
	r := newACPRig(t, mockllm.New(0), modelAgent(env, nil))
	pid := projectWithReadme(t, r)
	r.runCollect(t, pid, "[acp] [model:zeta] go", nil)
	child := r.acpChild(t, pid)
	if child.Status != projectstore.StatusFailed || child.Error == nil || !strings.Contains(*child.Error, "unknown model zeta") {
		t.Fatalf("child = %+v", child)
	}
}

func TestACPLoginRequiredFailsWithHint(t *testing.T) {
	const hint = "Run `fake login` in a terminal."
	r := newACPRig(t, mockllm.New(0), modelAgent(map[string]string{fakeacp.EnvAuth: "interactive"},
		func(a *plugins.Agent) { a.Hint = hint }))
	pid := projectWithReadme(t, r)
	if got := r.runCollect(t, pid, "[acp] go", nil); got.status != "completed" {
		t.Fatalf("a failed sub-agent must not fail the turn: %s", got.status)
	}
	child := r.acpChild(t, pid)
	if child.Status != projectstore.StatusFailed || child.Error == nil ||
		!strings.Contains(*child.Error, hint) || !strings.Contains(*child.Error, "not logged in") {
		t.Fatalf("child = %+v", child)
	}
	if res, isErr := orchestratorToolResult(t, r, pid); !isErr || !strings.Contains(res, hint) {
		t.Fatalf("parent saw %q (error=%v)", res, isErr)
	}
}

func TestACPEnvReferencesResolvedAtSpawn(t *testing.T) {
	edit := func(a *plugins.Agent) { a.Env[fakeacp.EnvModels] = "${OCTO_TEST_FAKE_MODELS}" }
	t.Run("set", func(t *testing.T) {
		t.Setenv("OCTO_TEST_FAKE_MODELS", "from-env,other")
		r := newACPRig(t, mockllm.New(0), modelAgent(nil, edit))
		pid := projectWithReadme(t, r)
		r.runCollect(t, pid, "[acp] go", nil)
		if child := r.acpChild(t, pid); child.Result == nil || !strings.Contains(*child.Result, "Model in use: from-env.") {
			t.Fatalf("result = %v", child.Result)
		}
	})
	t.Run("missing stays unset", func(t *testing.T) {
		r := newACPRig(t, mockllm.New(0), modelAgent(nil, edit))
		pid := projectWithReadme(t, r)
		r.runCollect(t, pid, "[acp] go", nil)
		child := r.acpChild(t, pid)
		if child.Result == nil || strings.Contains(*child.Result, "Model in use") || child.Status != projectstore.StatusCompleted {
			t.Fatalf("child = %+v", child)
		}
	})
}
