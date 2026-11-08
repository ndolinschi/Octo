package config_test

import (
	"os"
	"testing"

	"github.com/ndolinschi/Octo/harness/internal/config"
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
