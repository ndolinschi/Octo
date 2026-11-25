package bridge_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/bridge"
	"github.com/ndolinschi/Octo/apps/harness/internal/fakerouter"
	"github.com/ndolinschi/Octo/apps/harness/internal/mockllm"
	"github.com/ndolinschi/Octo/apps/harness/internal/router"
)

func TestConfigReportsRouter(t *testing.T) {
	octo := httptest.NewServer(fakerouter.New(mockllm.New(0), fakerouter.Options{}))
	defer octo.Close()
	plain := httptest.NewServer(mockllm.New(0))
	defer plain.Close()
	for _, tc := range []struct {
		name string
		opts []bridge.Option
		want bool
		caps int
	}{
		{"no router wired", nil, false, 0},
		{"base URL is not an Octo router", []bridge.Option{bridge.WithRouter(router.New(context.Background(), plain.URL, ""))}, false, 0},
		{"Octo router detected", []bridge.Option{bridge.WithRouter(router.New(context.Background(), octo.URL, ""))}, true, 4},
	} {
		t.Run(tc.name, func(t *testing.T) {
			e := newEnvWith(t, nil, nil, tc.opts...)
			var cfg struct {
				Router       bool     `json:"router"`
				Capabilities []string `json:"router_capabilities"`
				Models       any      `json:"default_models"`
			}
			e.into(t, "GET", "/v1/config", nil, http.StatusOK, &cfg)
			if cfg.Router != tc.want || cfg.Capabilities == nil || len(cfg.Capabilities) != tc.caps {
				t.Fatalf("router = %v, capabilities = %v; want %v and %d entries", cfg.Router, cfg.Capabilities, tc.want, tc.caps)
			}
		})
	}
}

func TestProjectBudgetAndTierPolicy(t *testing.T) {
	e := newEnv(t, nil)
	type proj struct {
		ID        string   `json:"id"`
		BudgetUSD *float64 `json:"budget_usd"`
		SpentUSD  *float64 `json:"spent_usd"`
		Models    struct {
			TierPolicy string `json:"tier_policy"`
		} `json:"models"`
	}
	var p proj
	e.into(t, "POST", "/v1/projects", map[string]any{"name": "b"}, http.StatusCreated, &p)
	if p.BudgetUSD != nil || p.SpentUSD != nil || p.Models.TierPolicy != "auto" {
		t.Fatalf("new project = %+v, want no budget, unknown spend, tier policy auto", p)
	}
	path := "/v1/projects/" + p.ID
	step := func(body map[string]any, wantBudget *float64, wantPolicy string) {
		t.Helper()
		var got proj
		e.into(t, "PATCH", path, body, http.StatusOK, &got)
		if (got.BudgetUSD == nil) != (wantBudget == nil) || (wantBudget != nil && *got.BudgetUSD != *wantBudget) || got.Models.TierPolicy != wantPolicy {
			t.Fatalf("after %v: budget %v policy %q; want %v %q", body, got.BudgetUSD, got.Models.TierPolicy, wantBudget, wantPolicy)
		}
		e.into(t, "GET", path, nil, http.StatusOK, &got)
		if (got.BudgetUSD == nil) != (wantBudget == nil) {
			t.Fatalf("GET after %v: budget %v", body, got.BudgetUSD)
		}
	}
	five, cent := 5.0, 0.01
	step(map[string]any{"budget_usd": 5}, &five, "auto")
	step(map[string]any{"name": "renamed"}, &five, "auto") // absent leaves it alone
	step(map[string]any{"models": map[string]any{"tier_policy": "ceiling"}}, &five, "ceiling")
	step(map[string]any{"budget_usd": 0.01, "models": map[string]any{"tier_policy": "fixed"}}, &cent, "fixed")
	step(map[string]any{"budget_usd": nil}, nil, "fixed") // null removes the budget

	for _, tc := range []struct {
		name string
		body map[string]any
	}{
		{"zero budget", map[string]any{"budget_usd": 0}},
		{"negative budget", map[string]any{"budget_usd": -1}},
		{"string budget", map[string]any{"budget_usd": "5"}},
		{"unknown tier policy", map[string]any{"models": map[string]any{"tier_policy": "cheapest"}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			e.wantError(t, "PATCH", path, tc.body, http.StatusBadRequest, "invalid_request")
		})
	}
	e.wantError(t, "POST", "/v1/projects", map[string]any{"name": "x", "budget_usd": -2}, http.StatusBadRequest, "invalid_request")
	var created proj
	e.into(t, "POST", "/v1/projects", map[string]any{"name": "y", "budget_usd": 3, "models": map[string]any{"tier_policy": "ceiling"}}, http.StatusCreated, &created)
	if created.BudgetUSD == nil || *created.BudgetUSD != 3 || created.Models.TierPolicy != "ceiling" {
		t.Fatalf("created = %+v", created)
	}
}
