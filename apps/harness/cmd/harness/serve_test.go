package main

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/config"
	"github.com/ndolinschi/Octo/apps/harness/internal/tools"
)

// emptyEnv clears everything the harness reads, and hides every agent CLI.
func emptyEnv(t *testing.T) {
	t.Helper()
	for _, k := range []string{
		"ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "HARNESS_OCTO_KEY", "HARNESS_PLUGINS_DIR", "HARNESS_DATA_DIR",
		"HARNESS_NO_BUILTIN_PLUGINS", "HARNESS_MODEL_ORCHESTRATOR", "HARNESS_MODEL_FAST", "HARNESS_PROMPT_CACHING",
		"HARNESS_CHILD_ENV_ALLOW",
	} {
		t.Setenv(k, "")
		_ = os.Unsetenv(k)
	}
	t.Setenv("PATH", t.TempDir())
}

func freeAddr(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	return ln.Addr().String()
}

// Acceptance 1: serve with an empty environment starts, lists the built-in
// agents in /v1/plugins and reports the built-in loop unavailable.
func TestServeStartsWithoutAnyKey(t *testing.T) {
	emptyEnv(t)
	cfg, _, err := serveConfig([]string{"--data-dir", t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	if ok, _ := cfg.BuiltinLoop(); ok {
		t.Fatal("empty environment must not have the built-in loop")
	}
	addr := freeAddr(t)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- serve(ctx, cfg, addr) }()
	t.Cleanup(func() {
		cancel()
		select {
		case err := <-done:
			if err != nil {
				t.Errorf("serve: %v", err)
			}
		case <-time.After(15 * time.Second):
			t.Error("serve did not stop")
		}
	})
	base := "http://" + addr
	getJSON := func(path string, v any) {
		t.Helper()
		var resp *http.Response
		deadline := time.Now().Add(10 * time.Second)
		for {
			resp, err = http.Get(base + path)
			if err == nil || time.Now().After(deadline) {
				break
			}
			time.Sleep(20 * time.Millisecond)
		}
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != 200 {
			t.Fatalf("%s = %d", path, resp.StatusCode)
		}
		if err := json.NewDecoder(resp.Body).Decode(v); err != nil {
			t.Fatal(err)
		}
	}
	var pl struct {
		Plugins []struct {
			Name    string `json:"name"`
			Builtin bool   `json:"builtin"`
			Agents  []struct {
				ID string `json:"id"`
			} `json:"agents"`
			Errors []string `json:"errors"`
		} `json:"plugins"`
	}
	getJSON("/v1/plugins", &pl)
	if len(pl.Plugins) != 1 || pl.Plugins[0].Name != "subscription-agents" || !pl.Plugins[0].Builtin ||
		len(pl.Plugins[0].Agents) != 11 || len(pl.Plugins[0].Errors) != 0 {
		t.Fatalf("plugins = %+v", pl.Plugins)
	}
	var c struct {
		BuiltinLoop struct {
			Available bool   `json:"available"`
			Reason    string `json:"reason"`
		} `json:"builtin_loop"`
		DefaultOrchestrator string `json:"default_orchestrator"`
	}
	getJSON("/v1/config", &c)
	if c.BuiltinLoop.Available || c.BuiltinLoop.Reason != config.NoBuiltinLoopMessage {
		t.Fatalf("builtin_loop = %+v", c.BuiltinLoop)
	}
	// Nothing is installed (PATH is empty), so no agent is ready and the
	// built-in default stays.
	if c.DefaultOrchestrator != config.DefaultModels().Orchestrator {
		t.Fatalf("default_orchestrator = %q", c.DefaultOrchestrator)
	}
}

func TestBuiltinPluginsOffSwitch(t *testing.T) {
	for name, tc := range map[string]struct {
		args []string
		env  string
	}{"flag": {[]string{"--no-builtin-plugins"}, ""}, "env": {nil, "1"}} {
		t.Run(name, func(t *testing.T) {
			emptyEnv(t)
			t.Setenv("HARNESS_NO_BUILTIN_PLUGINS", tc.env)
			cfg, _, err := serveConfig(append([]string{"--data-dir", t.TempDir()}, tc.args...))
			if err != nil {
				t.Fatal(err)
			}
			if reg := loadPlugins(context.Background(), cfg, tools.NewRegistry()); len(reg.Plugins()) != 0 {
				t.Fatalf("plugins = %+v", reg.Plugins())
			}
		})
	}
	emptyEnv(t)
	cfg, _, err := serveConfig([]string{"--data-dir", t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	if reg := loadPlugins(context.Background(), cfg, tools.NewRegistry()); len(reg.Plugins()) != 1 {
		t.Fatalf("default must load the built-in plugin: %+v", reg.Plugins())
	}
}

// Acceptance 3: harness.env is read, a group-readable one is refused, the
// process environment wins, and flags win over both.
func TestServeConfigReadsHarnessEnv(t *testing.T) {
	emptyEnv(t)
	dir := t.TempDir()
	write := func(mode os.FileMode) {
		t.Helper()
		p := filepath.Join(dir, config.EnvFileName)
		body := "ANTHROPIC_API_KEY=sk-from-file\nHARNESS_MODEL_FAST=fast-from-file\nHARNESS_MODEL_ORCHESTRATOR=orch-from-file\nHARNESS_CHILD_ENV_ALLOW=FOO\n"
		if err := os.WriteFile(p, []byte(body), mode); err != nil {
			t.Fatal(err)
		}
		_ = os.Chmod(p, mode)
	}

	write(0o640)
	cfg, _, err := serveConfig([]string{"--data-dir", dir})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.APIKey != "" {
		t.Fatal("a group-readable harness.env must be refused")
	}

	write(0o600)
	t.Setenv("HARNESS_MODEL_ORCHESTRATOR", "orch-from-process")
	cfg, _, err = serveConfig([]string{"--data-dir", dir, "--base-url", "http://127.0.0.1:1"})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.APIKey != "sk-from-file" || cfg.Models.Fast != "fast-from-file" || cfg.Models.Orchestrator != "orch-from-process" ||
		os.Getenv("HARNESS_CHILD_ENV_ALLOW") != "FOO" || cfg.BaseURL != "http://127.0.0.1:1" {
		t.Fatalf("cfg = key %q fast %q orch %q", cfg.APIKey, cfg.Models.Fast, cfg.Models.Orchestrator)
	}
	if ok, _ := cfg.BuiltinLoop(); !ok {
		t.Fatal("a key from harness.env makes the built-in loop available")
	}
}

func TestPromptCachingFlagAndEnv(t *testing.T) {
	emptyEnv(t)
	d := t.TempDir()
	t.Setenv("HARNESS_PROMPT_CACHING", "false")
	cfg, _, err := serveConfig([]string{"--data-dir", d})
	if err != nil || cfg.PromptCaching {
		t.Fatalf("env false must hold without a flag: %v %v", cfg.PromptCaching, err)
	}
	cfg, _, err = serveConfig([]string{"--data-dir", d, "--prompt-caching=true"})
	if err != nil || !cfg.PromptCaching {
		t.Fatalf("explicit flag must win: %v %v", cfg.PromptCaching, err)
	}
}
