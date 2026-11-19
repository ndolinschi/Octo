package buildinfo

import (
	"os"
	"path/filepath"
	"regexp"
	"testing"
)

// One version across the components: the harness default, the router, the desktop app and its shell.
func TestOneVersionEverywhere(t *testing.T) {
	root := filepath.Join("..", "..", "..", "..")
	for file, pattern := range map[string]string{
		"apps/router/Cargo.toml":                    `(?m)^version = "([^"]+)"`,
		"apps/desktop/src-tauri/Cargo.toml":         `(?m)^version = "([^"]+)"`,
		"apps/desktop/src-tauri/sidecar/Cargo.toml": `(?m)^version = "([^"]+)"`,
		"apps/desktop/package.json":                 `"version": "([^"]+)"`,
		"apps/desktop/src-tauri/tauri.conf.json":    `"version": "([^"]+)"`,
		"packages/ui/package.json":                  `"version": "([^"]+)"`,
		"packages/ui/src/lib/version.ts":            `UI_VERSION = "([^"]+)"`,
	} {
		b, err := os.ReadFile(filepath.Join(root, file))
		if err != nil {
			t.Fatal(err)
		}
		m := regexp.MustCompile(pattern).FindSubmatch(b)
		if m == nil || string(m[1]) != DefaultVersion {
			t.Errorf("%s: version %q, want %s", file, m, DefaultVersion)
		}
	}
}
