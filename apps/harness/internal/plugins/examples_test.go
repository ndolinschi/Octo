package plugins_test

import (
	"context"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
	subscriptionagents "github.com/ndolinschi/Octo/apps/harness/plugins-examples/subscription-agents"
)

func TestShippedExamplesLoadCleanly(t *testing.T) {
	tests := []struct {
		dir  string
		want []string
	}{
		{"subscription-agents", []string{"claude-code", "copilot", "grok", "codex", "cursor", "opencode", "antigravity", "gemini", "devin", "droid", "omp", "pi"}},
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
	// The acp-agents example is a gemini entry kept as a copyable template; the
	// built-in subscription-agents has its own gemini entry (experimental, with
	// accounts), and a copied manifest of the same id replaces it.
	dirs := []string{"subscription-agents", "acp-agents"}
	seen := map[string]string{}
	for _, d := range dirs {
		reg := plugins.Load(context.Background(), t.TempDir(), []string{filepath.Join("..", "..", "plugins-examples", d)}, nil)
		for _, a := range reg.Agents() {
			if prev, dup := seen[a.ID]; dup && a.ID != "gemini" {
				t.Errorf("agent id %q is in both %s and %s", a.ID, prev, d)
			}
			seen[a.ID] = d
		}
	}
	// The harness carries subscription-agents built in; loading the other example
	// next to it must not produce clash errors (a same-id entry replaces the built-in one).
	reg := plugins.Load(context.Background(), t.TempDir(), []string{
		filepath.Join("..", "..", "plugins-examples", "acp-agents"),
	}, nil, plugins.WithBuiltin(subscriptionagents.Manifest))
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
