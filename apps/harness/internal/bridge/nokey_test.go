package bridge_test

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/anthropicclient"
	"github.com/ndolinschi/Octo/apps/harness/internal/bridge"
	"github.com/ndolinschi/Octo/apps/harness/internal/config"
	"github.com/ndolinschi/Octo/apps/harness/internal/orchestrator"
	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
)

// noKeyEnv is the ACP stack as `harness serve` builds it with no API key and no
// router: the built-in loop is unavailable and a counting upstream stands in
// for the Messages API (it must never be called).
func noKeyEnv(t *testing.T) (*acpEnv, *atomic.Int64) {
	t.Helper()
	var calls atomic.Int64
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		http.Error(w, "unexpected upstream call", http.StatusInternalServerError)
	}))
	t.Cleanup(up.Close)
	e := newACPEnv(t, nil, func(o *orchestrator.Options) {
		o.Client = anthropicclient.New("", up.URL, "")
		o.BuiltinUnavailable = config.NoBuiltinLoopMessage
		o.DefaultOrchestrator = config.DefaultModels().Orchestrator
		agents := o.Agents
		o.AgentSource = func() []plugins.Agent { return agents }
	}, bridge.WithBuiltinLoop(false, config.NoBuiltinLoopMessage), bridge.WithDefaultOrchestrator(func() string { return "acp:scripted" }))
	return e, &calls
}

func TestNoKeyConfigReportsBuiltinLoopUnavailable(t *testing.T) {
	e, _ := noKeyEnv(t)
	var cfg struct {
		BuiltinLoop struct {
			Available bool   `json:"available"`
			Reason    string `json:"reason"`
		} `json:"builtin_loop"`
		DefaultOrchestrator string `json:"default_orchestrator"`
	}
	e.into(t, "GET", "/v1/config", nil, http.StatusOK, &cfg)
	if cfg.BuiltinLoop.Available || cfg.BuiltinLoop.Reason != config.NoBuiltinLoopMessage || cfg.DefaultOrchestrator != "acp:scripted" {
		t.Fatalf("config = %+v", cfg)
	}
}

func TestConfigWithKeyReportsBuiltinLoopAvailable(t *testing.T) {
	e := newACPEnv(t, nil, nil)
	var cfg map[string]any
	e.into(t, "GET", "/v1/config", nil, http.StatusOK, &cfg)
	bl, _ := cfg["builtin_loop"].(map[string]any)
	if bl["available"] != true || bl["reason"] != nil || cfg["default_orchestrator"] != config.DefaultModels().Orchestrator {
		t.Fatalf("config = %v", cfg)
	}
}

// Acceptance 2: a turn on an acp: orchestrator completes with no key anywhere,
// and what needs the built-in loop fails with the one message and no upstream call.
func TestNoKeyACPTurnCompletesAndBuiltinWorkFailsCleanly(t *testing.T) {
	e, calls := noKeyEnv(t)

	p := e.acpProject(t)
	tr := e.ask(t, p, "[mcp-spawn-builtin] look around")
	if tr.status != "completed" {
		t.Fatalf("status = %s (%v)", tr.status, tr.errMsg)
	}
	text := e.lastText(t, p)
	if !strings.Contains(text, config.NoBuiltinLoopMessage) {
		t.Fatalf("the built-in sub-agent did not fail with the message: %s", text)
	}
	failed := 0
	for _, a := range e.agents(t, p) {
		if a.ParentID != nil && a.Status == "failed" && a.Error != nil && *a.Error == "The built-in agent has no API key." {
			failed++
		}
	}
	if failed != 1 {
		t.Fatalf("want one failed built-in sub-agent with the message, got %d: %+v", failed, e.agents(t, p))
	}

	// An explicit built-in model: the turn fails with the message.
	b := e.project(t, map[string]string{"orchestrator": "claude-opus-5-5"})
	tr = e.ask(t, b, "hello")
	if tr.status != "failed" || tr.errMsg != "The built-in agent has no API key." {
		t.Fatalf("builtin turn = %s (%v)", tr.status, tr.errMsg)
	}

	// No explicit orchestrator: the first ready ACP agent runs it.
	d := e.project(t, nil)
	tr = e.ask(t, d, "[echo] hi")
	if tr.status != "completed" {
		t.Fatalf("default-orchestrator turn = %s (%v)", tr.status, tr.errMsg)
	}
	for _, a := range e.agents(t, d) {
		if a.ParentID == nil && a.Model != "acp:scripted" {
			t.Fatalf("orchestrator model = %q, want acp:scripted", a.Model)
		}
	}

	if n := calls.Load(); n != 0 {
		t.Fatalf("%d upstream requests, want 0", n)
	}
}

func TestNoKeyCompletionIsOffWithTheReasonAndNeverCallsUpstream(t *testing.T) {
	e, calls := noKeyEnv(t)
	var proj struct{ ID string }
	e.into(t, "POST", "/v1/projects", map[string]any{"name": "p", "folders": []map[string]string{{"path": t.TempDir()}}}, http.StatusCreated, &proj)
	e.into(t, "PATCH", "/v1/projects/"+proj.ID, map[string]any{"models": map[string]string{"completion": "fast"}}, http.StatusOK, nil)
	var resp struct {
		Error struct{ Code, Message, Details string } `json:"error"`
	}
	e.into(t, "POST", "/v1/projects/"+proj.ID+"/complete", map[string]any{"path": "a.go", "prefix": "x"}, http.StatusConflict, &resp)
	if resp.Error.Code != "completion_off" || resp.Error.Details != config.NoBuiltinLoopMessage {
		t.Fatalf("error = %+v", resp.Error)
	}
	if calls.Load() != 0 {
		t.Fatalf("upstream calls = %d", calls.Load())
	}
}
