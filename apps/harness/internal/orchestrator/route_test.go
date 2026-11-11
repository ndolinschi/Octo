package orchestrator_test

import (
	"context"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/fakerouter"
	"github.com/ndolinschi/Octo/apps/harness/internal/mockllm"
	"github.com/ndolinschi/Octo/apps/harness/internal/orchestrator"
	"github.com/ndolinschi/Octo/apps/harness/internal/prices"
	"github.com/ndolinschi/Octo/apps/harness/internal/project"
)

func TestRouterHintsAndLedger(t *testing.T) {
	for _, stream := range []bool{false, true} {
		name := "non-streaming"
		if stream {
			name = "streaming"
		}
		t.Run(name, func(t *testing.T) {
			r, fr := newFakeRig(t, mockllm.New(0), fakerouter.Options{NotReady: 1}, orchestrator.Options{Stream: stream})
			pid := r.project(t, 1)
			if st := r.run(t, pid, "build it", nil); st != "completed" {
				t.Fatalf("turn status = %s", st)
			}
			reqs := fr.Requests()
			titles, orchs := map[string]bool{}, 0
			wantHint := map[string]string{"Map the repository layout": "fast", "Implement the change": "balanced", "Review design and risks": "deep"}
			for _, q := range reqs {
				h := q.Header
				if h.Get("x-octo-budget-key") != pid || h.Get("x-octo-tier-policy") != "auto" || h.Get("x-octo-agent-depth") == "" {
					t.Fatalf("hints missing on request %s: %v", q.ID, h)
				}
				switch h.Get("x-octo-agent-role") {
				case "orchestrator":
					orchs++
					if h.Get("x-octo-task") != "" || h.Get("x-octo-tier-hint") != "balanced" || h.Get("x-octo-agent-depth") != "0" {
						t.Errorf("orchestrator hints wrong: %v", h)
					}
				case "sub":
					title, err := url.PathUnescape(h.Get("x-octo-task"))
					titles[title] = true
					if err != nil || wantHint[title] == "" || h.Get("x-octo-tier-hint") != wantHint[title] || h.Get("x-octo-agent-depth") != "1" {
						t.Errorf("sub hints wrong (task %q): %v", title, h)
					}
				default:
					t.Errorf("role = %q", h.Get("x-octo-agent-role"))
				}
				if h.Get("x-octo-budget-usd") != "" {
					t.Errorf("budget header sent without a project budget: %v", h)
				}
			}
			if len(titles) != 3 || orchs < 2 {
				t.Fatalf("sub-agents seen = %v, orchestrator requests = %d", titles, orchs)
			}

			log := r.usageLog(t, pid)
			if len(log) != len(reqs) {
				t.Fatalf("usage rows = %d, router requests = %d", len(log), len(reqs))
			}
			byID := map[string]fakerouter.Request{}
			for _, q := range reqs {
				byID[q.ID] = q
			}
			var sum float64
			for _, e := range log {
				q, ok := byID[e.RouterRequestID]
				if !ok || e.ServedModel != q.Served || e.Tier != q.Tier || e.RouteTrigger != q.Trigger || e.Model == e.ServedModel {
					t.Fatalf("row %+v does not match router request %+v", e, q)
				}
				if e.CostUSD == nil || e.CostEstimated {
					t.Fatalf("row cost = %v estimated=%v, want the router's reported cost", e.CostUSD, e.CostEstimated)
				}
				sum += *e.CostUSD
			}
			if !near(sum, fr.Spent(pid)) {
				t.Fatalf("ledger cost %v != router spend %v", sum, fr.Spent(pid))
			}

			rep, err := r.svc.Usage(context.Background(), project.UsageQuery{Group: "model"})
			if err != nil {
				t.Fatal(err)
			}
			for _, b := range rep.Buckets {
				if !strings.HasPrefix(b.Key, "ladder-") || b.CostUSD == nil || b.CostEstimated {
					t.Errorf("bucket %+v: want a served-model key with a reported cost", b)
				}
			}
			if rep.Total.CostUSD == nil || !near(*rep.Total.CostUSD, sum) {
				t.Fatalf("report total = %v, want %v", rep.Total.CostUSD, sum)
			}
			if p, err := r.svc.Get(context.Background(), pid); err != nil || p.SpentUSD == nil || *p.SpentUSD < sum-1e-9 {
				t.Fatalf("project spent_usd = %v (%v), want >= %v", p.SpentUSD, err, sum)
			}
		})
	}
}

func TestRouterTierPolicy(t *testing.T) {
	rank := map[string]int{"low": 0, "mid": 1, "high": 2}
	hintRank := map[string]int{"fast": 0, "balanced": 1, "deep": 2}
	for _, policy := range []string{"auto", "ceiling", "fixed"} {
		t.Run(policy, func(t *testing.T) {
			r, fr := newFakeRig(t, mockllm.New(0), fakerouter.Options{}, orchestrator.Options{})
			pid := r.project(t, 1)
			if policy != "auto" {
				r.update(t, pid, policyInput(policy))
			}
			if st := r.run(t, pid, "build it", nil); st != "completed" {
				t.Fatalf("turn status = %s", st)
			}
			for _, q := range fr.Requests() {
				if got := q.Header.Get("x-octo-tier-policy"); got != policy {
					t.Fatalf("x-octo-tier-policy = %q, want %q", got, policy)
				}
				hint := hintRank[q.Header.Get("x-octo-tier-hint")]
				switch policy {
				case "fixed":
					if rank[q.Tier] != hint {
						t.Errorf("fixed: hint %s served %s", q.Header.Get("x-octo-tier-hint"), q.Tier)
					}
				case "ceiling":
					if rank[q.Tier] > hint {
						t.Errorf("ceiling: hint %s served %s", q.Header.Get("x-octo-tier-hint"), q.Tier)
					}
				}
			}
		})
	}
}

func TestNonOctoBaseURLSendsNoOctoHeaders(t *testing.T) {
	log := &headerLog{next: mockllm.New(0)}
	r := newRig(t, log)
	pid := r.project(t, 1)
	r.update(t, pid, budgetInput(5))
	if st := r.run(t, pid, "build it", nil); st != "completed" {
		t.Fatalf("turn status = %s", st)
	}
	if got := log.octoHeaders(); len(got) != 0 {
		t.Fatalf("x-octo-* headers sent to a non-Octo base URL: %v", got)
	}
	for _, e := range r.usageLog(t, pid) {
		if e.ServedModel != "" || e.Tier != "" || e.RouteTrigger != "" || e.RouterRequestID != "" || e.CostEstimated {
			t.Fatalf("router fields set without a router: %+v", e)
		}
	}
}

func TestCallRecordUnavailableFallsBackToEstimate(t *testing.T) {
	tab, err := prices.Parse("[models.\"ladder-mid\"]\ninput = 3\noutput = 15\n[models.\"ladder-low\"]\ninput = 1\noutput = 5\n[models.\"ladder-high\"]\ninput = 5\noutput = 25\n")
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name      string
		fo        fakerouter.Options
		prices    prices.Table
		wantCost  bool
		wantGuess bool
	}{
		{"record unavailable, with a price table", fakerouter.Options{NoRecords: true}, tab, true, true},
		{"record unavailable, without prices", fakerouter.Options{NoRecords: true}, prices.Table{}, false, false},
		{"router knows no price, with a price table", fakerouter.Options{Unpriced: true}, tab, true, true},
		{"router knows no price, without prices", fakerouter.Options{Unpriced: true}, prices.Table{}, false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r, fr := newFakeRig(t, mockllm.New(0), tc.fo, orchestrator.Options{Prices: tc.prices})
			pid := r.project(t, 1)
			if st := r.run(t, pid, "quick question", nil); st != "completed" {
				t.Fatalf("turn status = %s", st)
			}
			for _, e := range r.usageLog(t, pid) {
				if e.CostUSD != nil || e.ServedModel == "" || e.RouterRequestID == "" {
					t.Fatalf("row = %+v, want served model and request id but no router cost", e)
				}
			}
			rep, err := r.svc.Usage(context.Background(), project.UsageQuery{Group: "model"})
			if err != nil {
				t.Fatal(err)
			}
			if (rep.Total.CostUSD != nil) != tc.wantCost || rep.Total.CostEstimated != tc.wantGuess {
				t.Fatalf("total cost = %v estimated = %v", rep.Total.CostUSD, rep.Total.CostEstimated)
			}
			_ = fr
		})
	}
}

func TestCancelledRequestIsRecorded(t *testing.T) {
	hang := http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"m\",\"type\":\"message\"," +
			"\"role\":\"assistant\",\"model\":\"x\",\"content\":[],\"stop_reason\":null,\"usage\":{\"input_tokens\":321,\"output_tokens\":1}}}\n\n"))
		w.(http.Flusher).Flush()
		<-req.Context().Done()
	})
	r, fr := newFakeRig(t, hang, fakerouter.Options{}, orchestrator.Options{Stream: true})
	pid := r.project(t, 1)
	st := r.run(t, pid, "anything", func() {
		deadline := time.Now().Add(5 * time.Second)
		for fr.UpstreamCalls() == 0 && time.Now().Before(deadline) {
			time.Sleep(5 * time.Millisecond)
		}
		time.Sleep(50 * time.Millisecond)
		r.orch.Cancel(pid)
	})
	if st != "cancelled" {
		t.Fatalf("turn status = %s", st)
	}
	log := r.usageLog(t, pid)
	if len(log) != 1 || log[0].RouterRequestID == "" || log[0].CostUSD == nil || log[0].InputTokens != 321 {
		t.Fatalf("usage rows after cancel = %+v, want one row with the router's cost and the known tokens", log)
	}
}
