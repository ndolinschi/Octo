package router_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/router"
)

func healthServer(status int, body string) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/health" {
			http.NotFound(w, r)
			return
		}
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
}

func TestDetect(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status int
		body   string
		want   bool
		caps   []string
	}{
		{"octo", 200, `{"service":"octo","capabilities":["autoroute","budget_key"]}`, true, []string{"autoroute", "budget_key"}},
		{"octo without capabilities", 200, `{"service":"octo"}`, true, []string{}},
		{"harness-like", 200, `{"ok":true,"version":"0.2.0"}`, false, []string{}},
		{"other service", 200, `{"service":"litellm","capabilities":["autoroute"]}`, false, []string{}},
		{"error status", 500, `{"service":"octo"}`, false, []string{}},
		{"not json", 200, `ok`, false, []string{}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := healthServer(tc.status, tc.body)
			defer srv.Close()
			r := router.New(context.Background(), srv.URL+"/some/base", "")
			if got := r.Enabled(); got != tc.want {
				t.Fatalf("Enabled = %v, want %v", got, tc.want)
			}
			if got := strings.Join(r.Capabilities(), ","); got != strings.Join(tc.caps, ",") {
				t.Fatalf("capabilities = %q, want %q", got, tc.caps)
			}
		})
	}
}

func TestNilAndEmptyBaseURL(t *testing.T) {
	var nilRouter *router.Router
	if nilRouter.Enabled() || nilRouter.Has(router.CapBudgetKey) || len(nilRouter.Capabilities()) != 0 {
		t.Fatal("nil router must be off")
	}
	if router.New(context.Background(), "", "").Enabled() {
		t.Fatal("empty base URL must be off")
	}
	if router.New(context.Background(), "http://127.0.0.1:1", "").Enabled() {
		t.Fatal("unreachable base URL must be off")
	}
}

func TestLazyReprobe(t *testing.T) {
	var up atomic.Bool
	var probes atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		probes.Add(1)
		if !up.Load() {
			http.Error(w, "starting", http.StatusServiceUnavailable)
			return
		}
		_, _ = w.Write([]byte(`{"service":"octo","capabilities":["autoroute"]}`))
	}))
	defer srv.Close()
	r := router.New(context.Background(), srv.URL, "", router.WithReprobeInterval(20*time.Millisecond))
	if r.Enabled() {
		t.Fatal("enabled before the router is up")
	}
	// Enabled() must not probe inline; within the interval nothing is re-probed.
	before := probes.Load()
	for range 5 {
		r.Enabled()
	}
	if probes.Load() != before {
		t.Fatalf("probed again within the reprobe interval: %d -> %d", before, probes.Load())
	}
	up.Store(true)
	deadline := time.Now().Add(3 * time.Second)
	for !r.Enabled() {
		if time.Now().After(deadline) {
			t.Fatal("router never detected after it came up")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !r.Has(router.CapAutoroute) || r.Has(router.CapBudgetKey) {
		t.Fatalf("capabilities = %v", r.Capabilities())
	}
}

func TestHintsHeader(t *testing.T) {
	budget := 0.5
	long := strings.Repeat("ä", 300)
	for _, tc := range []struct {
		name string
		in   router.Hints
		want map[string]string
		none []string
	}{
		{
			name: "orchestrator",
			in:   router.Hints{BudgetKey: "prj_1", Role: "orchestrator", TierHint: "balanced", TierPolicy: "auto", Task: "ignored"},
			want: map[string]string{
				router.HeaderBudgetKey: "prj_1", router.HeaderAgentRole: "orchestrator", router.HeaderAgentDepth: "0",
				router.HeaderTierHint: "balanced", router.HeaderTierPolicy: "auto",
			},
			none: []string{router.HeaderTask, router.HeaderBudgetUSD},
		},
		{
			name: "sub with budget",
			in: router.Hints{BudgetKey: "prj_1", Role: "sub", Depth: 2, TierHint: "fast", TierPolicy: "ceiling",
				Task: "Fix the  parser & ship it", BudgetUSD: &budget},
			want: map[string]string{
				router.HeaderAgentRole: "sub", router.HeaderAgentDepth: "2", router.HeaderTierHint: "fast",
				router.HeaderTierPolicy: "ceiling", router.HeaderTask: "Fix%20the%20parser%20%26%20ship%20it",
				router.HeaderBudgetUSD: "0.5",
			},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := tc.in.Header()
			for k, v := range tc.want {
				if got := h.Get(k); got != v {
					t.Errorf("%s = %q, want %q", k, got, v)
				}
			}
			for _, k := range tc.none {
				if _, ok := h[http.CanonicalHeaderKey(k)]; ok {
					t.Errorf("%s must not be set", k)
				}
			}
		})
	}
	t.Run("task clipped to 200 characters", func(t *testing.T) {
		h := router.Hints{Role: "sub", Task: long}.Header()
		got, err := url.PathUnescape(h.Get(router.HeaderTask))
		if err != nil || len([]rune(got)) != 200 {
			t.Fatalf("decoded task has %d runes (err %v), want 200", len([]rune(got)), err)
		}
	})
}

func TestParseResult(t *testing.T) {
	h := http.Header{}
	h.Set("x-octo-model", "m")
	h.Set("x-octo-tier", "low")
	h.Set("x-octo-trigger", "compact")
	h.Set("x-octo-request-id", "req_9")
	h.Set("x-octo-budget-usd", "2.5")
	h.Set("x-octo-spent-usd", "oops")
	r := router.ParseResult(h)
	if r.Model != "m" || r.Tier != "low" || r.Trigger != router.TriggerCompact || r.RequestID != "req_9" || !r.Any() {
		t.Fatalf("result = %+v", r)
	}
	if r.BudgetUSD == nil || *r.BudgetUSD != 2.5 || r.SpentUSD != nil {
		t.Fatalf("budget/spent = %v / %v", r.BudgetUSD, r.SpentUSD)
	}
	if router.ParseResult(http.Header{}).Any() {
		t.Fatal("empty headers must be empty")
	}
}

func TestFetchCall(t *testing.T) {
	for _, tc := range []struct {
		name      string
		notReady  int32
		status    int
		wantErr   bool
		wantCalls int32
	}{
		{"ready at once", 0, 200, false, 1},
		{"404 then 200 after one retry", 1, 200, false, 2},
		{"404 twice gives up", 2, 200, true, 2},
		{"server error is not retried", 0, 500, true, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var calls atomic.Int32
			var key atomic.Value
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/health" {
					_, _ = w.Write([]byte(`{"service":"octo"}`))
					return
				}
				key.Store(r.Header.Get("x-octo-key"))
				n := calls.Add(1)
				switch {
				case tc.status != 200:
					w.WriteHeader(tc.status)
				case n <= tc.notReady:
					w.WriteHeader(http.StatusNotFound)
				default:
					_, _ = w.Write([]byte(`{"model":"m","tier":"mid","trigger":"sticky","input_tokens":7,"output_tokens":3,` +
						`"cache_read_tokens":1,"cache_write_tokens":2,"cost_usd":0.0123,"cost_source":"estimated"}`))
				}
			}))
			defer srv.Close()
			r := router.New(context.Background(), srv.URL, "secret", router.WithCallRetryWait(time.Millisecond))
			c, err := r.FetchCall(context.Background(), "req_1")
			if (err != nil) != tc.wantErr || calls.Load() != tc.wantCalls {
				t.Fatalf("err = %v, calls = %d; want error %v, calls %d", err, calls.Load(), tc.wantErr, tc.wantCalls)
			}
			if !tc.wantErr && (c.Model != "m" || c.InputTokens != 7 || c.CostUSD == nil || *c.CostUSD != 0.0123 || c.CostSource != router.CostEstimated) {
				t.Fatalf("call = %+v", c)
			}
			if key.Load() != "secret" {
				t.Fatalf("x-octo-key = %v", key.Load())
			}
		})
	}
}

func TestBudgetErrorMessage(t *testing.T) {
	for _, tc := range []struct {
		err  router.BudgetError
		want string
	}{
		{router.BudgetError{Spent: 0.0123, Budget: 0.01}, "Project budget reached ($0.01 of $0.01)"},
		{router.BudgetError{Spent: 0.0042, Budget: 0.01}, "Project budget reached ($0.0042 of $0.01)"},
		{router.BudgetError{Spent: 12.5, Budget: 10}, "Project budget reached ($12.50 of $10.00)"},
		{router.BudgetError{Spent: -1, Budget: 10}, "Project budget reached"},
	} {
		if got := tc.err.Error(); got != tc.want {
			t.Errorf("%+v = %q, want %q", tc.err, got, tc.want)
		}
	}
}
