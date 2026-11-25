package approval

import (
	"context"
	"testing"
	"time"
)

// UX-02: the time a turn waits for the user's answers is measured, overlapping
// approvals counted once, so the turn's "Worked for" can leave it out.
func TestWaitedCountsOpenApprovalsOnce(t *testing.T) {
	m := New(func(string, string, map[string]any) {}, nil, time.Minute)
	now := time.Unix(1000, 0)
	m.now = func() time.Time { return now }
	ask := func() chan Resolution {
		done := make(chan Resolution, 1)
		go func() { done <- m.Request(context.Background(), "p", Approval{TurnID: 7, Title: "x"}) }()
		return done
	}
	waitPending := func(n int) {
		for i := 0; i < 1000 && m.Count("p") != n; i++ {
			time.Sleep(time.Millisecond)
		}
		if m.Count("p") != n {
			t.Fatalf("pending = %d, want %d", m.Count("p"), n)
		}
	}
	a := ask()
	waitPending(1)
	now = now.Add(10 * time.Second)
	b := ask() // overlaps the first one
	waitPending(2)
	now = now.Add(5 * time.Second)
	for _, ap := range m.List("p") {
		if err := m.Resolve("p", ap.ID, Resolution{Decision: Allow}); err != nil {
			t.Fatal(err)
		}
	}
	<-a
	<-b
	now = now.Add(time.Hour) // working again: not waiting
	if got := m.TakeWaited("p", 7); got != 15*time.Second {
		t.Fatalf("waited = %v, want 15s", got)
	}
	if got := m.TakeWaited("p", 7); got != 0 {
		t.Fatalf("taken twice: %v", got)
	}
	if got := m.TakeWaited("p", 8); got != 0 {
		t.Fatalf("another turn waited %v", got)
	}
}
