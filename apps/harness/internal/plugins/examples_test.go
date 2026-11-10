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
		{"subscription-agents", []string{"copilot", "grok", "codex"}},
		{"acp-agents", []string{"claude-code", "gemini"}},
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
