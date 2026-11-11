package orchestrator_test

import (
	"strings"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/mockllm"
)

// R1.4: every way an ACP agent can fail ends the turn with a message that says
// what to do; a turn with zero text and zero tool calls is never a success.
func TestACPFailureModesSayWhatToDo(t *testing.T) {
	for _, tc := range []struct {
		name, ask string
		want      []string
		hint      bool // the login hint is in the separate hint field, never in the text
	}{
		{"silent agent", "[silent] hi", []string{"returned nothing"}, true},
		{"refusal", "[refuse] hi", []string{"declined the request", "rephrase"}, true},
		{"max tokens", "[max-tokens] hi", []string{"ran out of output tokens", "smaller step"}, true},
		{"crash mid-turn", "[crash] hi", []string{"ACP agent"}, false},
	} {
		t.Run("orchestrator "+tc.name, func(t *testing.T) {
			ag := fakeAgent("fake", true)
			ag.Hint = "Sign in with the Fake CLI first."
			r := newACPRig(t, mockllm.New(0), ag)
			pid := r.supervisedProject(t, t.TempDir(), "acp:fake")
			got := r.runCollect(t, pid, tc.ask, nil)
			if got.status != "failed" {
				t.Fatalf("turn = %s, want failed", got.status)
			}
			msg, _ := got.of("turn.finished")[0]["error"].(string)
			for _, w := range tc.want {
				if !strings.Contains(msg, w) {
					t.Errorf("error %q lacks %q", msg, w)
				}
			}
			if strings.Contains(msg, "Sign in with the Fake CLI") {
				t.Errorf("the hint is inside the error text: %q", msg)
			}
			hint, _ := got.of("turn.finished")[0]["hint"].(string)
			if tc.hint != strings.Contains(hint, "Sign in with the Fake CLI") {
				t.Errorf("turn.finished hint = %q, want the login hint: %v", hint, tc.hint)
			}
			orch := r.agents(t, pid)[0]
			if tc.hint && (orch.ErrorHint == nil || !strings.Contains(*orch.ErrorHint, "Sign in with the Fake CLI")) {
				t.Errorf("orchestrator row error_hint = %v", orch.ErrorHint)
			}
		})
		t.Run("sub-agent "+tc.name, func(t *testing.T) {
			ag := fakeAgent("fake", true)
			ag.Hint = "Sign in with the Fake CLI first."
			r := newACPRig(t, mockllm.New(0), ag)
			pid := r.projectAt(t, t.TempDir())
			r.runCollect(t, pid, "[acp] "+tc.ask, nil)
			child := r.acpChild(t, pid)
			if child.Status != "failed" || child.Error == nil {
				t.Fatalf("sub-agent = %s %v, want failed with a message", child.Status, child.Error)
			}
			for _, w := range tc.want {
				if !strings.Contains(*child.Error, w) {
					t.Errorf("sub-agent error %q lacks %q", *child.Error, w)
				}
			}
			if strings.Contains(*child.Error, "Sign in with the Fake CLI") {
				t.Errorf("the hint is inside the sub-agent's error text: %q", *child.Error)
			}
			if tc.hint != (child.ErrorHint != nil && strings.Contains(*child.ErrorHint, "Sign in with the Fake CLI")) {
				t.Errorf("sub-agent error_hint = %v, want the login hint: %v", child.ErrorHint, tc.hint)
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
// is "<label> is not logged in", with the hint in its own field.
func TestACPAuthenticationRequiredOnPromptIsNotLoggedIn(t *testing.T) {
	const hint = "Sign in with the Fake CLI first."
	mk := func() *rig {
		ag := fakeAgent("fake", true)
		ag.Hint = hint
		return newACPRig(t, mockllm.New(0), ag)
	}
	t.Run("orchestrator", func(t *testing.T) {
		r := mk()
		pid := r.supervisedProject(t, t.TempDir(), "acp:fake")
		got := r.runCollect(t, pid, "[auth-required] hi", nil)
		fin := got.of("turn.finished")[0]
		if got.status != "failed" || fin["error"] != "Fake fake is not logged in" || fin["hint"] != hint {
			t.Fatalf("turn.finished = %v", fin)
		}
		if a := r.agents(t, pid)[0]; a.Error == nil || *a.Error != "Fake fake is not logged in" || a.ErrorHint == nil || *a.ErrorHint != hint {
			t.Fatalf("orchestrator row = %v / %v", a.Error, a.ErrorHint)
		}
	})
	t.Run("sub-agent", func(t *testing.T) {
		r := mk()
		pid := r.projectAt(t, t.TempDir())
		r.runCollect(t, pid, "[acp] [auth-required] hi", nil)
		child := r.acpChild(t, pid)
		if child.Error == nil || *child.Error != "Fake fake is not logged in" || child.ErrorHint == nil || *child.ErrorHint != hint {
			t.Fatalf("child = %v / %v", child.Error, child.ErrorHint)
		}
	})
}
