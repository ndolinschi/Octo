package plugins_test

import (
	"context"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
)

func TestShippedExamplesLoadCleanly(t *testing.T) {
	tests := []struct {
		dir  string
		want []string
	}{
		{"subscription-agents", []string{"claude-code", "copilot", "grok", "codex", "cursor", "opencode", "antigravity", "devin", "droid", "omp", "pi"}},
		{"acp-agents", []string{"gemini"}},
		{"fake-acp", []string{"fake"}},
	}
	for _, tc := range tests {
		t.Run(tc.dir, func(t *testing.T) {
			reg := plugins.Load(context.Background(), t.TempDir(), []string{filepath.Join("..", "..", "plugins-examples", tc.dir)}, nil)
			ps := reg.Plugins()
			if len(ps) != 1 || len(ps[0].Errors) != 0 {
				t.Fatalf("plugins = %+v", ps)
			}
			var ids []string
			for _, a := range ps[0].Agents {
				ids = append(ids, a.ID)
			}
			if !reflect.DeepEqual(ids, tc.want) {
				t.Fatalf("agents = %v, want %v", ids, tc.want)
			}
		})
	}
}

func TestShippedAgentsAreConsistent(t *testing.T) {
	dirs := []string{"subscription-agents", "acp-agents"}
	seen := map[string]string{}
	for _, d := range dirs {
		reg := plugins.Load(context.Background(), t.TempDir(), []string{filepath.Join("..", "..", "plugins-examples", d)}, nil)
		for _, a := range reg.Agents() {
			if prev, dup := seen[a.ID]; dup {
				t.Errorf("agent id %q is in both %s and %s", a.ID, prev, d)
			}
			seen[a.ID] = d
		}
	}
	// Loading both together must not produce clash errors either.
	reg := plugins.Load(context.Background(), t.TempDir(), []string{
		filepath.Join("..", "..", "plugins-examples", "subscription-agents"), filepath.Join("..", "..", "plugins-examples", "acp-agents"),
	}, nil)
	for _, p := range reg.Plugins() {
		if len(p.Errors) != 0 {
			t.Errorf("plugin %s: %v", p.Name, p.Errors)
		}
	}
}

func TestShippedGrokPlacesModelBeforeStdio(t *testing.T) {
	reg := plugins.Load(context.Background(), t.TempDir(), []string{filepath.Join("..", "..", "plugins-examples", "subscription-agents")}, nil)
	grok, ok := reg.Agent("grok")
	if !ok {
		t.Fatal("grok missing")
	}
	if got, want := grok.ArgsFor("grok-4"), []string{"agent", "-m", "grok-4", "stdio"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("ArgsFor(model) = %v, want %v", got, want)
	}
	if got, want := grok.ArgsFor(""), []string{"agent", "stdio"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("ArgsFor() = %v, want %v", got, want)
	}
}
