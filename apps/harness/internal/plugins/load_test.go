package plugins_test

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
)

func writePlugin(t *testing.T, root, dir, manifest string) string {
	t.Helper()
	p := filepath.Join(root, dir)
	if err := os.MkdirAll(p, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(p, plugins.ManifestName), []byte(manifest), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func find(t *testing.T, r *plugins.Registry, name string) plugins.Plugin {
	t.Helper()
	for _, p := range r.Plugins() {
		if p.Name == name {
			return p
		}
	}
	t.Fatalf("plugin %q not loaded; have %+v", name, r.Plugins())
	return plugins.Plugin{}
}

func TestLoadValid(t *testing.T) {
	data := t.TempDir()
	writePlugin(t, filepath.Join(data, "plugins"), "go-tools", `{
	  "name":"go-tools","version":"1.0.0","description":"Go",
	  "languageServers":[{"id":"gopls","label":"gopls","languages":["go"],"command":"sh","args":["-c"],"env":{"A":"b"}}],
	  "agents":[{"id":"a1","command":"definitely-not-a-binary-xyz"}],
	  "toolServers":[{"url":"http://127.0.0.1:9000"}]}`)
	var connected []string
	r := plugins.Load(context.Background(), data, nil, func(_ context.Context, u string) error {
		connected = append(connected, u)
		return nil
	})
	p := find(t, r, "go-tools")
	if len(p.Errors) != 0 || p.Version != "1.0.0" || p.Description != "Go" {
		t.Fatalf("plugin = %+v", p)
	}
	ls, ok := r.LanguageServer("gopls")
	if !ok || !ls.Available || ls.Languages[0] != "go" || ls.Env["A"] != "b" || !filepath.IsAbs(ls.Command) {
		t.Fatalf("language server = %+v ok=%v", ls, ok)
	}
	ag, ok := r.Agent("a1")
	if !ok || ag.Available || ag.Label != "a1" {
		t.Fatalf("agent = %+v ok=%v", ag, ok)
	}
	if got := r.ToolServers(); len(got) != 1 || got[0] != "http://127.0.0.1:9000" || len(connected) != 1 {
		t.Fatalf("tool servers = %v connected = %v", got, connected)
	}
	raw, err := json.Marshal(p)
	if err != nil {
		t.Fatal(err)
	}
	for _, leak := range []string{"command", "args", `"env"`, "Dir"} {
		if strings.Contains(string(raw), leak) {
			t.Fatalf("JSON leaks %q: %s", leak, raw)
		}
	}
	if !strings.Contains(string(raw), `"language_servers"`) || !strings.Contains(string(raw), `"tool_servers"`) {
		t.Fatalf("JSON shape: %s", raw)
	}
}

func TestLoadProblemsNeverFatal(t *testing.T) {
	data := t.TempDir()
	root := filepath.Join(data, "plugins")
	writePlugin(t, root, "broken", `{not json`)
	writePlugin(t, root, "badname", `{"name":"Bad_Name","version":"1","agents":[{"id":"x","command":"sh"}]}`)
	writePlugin(t, root, "noversion", `{"name":"noversion"}`)
	writePlugin(t, root, "partial", `{"name":"partial","version":"1",
	  "agents":[{"id":"","command":"sh"},{"id":"nocmd"},{"id":"ok","command":"sh"}],
	  "languageServers":[{"id":"ls","command":"sh"}],
	  "toolServers":[{"url":"ftp://nope"}]}`)
	r := plugins.Load(context.Background(), data, nil, nil)

	for _, name := range []string{"broken", "Bad_Name", "noversion"} {
		p := find(t, r, name)
		if len(p.Errors) == 0 || len(p.Agents) != 0 || len(p.LanguageServers) != 0 {
			t.Errorf("%s = %+v, want errors and no capabilities", name, p)
		}
	}
	if _, ok := r.Agent("x"); ok {
		t.Error("agent from a bad-name plugin was registered")
	}
	partial := find(t, r, "partial")
	if len(partial.Agents) != 1 || partial.Agents[0].ID != "ok" || len(partial.Errors) != 4 || len(partial.LanguageServers) != 0 {
		t.Fatalf("partial = %+v", partial)
	}
}

func TestDuplicateIDsFirstWins(t *testing.T) {
	data := t.TempDir()
	root := filepath.Join(data, "plugins")
	writePlugin(t, root, "a", `{"name":"a","version":"1","agents":[{"id":"dup","label":"first","command":"sh"}]}`)
	writePlugin(t, root, "b", `{"name":"b","version":"1","agents":[{"id":"dup","label":"second","command":"sh"},{"id":"own","command":"sh"}],
	  "languageServers":[{"id":"dup","languages":["go"],"command":"sh"}]}`)
	writePlugin(t, root, "c", `{"name":"a","version":"2"}`)
	r := plugins.Load(context.Background(), data, nil, nil)

	if ag, _ := r.Agent("dup"); ag.Label != "first" {
		t.Fatalf("dup agent = %+v, want first", ag)
	}
	b := find(t, r, "b")
	if len(b.Agents) != 1 || b.Agents[0].ID != "own" || len(b.Errors) != 1 || !strings.Contains(b.Errors[0], "duplicate agent id") {
		t.Fatalf("b = %+v", b)
	}
	if len(b.LanguageServers) != 1 {
		t.Fatalf("language server ids are a separate namespace: %+v", b)
	}
	var dupName plugins.Plugin
	for _, p := range r.Plugins() {
		if p.Dir == filepath.Join(root, "c") {
			dupName = p
		}
	}
	if len(dupName.Errors) != 1 || !strings.Contains(dupName.Errors[0], "duplicate plugin name") {
		t.Fatalf("duplicate name = %+v", dupName)
	}
}

func TestCommandResolution(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("posix permission bits")
	}
	data := t.TempDir()
	extra := t.TempDir()
	dir := writePlugin(t, extra, "p", `{"name":"p","version":"1","agents":[
	  {"id":"rel","command":"./bin/tool"},
	  {"id":"nonexec","command":"./bin/data"},
	  {"id":"missing","command":"./bin/nope"},
	  {"id":"abs","command":"`+filepath.Join(extra, "p", "bin", "tool")+`"},
	  {"id":"path","command":"sh"}]}`)
	if err := os.MkdirAll(filepath.Join(dir, "bin"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "bin", "tool"), []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "bin", "data"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	r := plugins.Load(context.Background(), data, []string{extra}, nil)
	for id, want := range map[string]bool{"rel": true, "nonexec": false, "missing": false, "abs": true, "path": true} {
		a, ok := r.Agent(id)
		if !ok || a.Available != want {
			t.Errorf("agent %s = %+v ok=%v, want available=%v", id, a, ok, want)
		}
	}
	rel, _ := r.Agent("rel")
	if rel.Command != filepath.Join(dir, "bin", "tool") {
		t.Errorf("relative command resolved to %q", rel.Command)
	}
}

func TestPluginsDirSelfAndMissing(t *testing.T) {
	data := t.TempDir()
	self := writePlugin(t, t.TempDir(), "solo", `{"name":"solo","version":"1"}`)
	r := plugins.Load(context.Background(), data, []string{self, self, filepath.Join(data, "absent")}, nil)
	if got := r.Plugins(); len(got) != 1 || got[0].Name != "solo" {
		t.Fatalf("plugins = %+v", got)
	}
}

func TestToolServerFailureRecorded(t *testing.T) {
	data := t.TempDir()
	writePlugin(t, filepath.Join(data, "plugins"), "t", `{"name":"t","version":"1","toolServers":[{"url":"http://127.0.0.1:1"}]}`)
	r := plugins.Load(context.Background(), data, nil, func(context.Context, string) error { return errors.New("boom") })
	p := find(t, r, "t")
	if len(p.Errors) != 1 || !strings.Contains(p.Errors[0], "boom") || len(p.ToolServers) != 1 {
		t.Fatalf("plugin = %+v", p)
	}
}

func TestNilRegistry(t *testing.T) {
	var r *plugins.Registry
	if len(r.Plugins()) != 0 || len(r.Agents()) != 0 || len(r.ToolServers()) != 0 {
		t.Fatal("nil registry must be empty")
	}
	if _, ok := r.Agent("x"); ok {
		t.Fatal("nil registry found an agent")
	}
}
