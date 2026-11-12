package orchestrator_test

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/config"
	"github.com/ndolinschi/Octo/apps/harness/internal/orchestrator"
	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
)

// upstreamCounter is a Messages API that counts every request except the
// router health probe and answers 500 (nothing must ever reach it).
type upstreamCounter struct{ n atomic.Int64 }

func (u *upstreamCounter) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/health" {
		http.NotFound(w, r)
		return
	}
	u.n.Add(1)
	http.Error(w, "unexpected upstream call", http.StatusInternalServerError)
}

func TestNoBuiltinLoopOrchestratorTurnFailsWithoutUpstreamCall(t *testing.T) {
	up := &upstreamCounter{}
	r := newRigWith(t, up, orchestrator.Options{BuiltinUnavailable: config.NoBuiltinLoopMessage})
	pid := r.project(t, 2)
	if st := r.run(t, pid, "build it", nil); st != "failed" {
		t.Fatalf("turn status = %s, want failed", st)
	}
	orch := r.agents(t, pid)[0]
	if orch.Error == nil || *orch.Error != config.NoBuiltinLoopMessage {
		t.Fatalf("orchestrator error = %v, want the one message", orch.Error)
	}
	if n := up.n.Load(); n != 0 {
		t.Fatalf("%d upstream requests, want 0", n)
	}
}

func TestNoBuiltinLoopSideQuestionFailsWithoutUpstreamCall(t *testing.T) {
	up := &upstreamCounter{}
	r := newRigWith(t, up, orchestrator.Options{BuiltinUnavailable: config.NoBuiltinLoopMessage})
	pid := r.project(t, 2)
	a := r.api(t)
	ch, cancel := r.hub.Subscribe(pid)
	defer cancel()
	_, id := a.ask(pid, "what is this?")
	final, _ := awaitSide(t, ch, id)
	if final.Error != config.NoBuiltinLoopMessage {
		t.Fatalf("side error = %q, want the one message", final.Error)
	}
	if n := up.n.Load(); n != 0 {
		t.Fatalf("%d upstream requests, want 0", n)
	}
}

func TestBuiltinAvailableByDefault(t *testing.T) {
	r := newRig(t, &upstreamCounter{})
	if got := r.orch.EffectiveOrchestrator("claude-sonnet-5-5"); got != "claude-sonnet-5-5" {
		t.Fatalf("effective = %q", got)
	}
}

func agentWith(id string, probe bool, loggedIn *bool) plugins.Agent {
	a := plugins.Agent{ID: id, Label: id, Available: true, LoggedIn: loggedIn}
	if probe {
		a.ProbeCommand = "/bin/probe"
	}
	return a
}

func bp(v bool) *bool { return &v }

func TestEffectiveOrchestrator(t *testing.T) {
	const def = "claude-sonnet-5-5"
	unavailable := agentWith("claude-code", true, bp(true))
	unavailable.Available = false
	for name, tc := range map[string]struct {
		agents []plugins.Agent
		model  string
		want   string
	}{
		"claude-code first": {[]plugins.Agent{agentWith("copilot", false, nil), agentWith("claude-code", true, bp(true))}, def, "acp:claude-code"},
		"order claude-code, codex, copilot": {
			[]plugins.Agent{agentWith("grok", false, nil), agentWith("copilot", false, nil), agentWith("codex", true, bp(true))}, def, "acp:codex"},
		"copilot before the rest": {[]plugins.Agent{agentWith("grok", false, nil), agentWith("copilot", false, nil)}, def, "acp:copilot"},
		"rest in load order":      {[]plugins.Agent{agentWith("zed", false, nil), agentWith("grok", false, nil)}, def, "acp:zed"},
		"probe false is skipped":  {[]plugins.Agent{agentWith("claude-code", true, bp(false)), agentWith("codex", true, bp(true))}, def, "acp:codex"},
		"probe unknown leaves the login unchecked, which is usable": {
			[]plugins.Agent{agentWith("claude-code", true, nil), agentWith("grok", false, nil)}, def, "acp:claude-code"},
		"unavailable is skipped": {[]plugins.Agent{unavailable, agentWith("grok", false, nil)}, def, "acp:grok"},
		"none logged in keeps the built-in default": {
			[]plugins.Agent{agentWith("claude-code", true, bp(false)), unavailable}, def, def},
		"no agents":              {nil, def, def},
		"explicit model is kept": {[]plugins.Agent{agentWith("claude-code", true, bp(true))}, "claude-opus-5-5", "claude-opus-5-5"},
		"explicit acp is kept":   {[]plugins.Agent{agentWith("claude-code", true, bp(true))}, "acp:grok", "acp:grok"},
	} {
		t.Run(name, func(t *testing.T) {
			r := newRigWith(t, &upstreamCounter{}, orchestrator.Options{
				BuiltinUnavailable: config.NoBuiltinLoopMessage, DefaultOrchestrator: def,
				AgentSource: func() []plugins.Agent { return tc.agents },
			})
			if got := r.orch.EffectiveOrchestrator(tc.model); got != tc.want {
				t.Fatalf("effective(%q) = %q, want %q", tc.model, got, tc.want)
			}
		})
	}
}

func TestEffectiveOrchestratorNeedsNoChoiceWhenBuiltinAvailable(t *testing.T) {
	r := newRigWith(t, &upstreamCounter{}, orchestrator.Options{
		DefaultOrchestrator: "m", AgentSource: func() []plugins.Agent { return []plugins.Agent{agentWith("claude-code", true, bp(true))} },
	})
	if got := r.orch.DefaultOrchestrator(); got != "m" {
		t.Fatalf("default orchestrator = %q, want m", got)
	}
}

// With fake manifests: real probes (true / false) and the real registry.
func TestDefaultOrchestratorFromManifestsAndProbes(t *testing.T) {
	data := t.TempDir()
	dir := filepath.Join(data, "plugins", "fakes")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	manifest := `{"name":"fakes","version":"1","agents":[
	  {"id":"claude-code","command":"sh","auth":{"probe":["false"],"notLoggedInExit":[1]}},
	  {"id":"codex","command":"sh","auth":{"probe":["true"]}},
	  {"id":"copilot","command":"sh"}]}`
	if err := os.WriteFile(filepath.Join(dir, plugins.ManifestName), []byte(manifest), 0o644); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	reg := plugins.Load(ctx, data, nil, nil)
	reg.StartProbes(ctx)
	r := newRigWith(t, &upstreamCounter{}, orchestrator.Options{
		BuiltinUnavailable: config.NoBuiltinLoopMessage, DefaultOrchestrator: "claude-sonnet-5-5", AgentSource: reg.Agents,
	})
	deadline := time.Now().Add(10 * time.Second)
	for {
		// claude-code is logged out (probe false), codex logged in (probe true),
		// copilot has no probe: codex comes first of the ready ones.
		if got := r.orch.DefaultOrchestrator(); got == "acp:codex" {
			break
		} else if time.Now().After(deadline) {
			t.Fatalf("default orchestrator = %q, want acp:codex", got)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// The default is chosen when a turn starts and shows on the orchestrator agent;
// it is not stored in the project.
func TestDefaultOrchestratorRunsTurnOnACPAgentWithoutKey(t *testing.T) {
	up := &upstreamCounter{}
	r := newRigWith(t, up, orchestrator.Options{
		BuiltinUnavailable: config.NoBuiltinLoopMessage, DefaultOrchestrator: config.DefaultModels().Orchestrator,
		AgentSource: func() []plugins.Agent { return []plugins.Agent{fakeAgent("scripted", true)} },
	})
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("# x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	pid := r.projectAt(t, dir)
	if st := r.run(t, pid, "hello", nil); st != "completed" {
		orch := r.agents(t, pid)[0]
		t.Fatalf("turn status = %s (%v)", st, orch.Error)
	}
	orch := r.agents(t, pid)[0]
	if orch.Model != "acp:scripted" {
		t.Fatalf("orchestrator model = %q, want acp:scripted", orch.Model)
	}
	db, err := r.store.Get(context.Background(), pid)
	if err != nil {
		t.Fatal(err)
	}
	info, _ := db.Info(context.Background())
	if !strings.Contains(info.ModelsJSON, config.DefaultModels().Orchestrator) || strings.Contains(info.ModelsJSON, "acp:") {
		t.Fatalf("the choice must not be stored: %s", info.ModelsJSON)
	}
	if n := up.n.Load(); n != 0 {
		t.Fatalf("%d upstream requests, want 0", n)
	}
}

func TestSetDefaultOrchestratorAppliesToTheNextLookupUnderConcurrency(t *testing.T) {
	agents := []plugins.Agent{agentWith("claude-code", true, bp(true))}
	r := newRigWith(t, &upstreamCounter{}, orchestrator.Options{
		BuiltinUnavailable: config.NoBuiltinLoopMessage, DefaultOrchestrator: "old-default",
		AgentSource: func() []plugins.Agent { return agents },
	})
	// A project holding the old default runs on the ready ACP agent.
	if got := r.orch.EffectiveOrchestrator("old-default"); got != "acp:claude-code" {
		t.Fatalf("effective(old) = %q", got)
	}
	r.orch.SetDefaultOrchestrator("new-default")
	if got := r.orch.EffectiveOrchestrator("new-default"); got != "acp:claude-code" {
		t.Fatalf("effective(new) = %q", got)
	}
	// What was the default is now an explicit choice and stays as it is.
	if got := r.orch.EffectiveOrchestrator("old-default"); got != "old-default" {
		t.Fatalf("effective(old) after swap = %q", got)
	}

	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := 0; i < 300; i++ {
			r.orch.SetDefaultOrchestrator("a")
			r.orch.SetDefaultOrchestrator("b")
		}
	}()
	for i := 0; i < 300; i++ {
		_ = r.orch.DefaultOrchestrator()
		_ = r.orch.EffectiveOrchestrator("a")
	}
	<-done
}
