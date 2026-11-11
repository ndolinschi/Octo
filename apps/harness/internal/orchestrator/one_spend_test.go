package orchestrator_test

import (
	"context"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/completion"
	"github.com/ndolinschi/Octo/apps/harness/internal/config"
	"github.com/ndolinschi/Octo/apps/harness/internal/fakerouter"
	"github.com/ndolinschi/Octo/apps/harness/internal/mockllm"
	"github.com/ndolinschi/Octo/apps/harness/internal/orchestrator"
	"github.com/ndolinschi/Octo/apps/harness/internal/project"
	"github.com/ndolinschi/Octo/apps/harness/internal/router"
)

func rowsSum(t *testing.T, r *rig, pid string) float64 {
	t.Helper()
	var sum float64
	for _, e := range r.usageLog(t, pid) {
		if e.CostUSD != nil {
			sum += *e.CostUSD
		}
	}
	return sum
}

// Router mode: the project's spend is the router's figure, not a sum of the
// call records, which miss what the router charges for classifying.
func TestRouterModeSpendIsTheRoutersNotASumOfRows(t *testing.T) {
	const classify = 0.0004
	r, fr := newFakeRig(t, mockllm.New(0), fakerouter.Options{ClassifierUSD: classify}, orchestrator.Options{})
	pid := r.project(t, 1)
	r.update(t, pid, budgetInput(1000))
	if st := r.run(t, pid, "build it", nil); st != "completed" {
		t.Fatalf("turn = %s", st)
	}
	sum := rowsSum(t, r, pid)
	p, err := r.svc.Get(context.Background(), pid)
	if err != nil || p.SpentUSD == nil {
		t.Fatalf("project = %+v %v", p.SpentUSD, err)
	}
	routerSpent := fr.Spent(pid)
	if routerSpent < sum+classify-1e-9 {
		t.Fatalf("fake router spent %v, rows %v: the classifier cost is not in the scenario", routerSpent, sum)
	}
	// Not the rows' sum. Without a post-call figure the number lags the router
	// by at most the classifier cost of the last call.
	if *p.SpentUSD <= sum+1e-9 && sum > 0 && *p.SpentUSD < routerSpent-classify-1e-9 {
		t.Fatalf("harness spend %v is the rows' sum %v (router: %v)", *p.SpentUSD, sum, routerSpent)
	}
	if *p.SpentUSD > routerSpent+1e-9 || *p.SpentUSD < routerSpent-classify-1e-9 {
		t.Fatalf("harness spend %v, router %v: off by more than one call's classifier cost", *p.SpentUSD, routerSpent)
	}
	// A further call brings it back in line with what the router reported before it.
	before := fr.Spent(pid)
	if st := r.run(t, pid, "once more", nil); st != "completed" {
		t.Fatalf("turn = %s", st)
	}
	p, _ = r.svc.Get(context.Background(), pid)
	if *p.SpentUSD < before-1e-9 {
		t.Fatalf("spend %v is below the router's earlier %v", *p.SpentUSD, before)
	}
}

// With the call record carrying the spend after the call, the harness matches
// the router exactly, also when calls overlap and finish out of order.
func TestRouterSpendAfterConcurrentCallsFinishingOutOfOrder(t *testing.T) {
	const classify = 0.0004
	var mu sync.Mutex
	n := 0
	delay := func(*http.Request) time.Duration {
		mu.Lock()
		defer mu.Unlock()
		n++
		return time.Duration(4-n) * 120 * time.Millisecond // the first call is the slowest
	}
	r, fr := newFakeRig(t, mockllm.New(0), fakerouter.Options{ClassifierUSD: classify, SpentAfter: true, DelayFor: delay}, orchestrator.Options{})
	pid := r.project(t, 1)
	r.update(t, pid, project.Input{Models: &config.Models{Completion: "fast"}})
	r.update(t, pid, budgetInput(1000))
	var wg sync.WaitGroup
	for i := 0; i < 3; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, _, err := r.orch.Complete(context.Background(), pid, completion.Request{Path: "a.go", Prefix: "x"}); err != nil {
				t.Error(err)
			}
		}()
		time.Sleep(15 * time.Millisecond) // arrive in order, overlapping
	}
	wg.Wait()
	p, err := r.svc.Get(context.Background(), pid)
	if err != nil || p.SpentUSD == nil {
		t.Fatalf("project = %v %v", p.SpentUSD, err)
	}
	if !near(*p.SpentUSD, fr.Spent(pid)) {
		t.Fatalf("harness spend %v != router spend %v after out-of-order completion", *p.SpentUSD, fr.Spent(pid))
	}
}

func TestNoteSpentKeepsTheHighestValue(t *testing.T) {
	rt := router.New(context.Background(), "http://127.0.0.1:1", "")
	rt.NoteSpent("k", 5)
	rt.NoteSpent("k", 3) // an older figure arriving late
	if v, _ := rt.Spent("k"); v != 5 {
		t.Fatalf("spent = %v, want 5", v)
	}
	rt.NoteSpent("k", 7)
	if v, _ := rt.Spent("k"); v != 7 {
		t.Fatalf("spent = %v, want 7", v)
	}
}
