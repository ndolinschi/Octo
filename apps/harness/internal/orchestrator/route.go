package orchestrator

import (
	"context"

	"github.com/ndolinschi/Octo/apps/harness/internal/budget"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
	"github.com/ndolinschi/Octo/apps/harness/internal/router"
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
		TierPolicy: rt.models.Policy(), BudgetUSD: rt.info.BudgetUSD,
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

// gate enforces the project budget itself, before each request, when no router
// does it: spend from the usage rows (reported costs and price-table estimates)
// against the budget read fresh from the project.
func (rt *runtime) gate() func(context.Context) error {
	if rt.o.opts.Router.Has(router.CapBudgetKey) {
		return nil
	}
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
