package orchestrator

import (
	"context"

	"github.com/ndolinschi/Octo/apps/harness/internal/budget"
	"github.com/ndolinschi/Octo/apps/harness/internal/prices"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
	"github.com/ndolinschi/Octo/apps/harness/internal/router"
	"github.com/ndolinschi/Octo/apps/harness/internal/usererr"
)

func (rt *runtime) meter() budget.Meter {
	return budget.Meter{Prices: rt.o.opts.Prices, Router: rt.o.opts.Router}
}

// hints are the router hint headers for an agent's requests. The tier hint is
// the tier the harness itself would have used: a sub-agent's spawn tier, and for
// the orchestrator the tier whose model it was configured with (balanced when
// it is none of them).
func (rt *runtime) hints(a projectstore.Agent) router.Hints {
	h := router.Hints{
		BudgetKey: rt.pid(), Role: "orchestrator", Depth: a.Depth, TierHint: string(projectstore.TierBalanced),
		TierPolicy: rt.models.Policy(), BudgetUSD: rt.info.BudgetUSD, BudgetFn: rt.currentBudget,
	}
	switch a.Model {
	case rt.models.Fast:
		h.TierHint = string(projectstore.TierFast)
	case rt.models.Deep:
		h.TierHint = string(projectstore.TierDeep)
	}
	if a.ParentID != nil {
		h.Role, h.Task = "sub", a.Title
		if a.Tier != nil {
			h.TierHint = string(*a.Tier)
		}
	}
	return h
}

// currentBudget is the project's budget now (read fresh, so one changed during
// a turn is sent with the turn's next request).
func (rt *runtime) currentBudget() *float64 {
	c, cancel := dbCtx(context.Background())
	defer cancel()
	info, err := rt.db.Info(c)
	if err != nil {
		return rt.info.BudgetUSD
	}
	return info.BudgetUSD
}

// gate checks the project budget before each request, with the very condition
// delegation uses (budgetReached): the router's last reported spend when one is
// in the path (the router's 402 stays as the backstop), else the usage rows'
// reported costs and price-table estimates; against the budget read fresh.
func (rt *runtime) gate() func(context.Context) error {
	return func(ctx context.Context) error {
		if be := rt.budgetReached(ctx); be != nil {
			return be
		}
		return nil
	}
}

// budgetReached returns the budget error when the project's last known spend
// is at or over its budget. Failures to measure count as not reached.
func (rt *runtime) budgetReached(ctx context.Context) *router.BudgetError {
	info, err := rt.db.Info(ctx)
	if err != nil || info.BudgetUSD == nil {
		return nil
	}
	be, err := rt.meter().Reached(ctx, rt.db, info.BudgetUSD)
	if err != nil {
		rt.logErr("measure project spend", err)
		return nil
	}
	return be
}

// budgetFloorTokens is the least output a request may ask for under a budget cap: a nearly spent budget still
// gets an answer of a few paragraphs, and the overshoot stays at most this much output (plus the input).
const budgetFloorTokens = 256

// outputCap is the loop's OutputCap (P2-11): the most output tokens the project's remaining budget can buy at
// model's price from the price table, after the request's estimated input; never below budgetFloorTokens. 0 (no
// cap) without a budget or a known price. The budget is still checked before every request (gate); this bounds
// what one long request can spend past it. (A request's cost is known only at its end; the cap bounds it before.)
func (rt *runtime) outputCap(model string) func(context.Context, func() int64) int64 {
	return func(ctx context.Context, inputTokens func() int64) int64 {
		c, cancel := dbCtx(ctx)
		defer cancel()
		info, err := rt.db.Info(c)
		if err != nil || info.BudgetUSD == nil {
			return 0
		}
		m := rt.meter()
		perMillion, ok := m.Prices.Estimate(model, prices.Tokens{Output: 1_000_000})
		if !ok || perMillion <= 0 {
			return 0
		}
		spent, _, err := m.Spent(c, rt.db)
		if err != nil {
			return 0
		}
		left := *info.BudgetUSD - spent
		if in, ok := m.Prices.Estimate(model, prices.Tokens{Input: inputTokens()}); ok {
			left -= in
		}
		n := int64(left / perMillion * 1_000_000)
		return max(n, budgetFloorTokens)
	}
}

// budgetCut is the loop's BudgetCut: the error a turn ends with when the cap stopped an answer.
func (rt *runtime) budgetCut(ctx context.Context) error {
	spent, budget := -1.0, -1.0
	c, cancel := dbCtx(ctx)
	defer cancel()
	if info, err := rt.db.Info(c); err == nil && info.BudgetUSD != nil {
		budget = *info.BudgetUSD
		if v, known, err := rt.meter().Spent(c, rt.db); err == nil && known {
			spent = v
		}
	}
	return usererr.BudgetCut(spent, budget).Caused(&router.BudgetError{Spent: spent, Budget: budget})
}
