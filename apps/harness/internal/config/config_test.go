package config_test

import (
	"os"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/config"
)

func TestLoad_DataDirFromEnv(t *testing.T) {
	t.Setenv("HARNESS_DATA_DIR", "/tmp/harness-data-test")
	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.DataDir != "/tmp/harness-data-test" {
		t.Errorf("DataDir = %q, want %q", cfg.DataDir, "/tmp/harness-data-test")
	}
}

func TestLoad_DefaultDataDir(t *testing.T) {
	os.Unsetenv("HARNESS_DATA_DIR")
	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.DataDir != "./data/harness" {
		t.Errorf("DataDir = %q, want %q", cfg.DataDir, "./data/harness")
	}
}

func TestLoad_MaxTurnsFromEnv(t *testing.T) {
	t.Setenv("HARNESS_MAX_TURNS", "7")
	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.MaxTurns != 7 {
		t.Errorf("MaxTurns = %d, want 7", cfg.MaxTurns)
	}
}

func TestLoad_OctoKeyFromEnv(t *testing.T) {
	t.Setenv("HARNESS_OCTO_KEY", "octo-secret")
	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.OctoKey != "octo-secret" {
		t.Errorf("OctoKey = %q, want octo-secret", cfg.OctoKey)
	}
}

func TestLoad_StreamFromEnv(t *testing.T) {
	t.Setenv("HARNESS_STREAM", "false")
	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Stream {
		t.Fatal("Stream = true, want false")
	}
}

func TestLoad_StreamDefaultTrue(t *testing.T) {
	os.Unsetenv("HARNESS_STREAM")
	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if !cfg.Stream {
		t.Fatal("Stream = false, want true")
	}
}

func TestLoad_ModelDefaultsAndOverrides(t *testing.T) {
	t.Setenv("HARNESS_MODEL_FAST", "tiny")
	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Models.Fast != "tiny" {
		t.Errorf("Fast = %q, want tiny", cfg.Models.Fast)
	}
	if cfg.Models.Balanced != "claude-sonnet-5-5" {
		t.Errorf("Balanced = %q", cfg.Models.Balanced)
	}
}

func TestLoad_CostDefaultsAndOverrides(t *testing.T) {
	for _, k := range []string{"HARNESS_PROMPT_CACHING", "HARNESS_MAX_TOOL_RESULT_BYTES", "HARNESS_MAX_REPORT_BYTES", "HARNESS_READ_FILE_LINES"} {
		t.Setenv(k, "")
	}
	cfg, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.PromptCaching || cfg.Limits.ResultBytes != 48<<10 || cfg.Limits.ReportBytes != 32<<10 || cfg.Limits.ReadLines != 2000 {
		t.Fatalf("defaults = caching %v, %+v", cfg.PromptCaching, cfg.Limits)
	}
	if cfg.Models.Orchestrator != "claude-sonnet-5-5" || cfg.Models.Deep != "claude-opus-5-5" {
		t.Fatalf("models = %+v", cfg.Models)
	}

	tests := []struct {
		env, val string
		check    func(config.Config) bool
		wantErr  bool
	}{
		{"HARNESS_PROMPT_CACHING", "false", func(c config.Config) bool { return !c.PromptCaching }, false},
		{"HARNESS_PROMPT_CACHING", "0", func(c config.Config) bool { return !c.PromptCaching }, false},
		{"HARNESS_PROMPT_CACHING", "maybe", nil, true},
		{"HARNESS_MAX_TOOL_RESULT_BYTES", "1000", func(c config.Config) bool { return c.Limits.ResultBytes == 1000 }, false},
		{"HARNESS_MAX_REPORT_BYTES", "2000", func(c config.Config) bool { return c.Limits.ReportBytes == 2000 }, false},
		{"HARNESS_READ_FILE_LINES", "50", func(c config.Config) bool { return c.Limits.ReadLines == 50 }, false},
		{"HARNESS_MAX_TOOL_RESULT_BYTES", "0", nil, true},
		{"HARNESS_READ_FILE_LINES", "lots", nil, true},
	}
	for _, tc := range tests {
		t.Run(tc.env+"="+tc.val, func(t *testing.T) {
			t.Setenv(tc.env, tc.val)
			cfg, err := config.Load()
			if tc.wantErr {
				if err == nil {
					t.Fatal("accepted a bad value")
				}
				return
			}
			if err != nil || !tc.check(cfg) {
				t.Fatalf("cfg = %+v, err %v", cfg, err)
			}
		})
	}
}

func TestContextWindows(t *testing.T) {
	for _, tc := range []struct {
		name, in string
		want     map[string]int64
		bad      bool
	}{
		{"empty", "", map[string]int64{}, false},
		{"two models", "a=200000, b/c:d=1000000", map[string]int64{"a": 200000, "b/c:d": 1000000}, false},
		{"no equals", "a", nil, true},
		{"not a number", "a=big", nil, true},
		{"zero", "a=0", nil, true},
		{"no model", "=5", nil, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w, err := config.ParseContextWindows(tc.in)
			if (err != nil) != tc.bad {
				t.Fatalf("err = %v", err)
			}
			if tc.bad {
				return
			}
			for m, n := range tc.want {
				if got := w.Lookup(m); got == nil || *got != n {
					t.Errorf("Lookup(%q) = %v, want %d", m, got, n)
				}
			}
			if got := w.Lookup("claude-sonnet-5-5"); got != nil {
				t.Errorf("unknown model has window %d, want nil", *got)
			}
		})
	}
	t.Setenv("HARNESS_CONTEXT_WINDOWS", "m=oops")
	if _, err := config.Load(); err == nil {
		t.Error("Load accepted a bad HARNESS_CONTEXT_WINDOWS")
	}
}
