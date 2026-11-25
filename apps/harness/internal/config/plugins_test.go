package config

import (
	"path/filepath"
	"slices"
	"testing"
)

func TestLoadPluginDirs(t *testing.T) {
	t.Setenv("HARNESS_PLUGINS_DIR", "/a"+string(filepath.ListSeparator)+string(filepath.ListSeparator)+"/b")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"/a", "/b"}; !slices.Equal(cfg.PluginDirs, want) {
		t.Fatalf("PluginDirs = %v, want %v", cfg.PluginDirs, want)
	}
}
