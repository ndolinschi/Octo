package orchestrator_test

import (
	"context"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/fakeacp"
	"github.com/ndolinschi/Octo/apps/harness/internal/mockllm"
	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
)

func TestACPOrchestratorStartFailuresEndTheTurnWithTheError(t *testing.T) {
	missing := fakeAgent("fake", true)
	missing.Command = "/nonexistent/agent-binary"
	refusing := fakeAgent("fake", true)
	refusing.Env[fakeacp.EnvAuth] = "interactive"
	refusing.Hint = "Sign in with the Fake CLI first."
	exits := fakeAgent("fake", true)
	exits.Env[fakeacp.EnvChild] = "0" // the test binary runs its tests, not an agent: it exits at once
	exits.Command = "/bin/true"
	for _, tc := range []struct {
		name  string
		agent plugins.Agent
		want  string
	}{
		{"missing command", missing, "start ACP agent"},
		{"auth refused", refusing, "Sign in with the Fake CLI first."},
		{"exits at once", exits, "ACP agent"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := newACPRig(t, mockllm.New(0), tc.agent)
			pid := r.supervisedProject(t, t.TempDir(), "acp:fake")
			name := "full"
			_ = name
			got := r.runCollect(t, pid, "[echo] hello", nil)
			if got.status != "failed" {
				t.Fatalf("turn = %s, want failed", got.status)
			}
			fin := got.of("turn.finished")[0]
			msg, _ := fin["error"].(string)
			if msg == "" || !contains(msg, tc.want) {
				t.Fatalf("turn.finished error = %v, want it to contain %q", fin["error"], tc.want)
			}
			db, err := r.store.Get(context.Background(), pid)
			if err != nil {
				t.Fatal(err)
			}
			orch, _ := db.Orchestrator(context.Background())
			if orch.Error == nil || !contains(*orch.Error, tc.want) {
				t.Fatalf("orchestrator error = %v", orch.Error)
			}
			// The same end state as a failed built-in turn: orchestrator idle with the
			// error, turn.finished carrying it (what the UI derives "failed" from).
			if orch.Status != "idle" {
				t.Fatalf("orchestrator status = %s, want idle (as after a failed built-in turn)", orch.Status)
			}
		})
	}
}

func contains(s, sub string) bool {
	return len(sub) == 0 || (len(s) >= len(sub) && indexOf(s, sub) >= 0)
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
