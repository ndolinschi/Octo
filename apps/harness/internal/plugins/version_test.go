package plugins

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestParseVersion(t *testing.T) {
	for in, want := range map[string]string{
		"agy 1.5.9":                    "1.5.9",
		"Antigravity CLI v1.4.12\n":    "1.4.12",
		"1.5":                          "1.5.0",
		"agy version 2026.11.05 (abc)": "2026.11.5",
	} {
		v, ok := ParseVersion(in)
		if !ok || versionString(v) != want {
			t.Errorf("ParseVersion(%q) = %v, %v; want %s", in, v, ok, want)
		}
	}
	for _, in := range []string{"", "agy", "build abc123", "gemini-4"} {
		if _, ok := ParseVersion(in); ok {
			t.Errorf("ParseVersion(%q) found a version", in)
		}
	}
	a, _ := ParseVersion("1.4.12")
	b, _ := ParseVersion("1.5.0")
	if !versionLess(a, b) || versionLess(b, a) || versionLess(b, b) {
		t.Fatal("versionLess")
	}
}

func TestManifestVersionTransportAndSearchPathsAreValidated(t *testing.T) {
	base := func() manifestAgent {
		return manifestAgent{manifestCommand: manifestCommand{ID: "agy", Command: "agy", Args: []string{"acp"}}}
	}
	ok := base()
	ok.Version = &manifestVersion{Command: []string{"agy", "--version"}, Min: "1.5.0"}
	ok.MCPTransport, ok.SearchPaths = "stdio", []string{"~/.local/bin", "/opt/agy/bin"}
	if err := ok.validate(); err != nil {
		t.Fatalf("valid agent refused: %v", err)
	}
	for name, mut := range map[string]func(*manifestAgent){
		"no version command": func(a *manifestAgent) { a.Version = &manifestVersion{Min: "1.5.0"} },
		"bad min":            func(a *manifestAgent) { a.Version = &manifestVersion{Command: []string{"agy"}, Min: "latest"} },
		"bad transport":      func(a *manifestAgent) { a.MCPTransport = "sse" },
		"relative search":    func(a *manifestAgent) { a.SearchPaths = []string{"bin"} },
	} {
		a := base()
		mut(&a)
		if err := a.validate(); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

// writeAgy writes a fake agy that prints version v for --version.
func writeAgy(t *testing.T, dir, v string) string {
	t.Helper()
	p := filepath.Join(dir, "agy")
	script := "#!/bin/sh\nif [ \"$1\" = --version ]; then echo \"agy " + v + "\"; exit 0; fi\nexit 1\n"
	if err := os.WriteFile(p, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return p
}

func agyPlugin(t *testing.T, command string) string {
	t.Helper()
	dir := t.TempDir()
	m := `{"name":"agy-test","version":"1","agents":[{"id":"antigravity","label":"Antigravity","command":"` + command + `","args":["acp"],
	  "version":{"command":["` + command + `","--version"],"min":"1.5.0"},"mcpTransport":"stdio",
	  "install":"Install it: ` + "`curl -fsSL https://antigravity.google/cli/install.sh | bash`" + `"}]}`
	if err := os.WriteFile(filepath.Join(dir, ManifestName), []byte(m), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

// A CLI older than the manifest's minimum is listed as not available, with
// its version, before anything starts it; after an update, a recheck makes it
// available again.
func TestVersionCheckMarksAnOldCLIUnavailableAndRecheckClearsIt(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses sh")
	}
	bin := t.TempDir()
	agy := writeAgy(t, bin, "1.4.12")
	reg := Load(context.Background(), t.TempDir(), []string{agyPlugin(t, agy)}, nil)
	a, _ := reg.Agent("antigravity")
	if !a.Available || a.VersionTooOld || a.MCPTransport != MCPTransportStdio {
		t.Fatalf("before the check: %+v", a)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	changed := make(chan struct{}, 4)
	reg.OnProbeChange(func() { changed <- struct{}{} })
	reg.StartProbes(ctx)
	waitFor(t, "the version check", func() bool { a, _ = reg.Agent("antigravity"); return a.Version.Ran })
	if !a.VersionTooOld || a.Available || a.Version.Version != "1.4.12" || !strings.Contains(a.UnavailableReason, "agy 1.4.12 is installed; Octo needs 1.5.0 or newer") {
		t.Fatalf("old CLI: %+v", a)
	}
	select {
	case <-changed:
	case <-time.After(5 * time.Second):
		t.Fatal("no change notification")
	}
	if a.InstallCmd() != "curl -fsSL https://antigravity.google/cli/install.sh | bash" {
		t.Fatalf("install command = %q", a.InstallCmd())
	}
	// Plugins() does not run a fresh check within VersionInterval.
	writeAgy(t, bin, "1.5.9")
	if a, _ = reg.Agent("antigravity"); !a.VersionTooOld {
		t.Fatal("the cached result changed without a recheck")
	}
	a, _ = reg.Recheck(context.Background(), "antigravity")
	if a.VersionTooOld || !a.Available || a.Version.Version != "1.5.9" {
		t.Fatalf("after the update and a recheck: %+v", a)
	}
}

// Output without a version, a failing command or a timeout never make an agent
// unavailable.
func TestVersionCheckNeverGuesses(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses sh")
	}
	dir := t.TempDir()
	for name, script := range map[string]string{
		"no number": "#!/bin/sh\necho 'Antigravity CLI'\n",
		"fails":     "#!/bin/sh\nexit 3\n",
		"slow":      "#!/bin/sh\nsleep 5\necho 1.0.0\n",
	} {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte(script), 0o755); err != nil {
			t.Fatal(err)
		}
		old := versionTimeout
		versionTimeout = 300 * time.Millisecond
		rep := Agent{ID: "x", VersionCommand: p, MinVersion: "1.5.0"}.CheckVersion(context.Background())
		versionTimeout = old
		if rep.TooOld || rep.Version != "" || rep.Reason == "" {
			t.Errorf("%s: %+v", name, rep)
		}
	}
}

// searchPaths find a CLI in its vendor's default folder when PATH lacks it
// (the desktop app started from the Dock).
func TestSearchPathsFindTheProgramOutsidePATH(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses sh")
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("PATH", t.TempDir())
	bin := filepath.Join(home, ".local", "bin")
	if err := os.MkdirAll(bin, 0o755); err != nil {
		t.Fatal(err)
	}
	if p, ok := resolveCommandIn("agy", "", []string{"~/.local/bin"}); ok {
		t.Fatalf("found %s before it exists", p)
	}
	want := writeAgy(t, bin, "1.5.9")
	if p, ok := resolveCommandIn("agy", "", []string{"/nonexistent", "~/.local/bin"}); !ok || p != want {
		t.Fatalf("resolveCommandIn = %s, %v; want %s", p, ok, want)
	}
	if _, ok := resolveCommand("agy", ""); ok {
		t.Fatal("plain PATH lookup should not find it")
	}
}
