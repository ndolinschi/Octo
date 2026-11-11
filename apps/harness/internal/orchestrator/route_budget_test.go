package orchestrator_test

import (
	"context"
	"net/http"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/fakerouter"
	"github.com/ndolinschi/Octo/apps/harness/internal/mockllm"
	"github.com/ndolinschi/Octo/apps/harness/internal/orchestrator"
	"github.com/ndolinschi/Octo/apps/harness/internal/prices"
)

var budgetMessage = regexp.MustCompile(`^Project budget reached \(\$\d+\.\d+ of \$0\.01\)$`)

// pricey makes one request cost far more than a cent.
var pricey = map[string][2]float64{"low": {3000, 15000}, "mid": {3000, 15000}, "high": {3000, 15000}}

func TestRouterBudgetStopsTurn(t *testing.T) {
	for _, stream := range []bool{false, true} {
		name := "non-streaming"
		if stream {
			name = "streaming"
		}
		t.Run(name, func(t *testing.T) {
			r, fr := newFakeRig(t, mockllm.New(0), fakerouter.Options{Rates: pricey}, orchestrator.Options{Stream: stream})
			pid := r.project(t, 1)
			r.update(t, pid, budgetInput(0.01))
			if st := r.run(t, pid, "build it", nil); st != "failed" {
				t.Fatalf("turn status = %s, want failed", st)
			}
			calls := fr.UpstreamCalls()
			if calls != 1 {
				t.Fatalf("upstream calls = %d, want only the orchestrator's first", calls)
			}
			time.Sleep(150 * time.Millisecond)
			if fr.UpstreamCalls() != calls {
				t.Fatal("upstream calls continued after the turn stopped")
			}
			agents := r.agents(t, pid)
			if agents[0].Error == nil || !budgetMessage.MatchString(*agents[0].Error) {
				t.Fatalf("orchestrator error = %v", agents[0].Error)
			}
			// No sub-agent ran over budget: each refused delegation is a failed row with the reason.
			for _, a := range agents[1:] {
				if a.Status != "failed" || a.Error == nil || !budgetMessage.MatchString(*a.Error) {
					t.Fatalf("sub-agent %s = %s / %v; want failed with the budget message", a.Role, a.Status, a.Error)
				}
			}
			for _, q := range fr.Requests() {
				if q.Header.Get("x-octo-budget-usd") != "0.01" || q.Header.Get("x-octo-budget-key") != pid {
					t.Fatalf("budget headers = %q / %q", q.Header.Get("x-octo-budget-usd"), q.Header.Get("x-octo-budget-key"))
				}
			}
			p, err := r.svc.Get(context.Background(), pid)
			if err != nil || p.BudgetUSD == nil || *p.BudgetUSD != 0.01 || p.SpentUSD == nil || *p.SpentUSD < 0.01 {
				t.Fatalf("project budget/spent = %v / %v (%v)", p.BudgetUSD, p.SpentUSD, err)
			}
		})
	}
}

// The router rejects a sub-agent's request (402) although the harness still
// believes there is room: the sub-agent fails with the message and the whole
// turn stops, with no further upstream calls.
func TestRouter402StopsTheTurnFromASubAgent(t *testing.T) {
	r, fr := newFakeRig(t, mockllm.New(0), fakerouter.Options{RejectRole: "sub"}, orchestrator.Options{})
	pid := r.project(t, 1)
	r.update(t, pid, budgetInput(1000))
	if st := r.run(t, pid, "build it", nil); st != "failed" {
		t.Fatalf("turn status = %s, want failed", st)
	}
	time.Sleep(150 * time.Millisecond)
	if n := fr.UpstreamCalls(); n != 1 {
		t.Fatalf("upstream calls = %d, want 1", n)
	}
	want := regexp.MustCompile(`^Project budget reached \(\$\d+\.\d+ of \$1000\.00\)$`)
	failed := 0
	for _, a := range r.agents(t, pid) {
		if a.ParentID != nil && a.Status == "failed" && a.Error != nil && want.MatchString(*a.Error) {
			failed++
		}
	}
	if failed == 0 {
		t.Fatalf("no sub-agent failed with the budget message: %+v", r.agents(t, pid))
	}
	if e := r.agents(t, pid)[0].Error; e == nil || !want.MatchString(*e) {
		t.Fatalf("orchestrator error = %v", e)
	}
}

func TestSpawnRefusedOnceSpendReachesBudget(t *testing.T) {
	r, _ := newFakeRig(t, mockllm.New(0), fakerouter.Options{Rates: pricey, IgnoreBudget: true}, orchestrator.Options{})
	pid := r.project(t, 1)
	if st := r.run(t, pid, "build it", nil); st != "completed" {
		t.Fatalf("first turn = %s", st)
	}
	before := len(r.agents(t, pid))
	r.update(t, pid, budgetInput(0.01))
	// The router's spend is already over the budget: the orchestrator's own request is
	// stopped by the same check as delegation, before anything is sent.
	if st := r.run(t, pid, "build it again", nil); st != "failed" {
		t.Fatalf("second turn = %s, want failed", st)
	}
	if got := len(r.agents(t, pid)); got != before {
		t.Fatalf("agents %d -> %d: sub-agents were started over budget", before, got)
	}
	if e := r.agents(t, pid)[0].Error; e == nil || !budgetMessage.MatchString(*e) {
		t.Fatalf("orchestrator error = %v", e)
	}
}

func TestNoRouterBudgetEnforcedFromUsageRows(t *testing.T) {
	tab, err := prices.Parse("[models.\"claude-sonnet-5-5\"]\ninput = 3000000\noutput = 15000000\n")
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name   string
		prices prices.Table
		status string
		calls  int
	}{
		{"prices known", tab, "failed", 1},
		{"no prices means unknown spend, no enforcement", prices.Table{}, "completed", -1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			log := &headerLog{next: mockllm.New(0)}
			r := newRigWith(t, log, orchestrator.Options{Prices: tc.prices})
			pid := r.project(t, 1)
			r.update(t, pid, budgetInput(0.01))
			st := r.run(t, pid, "build it", nil)
			if st != tc.status {
				t.Fatalf("turn status = %s, want %s", st, tc.status)
			}
			log.mu.Lock()
			upstream := 0
			for _, u := range log.urls {
				if u == "/v1/messages" {
					upstream++
				}
			}
			log.mu.Unlock()
			if tc.calls > 0 && upstream != tc.calls {
				t.Fatalf("upstream requests = %d, want %d", upstream, tc.calls)
			}
			if tc.status == "failed" {
				if e := r.agents(t, pid)[0].Error; e == nil || !budgetMessage.MatchString(*e) {
					t.Fatalf("orchestrator error = %v", e)
				}
			}
		})
	}
}

// compactingUpstream spawns one child on the orchestrator's first request, and
// ends once its history is the summary or a thread that starts with it.
func compactingUpstream() http.Handler {
	return fakeLLM(func(w http.ResponseWriter, _ *http.Request, req fakeReq) {
		switch {
		case !req.isOrchestrator():
			respondAs(w, req, "end_turn", textBlock("child report"))
		case len(req.Msgs) == 1 && !strings.Contains(string(req.Msgs[0]), fakerouter.SummaryText):
			respondAs(w, req, "tool_use", spawnBlock("t1", "worker"))
		default:
			respondAs(w, req, "end_turn", textBlock("all done"))
		}
	})
}

func TestRouterCompactionIsApplied(t *testing.T) {
	for _, asText := range []bool{false, true} {
		for _, stream := range []bool{false, true} {
			name := "compaction block"
			if asText {
				name = "text blocks"
			}
			if stream {
				name += ", streaming requested"
			}
			t.Run(name, func(t *testing.T) {
				r, fr := newFakeRig(t, compactingUpstream(), fakerouter.Options{CompactAt: 3, CompactAsText: asText}, orchestrator.Options{Stream: stream})
				pid := r.project(t, 1)
				if st := r.run(t, pid, "first", nil); st != "completed" {
					t.Fatalf("turn 1 = %s", st)
				}
				var orch []fakerouter.Request
				for _, q := range fr.Requests() {
					if q.Header.Get("x-octo-agent-role") == "orchestrator" {
						orch = append(orch, q)
					}
				}
				if len(orch) != 3 || orch[1].Trigger != "compact" {
					t.Fatalf("orchestrator requests = %d, want 3 with a compaction second", len(orch))
				}
				n := []int{messageCount(t, orch[0].Body), messageCount(t, orch[1].Body), messageCount(t, orch[2].Body)}
				if n[0] != 1 || n[1] != 3 || n[2] != 1 || !strings.Contains(string(orch[2].Body), fakerouter.SummaryText) {
					t.Fatalf("messages per request = %v; the request after compaction must be shorter and carry the summary", n)
				}
				a := r.agents(t, pid)[0]
				msgs, err := r.svc.Messages(context.Background(), pid, a.ID)
				if err != nil || len(msgs) != 4 {
					t.Fatalf("raw messages kept = %d (%v), want 4 and none for the summary", len(msgs), err)
				}
				db, _ := r.store.Get(context.Background(), pid)
				comp, ok, err := db.LatestCompaction(context.Background(), a.ID)
				if err != nil || !ok || comp.Summary != fakerouter.SummaryText || comp.UptoMessageID != msgs[2].ID {
					t.Fatalf("stored compaction = %+v ok=%v err=%v", comp, ok, err)
				}
				if st := r.run(t, pid, "second", nil); st != "completed" {
					t.Fatalf("turn 2 = %s", st)
				}
				all := fr.Requests()
				last := all[len(all)-1]
				if messageCount(t, last.Body) != 3 || last.Trigger == "compact" || !strings.Contains(string(last.Body), fakerouter.SummaryText) {
					t.Fatalf("turn 2 request: %d messages, trigger %q; want summary + 2 later messages, no new compaction",
						messageCount(t, last.Body), last.Trigger)
				}
				var compactRows int
				for _, e := range r.usageLog(t, pid) {
					if e.RouteTrigger == "compact" {
						compactRows++
					}
				}
				if compactRows != 1 {
					t.Fatalf("usage rows with trigger compact = %d", compactRows)
				}
			})
		}
	}
}
