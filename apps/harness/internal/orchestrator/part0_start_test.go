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
		{"missing command", missing, "is not installed"},
		{"auth refused", refusing, "is not logged in"},
		{"exits at once", exits, "stopped while starting"},
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
			if tc.name == "auth refused" {
				if hint, _ := fin["hint"].(string); hint != "Log in to it in a terminal, then check again." || contains(msg, "Sign in with") || contains(msg, "interactive") {
					t.Fatalf("hint %q, message %q: want the plain message and the hint apart", hint, msg)
				}
				if orch.ErrorHint == nil || *orch.ErrorHint != "Log in to it in a terminal, then check again." {
					t.Fatalf("orchestrator error_hint = %v", orch.ErrorHint)
				}
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

// P2-9: an agent whose program was not found on PATH when plugins loaded is
// "not installed" with its install line and a PATH hint, not "the agent chosen
// cannot be used" (which the UI paired with the agent's login command).
func TestACPOrchestratorMissingProgramIsNotInstalled(t *testing.T) {
	missing := fakeAgent("fake", false)
	missing.UnavailableReason = "the agent's program was not found on PATH"
	missing.InstallHint = "Install it with npm install -g fake-cli"
	r := newACPRig(t, mockllm.New(0), missing)
	pid := r.supervisedProject(t, t.TempDir(), "acp:fake")
	got := r.runCollect(t, pid, "[echo] hello", nil)
	if got.status != "failed" {
		t.Fatalf("turn = %s, want failed", got.status)
	}
	fin := got.of("turn.finished")[0]
	msg, _ := fin["error"].(string)
	hint, _ := fin["hint"].(string)
	cmd, _ := fin["command"].(string)
	details, _ := fin["details"].(string)
	if msg != "Fake fake is not installed." || cmd != "npm install -g fake-cli" || !contains(hint, "PATH") || !contains(details, "not found on PATH") {
		t.Fatalf("error %q, hint %q, command %q, details %q", msg, hint, cmd, details)
	}

	// An agent Octo does not support stays "cannot be used".
	unsupported := fakeAgent("fake", false)
	unsupported.Unsupported = "it has no ACP mode"
	r = newACPRig(t, mockllm.New(0), unsupported)
	pid = r.supervisedProject(t, t.TempDir(), "acp:fake")
	got = r.runCollect(t, pid, "[echo] hello", nil)
	if msg, _ := got.of("turn.finished")[0]["error"].(string); !contains(msg, "cannot be used") {
		t.Fatalf("unsupported agent error = %q", msg)
	}
}
