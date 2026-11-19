package buildinfo

import (
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
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

// Nothing in the workspace may drift: every package.json that has a version and every Cargo manifest with a [package]
// carries DefaultVersion, found by walking the tree so a new package or crate is covered without editing this test.
// (The root package.json is unversioned and the root Cargo.toml is a workspace; both are skipped for that reason.)
func TestEveryManifestHasTheOneVersion(t *testing.T) {
	root := filepath.Join("..", "..", "..", "..")
	skip := map[string]bool{"node_modules": true, "target": true, "dist": true, "testdata": true, "data": true}
	pkgVersion := regexp.MustCompile(`(?m)^\s*"version":\s*"([^"]+)"`)
	cargoVersion := regexp.MustCompile(`(?m)^version = "([^"]+)"`)
	var seen []string
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		name := d.Name()
		if d.IsDir() {
			if p != root && (strings.HasPrefix(name, ".") || skip[name]) {
				return filepath.SkipDir
			}
			return nil
		}
		if name != "package.json" && name != "Cargo.toml" {
			return nil
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(root, p)
		var m [][]byte
		switch name {
		case "package.json":
			// A workspace member (apps/*, packages/*) must be versioned; the root need not be.
			m = pkgVersion.FindSubmatch(b)
			if m == nil && filepath.Dir(rel) == "." {
				return nil
			}
		default:
			if !strings.Contains(string(b), "[package]") {
				return nil
			}
			m = cargoVersion.FindSubmatch(b)
		}
		seen = append(seen, rel)
		if m == nil || string(m[1]) != DefaultVersion {
			t.Errorf("%s: version %q, want %s", rel, m, DefaultVersion)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(seen) < 7 {
		t.Errorf("only found %v: the walk is not reaching the workspace", seen)
	}
}
