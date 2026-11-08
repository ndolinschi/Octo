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
