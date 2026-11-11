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
	}{
		{"silent agent", "[silent] hi", []string{"returned nothing", "if it is not logged in: Sign in with the Fake CLI"}},
		{"refusal", "[refuse] hi", []string{"declined the request", "rephrase", "Sign in with the Fake CLI"}},
		{"max tokens", "[max-tokens] hi", []string{"ran out of output tokens", "smaller step"}},
		{"crash mid-turn", "[crash] hi", []string{"ACP agent"}},
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
