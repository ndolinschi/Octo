package orchestrator_test

import (
	"context"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/approval"
	"github.com/ndolinschi/Octo/apps/harness/internal/orchestrator"
)

// UX-01: a memory save the user declined is not asked again in the same
// request: the second save is refused without a card and tells the agent not
// to retry with another tool.
func TestDeclinedMemoryIsNotAskedAgainInTheRequest(t *testing.T) {
	r := newRigWith(t, newCapture(false), orchestrator.Options{})
	pid := r.project(t, 1)
	var cards atomic.Int32
	r.approver(t, pid, func(a approval.Approval) approval.Resolution {
		if a.Kind == approval.KindMemory {
			cards.Add(1)
		}
		return approval.Resolution{Decision: approval.Deny}
	})
	text := "quick keep these [remember: fact | toolchain | Go 1.26 builds it] [remember: decision | | use sqlite per project]"
	if st := r.run(t, pid, text, nil); st != "completed" {
		t.Fatalf("turn = %s", st)
	}
	if n := cards.Load(); n != 1 {
		t.Fatalf("memory cards = %d, want 1", n)
	}
	orch := r.agents(t, pid)[0]
	msgs, _ := r.svc.Messages(context.Background(), pid, orch.ID)
	var answer string
	for _, m := range msgs {
		for _, b := range m.Content {
			if m.Role == "assistant" && b.Type == "text" && b.Text != nil && strings.HasPrefix(*b.Text, "Remember results:") {
				answer = *b.Text
			}
		}
	}
	if !strings.Contains(answer, "declined saving memory in this request") {
		t.Fatalf("results = %q", answer)
	}
}
