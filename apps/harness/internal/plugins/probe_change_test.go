package plugins

import (
	"context"
	"sync/atomic"
	"testing"
	"time"
)

// OnProbeChange fires when a probe's outcome differs from the last one (the
// first result included), never when it repeats.
func TestOnProbeChangeFiresOnlyWhenTheOutcomeChanges(t *testing.T) {
	r := loadProbeRegistry(t, `["sh","-c","true"]`)
	var clock atomic.Int64
	clock.Store(time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC).UnixNano())
	var verdict atomic.Bool
	verdict.Store(true)
	var runs, changes atomic.Int32
	r.probes.now = func() time.Time { return time.Unix(0, clock.Load()) }
	r.probes.run = func(context.Context, Agent) ProbeReport {
		runs.Add(1)
		v := verdict.Load()
		return ProbeReport{Ran: true, LoggedIn: &v}
	}
	r.OnProbeChange(func() { changes.Add(1) })
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	r.StartProbes(ctx)

	waitFor(t, "the first result", func() bool { return changes.Load() == 1 })
	if v := loggedIn(t, r, "a"); v == nil || !*v {
		t.Fatalf("logged in = %v", v)
	}

	// Same outcome a minute later: probed again, no change.
	clock.Add(int64(ProbeInterval + time.Second))
	r.Agents()
	waitFor(t, "the second probe", func() bool { return runs.Load() == 2 })
	time.Sleep(50 * time.Millisecond)
	if changes.Load() != 1 {
		t.Fatalf("changes = %d after an unchanged probe", changes.Load())
	}

	// The login goes away.
	verdict.Store(false)
	clock.Add(int64(ProbeInterval + time.Second))
	r.Agents()
	waitFor(t, "the change", func() bool { return changes.Load() == 2 })
	if v := loggedIn(t, r, "a"); v == nil || *v {
		t.Fatalf("logged in = %v", v)
	}
}
