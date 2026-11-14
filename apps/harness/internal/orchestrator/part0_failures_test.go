package orchestrator_test

import (
	"strings"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/mockllm"
)

// R1.4 and decision 94b: every way an ACP agent can fail ends the turn with a
// plain message, a hint that says what to do, and the manifest's own login
// text kept in the details (never in the message); a turn with zero text and
// zero tool calls is never a success.
func TestACPFailureModesSayWhatToDo(t *testing.T) {
	const login = "Sign in with the Fake CLI first."
	for _, tc := range []struct {
		name, ask     string
		message, hint string
		loginDetails  bool // the manifest's login text rides in `details`
	}{
		{"silent agent", "[silent] hi", "answered with nothing", "may not be logged in", true},
		{"refusal", "[refuse] hi", "declined the request", "Rephrase", false},
		{"max tokens", "[max-tokens] hi", "ran out of room", "smaller step", false},
		{"crash mid-turn", "[crash] hi", "stopped in the middle of the request", "Try again", false},
		// NEW-10: killed while a command runs, or while it works without a word: it was working, not starting.
		{"killed during a command", "[die-in-command] hi", "stopped in the middle of the request", "Try again", false},
		{"killed while silent", "[die-silent] hi", "stopped in the middle of the request", "Try again", false},
	} {
		t.Run("orchestrator "+tc.name, func(t *testing.T) {
			ag := fakeAgent("fake", true)
			ag.Hint = login
			r := newACPRig(t, mockllm.New(0), ag)
			pid := r.supervisedProject(t, t.TempDir(), "acp:fake")
			got := r.runCollect(t, pid, tc.ask, nil)
			if got.status != "failed" {
				t.Fatalf("turn = %s, want failed", got.status)
			}
			fin := got.of("turn.finished")[0]
			msg, _ := fin["error"].(string)
			hint, _ := fin["hint"].(string)
			if !strings.Contains(msg, tc.message) || !strings.Contains(hint, tc.hint) {
				t.Errorf("message %q / hint %q, want %q / %q", msg, hint, tc.message, tc.hint)
			}
			if strings.Contains(msg, login) || strings.Contains(hint, login) {
				t.Errorf("the login text is in the message or hint: %q / %q", msg, hint)
			}
			if details, _ := fin["details"].(string); tc.loginDetails != strings.Contains(details, login) {
				t.Errorf("details = %q, want the login text: %v", details, tc.loginDetails)
			}
			orch := r.agents(t, pid)[0]
			if orch.ErrorHint == nil || !strings.Contains(*orch.ErrorHint, tc.hint) {
				t.Errorf("orchestrator row error_hint = %v", orch.ErrorHint)
			}
		})
		t.Run("sub-agent "+tc.name, func(t *testing.T) {
			ag := fakeAgent("fake", true)
			ag.Hint = login
			r := newACPRig(t, mockllm.New(0), ag)
			pid := r.projectAt(t, t.TempDir())
			r.runCollect(t, pid, "[acp] "+tc.ask, nil)
			child := r.acpChild(t, pid)
			if child.Status != "failed" || child.Error == nil {
				t.Fatalf("sub-agent = %s %v, want failed with a message", child.Status, child.Error)
			}
			if !strings.Contains(*child.Error, tc.message) {
				t.Errorf("sub-agent error %q lacks %q", *child.Error, tc.message)
			}
			if strings.Contains(*child.Error, login) {
				t.Errorf("the login text is inside the sub-agent's error: %q", *child.Error)
			}
			if child.ErrorHint == nil || !strings.Contains(*child.ErrorHint, tc.hint) {
				t.Errorf("sub-agent error_hint = %v, want %q", child.ErrorHint, tc.hint)
			}
		})
	}
}

func TestACPAgentWithAnswerIsStillASuccess(t *testing.T) {
	r := newACPRig(t, mockllm.New(0), fakeAgent("fake", true))
	pid := r.supervisedProject(t, t.TempDir(), "acp:fake")
	if got := r.runCollect(t, pid, "[echo] hi", nil); got.status != "completed" {
		t.Fatalf("turn = %s", got.status)
	}
}

// An agent that answers session/prompt with -32000 "Authentication required"
// is "<label> is not logged in.", with a hint, the login text as details and a
// button to check again.
func TestACPAuthenticationRequiredOnPromptIsNotLoggedIn(t *testing.T) {
	const login = "Sign in with the Fake CLI first."
	const message = "Fake fake is not logged in."
	const hint = "Log in to it in a terminal, then check again."
	mk := func() *rig {
		ag := fakeAgent("fake", true)
		ag.Hint = login
		ag.LoginCommand = "fake login"
		return newACPRig(t, mockllm.New(0), ag)
	}
	t.Run("orchestrator", func(t *testing.T) {
		r := mk()
		pid := r.supervisedProject(t, t.TempDir(), "acp:fake")
		got := r.runCollect(t, pid, "[auth-required] hi", nil)
		fin := got.of("turn.finished")[0]
		if got.status != "failed" || fin["error"] != message || fin["hint"] != hint || fin["command"] != "fake login" ||
			fin["action"] != "recheck_provider" || fin["details"] != login {
			t.Fatalf("turn.finished = %v", fin)
		}
		if a := r.agents(t, pid)[0]; a.Error == nil || *a.Error != message || a.ErrorHint == nil || *a.ErrorHint != hint {
			t.Fatalf("orchestrator row = %v / %v", a.Error, a.ErrorHint)
		}
	})
	t.Run("sub-agent", func(t *testing.T) {
		r := mk()
		pid := r.projectAt(t, t.TempDir())
		r.runCollect(t, pid, "[acp] [auth-required] hi", nil)
		child := r.acpChild(t, pid)
		if child.Error == nil || *child.Error != message || child.ErrorHint == nil || *child.ErrorHint != hint {
			t.Fatalf("child = %v / %v", child.Error, child.ErrorHint)
		}
	})
}
