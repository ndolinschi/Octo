package config_test

import (
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/config"
)

func TestBuiltinLoopFromConfigurationOnly(t *testing.T) {
	for name, tc := range map[string]struct {
		cfg  config.Config
		want bool
	}{
		"nothing":                   {config.Config{}, false},
		"api key":                   {config.Config{APIKey: "sk-x"}, true},
		"octo key":                  {config.Config{OctoKey: "ok"}, true},
		"router base url":           {config.Config{BaseURL: "http://127.0.0.1:8080"}, true},
		"gateway base url":          {config.Config{BaseURL: "https://gateway.example.com/anthropic"}, true},
		"default host spelled out":  {config.Config{BaseURL: "https://api.anthropic.com"}, false},
		"default host with a path":  {config.Config{BaseURL: "https://api.anthropic.com/v1/"}, false},
		"unparseable base url":      {config.Config{BaseURL: "::::"}, false},
		"base url without a host":   {config.Config{BaseURL: "/just/a/path"}, false},
		"default host and a key":    {config.Config{BaseURL: "https://api.anthropic.com", APIKey: "k"}, true},
		"empty base url, empty key": {config.Config{BaseURL: "", APIKey: ""}, false},
	} {
		t.Run(name, func(t *testing.T) {
			got, reason := tc.cfg.BuiltinLoop()
			if got != tc.want {
				t.Fatalf("available = %v, want %v", got, tc.want)
			}
			if got && reason != "" || !got && reason != config.NoBuiltinLoopMessage {
				t.Fatalf("reason = %q", reason)
			}
		})
	}
}

func TestNoBuiltinLoopMessageIsTheContractText(t *testing.T) {
	const want = "No API key is configured for the built-in agent loop. Set ANTHROPIC_API_KEY (or a router), or choose an ACP agent for this project."
	if config.NoBuiltinLoopMessage != want {
		t.Fatalf("message = %q", config.NoBuiltinLoopMessage)
	}
}

func TestNoBuiltinPluginsEnv(t *testing.T) {
	t.Setenv("HARNESS_NO_BUILTIN_PLUGINS", "1")
	cfg, err := config.Load()
	if err != nil || !cfg.NoBuiltinPlugins {
		t.Fatalf("cfg = %+v err = %v", cfg.NoBuiltinPlugins, err)
	}
	t.Setenv("HARNESS_NO_BUILTIN_PLUGINS", "maybe")
	if _, err := config.Load(); err == nil {
		t.Fatal("a bad bool must be an error")
	}
	t.Setenv("HARNESS_NO_BUILTIN_PLUGINS", "")
	if cfg, err := config.Load(); err != nil || cfg.NoBuiltinPlugins {
		t.Fatalf("default must load built-ins: %+v %v", cfg.NoBuiltinPlugins, err)
	}
}

func TestResolveDataDir(t *testing.T) {
	t.Setenv("HARNESS_DATA_DIR", "")
	if got := config.ResolveDataDir(""); got != "./data/harness" {
		t.Fatalf("default = %q", got)
	}
	t.Setenv("HARNESS_DATA_DIR", "/env")
	if got := config.ResolveDataDir(""); got != "/env" {
		t.Fatalf("env = %q", got)
	}
	if got := config.ResolveDataDir("/flag"); got != "/flag" {
		t.Fatalf("flag = %q", got)
	}
}
