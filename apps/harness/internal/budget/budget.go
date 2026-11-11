// Package budget knows what a project has spent so far: from the Octo router's
// last report when one is in the path, and from the project's own usage rows
// (reported costs plus price-table estimates). Nothing here talks to a model.
package budget

import (
	"context"

	"github.com/ndolinschi/Octo/apps/harness/internal/prices"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
	"github.com/ndolinschi/Octo/apps/harness/internal/router"
)

// Meter measures project spend. The zero value measures from usage rows with
// no prices, so nothing but reported costs counts.
type Meter struct {
	Prices prices.Table
	Router *router.Router
}

// Spent returns the project's spend in USD; known is false when nothing in the
// project has a cost yet (never zero by guess). With a router it is the larger
// of the router's last report for the project and the rows' sum.
func (m Meter) Spent(ctx context.Context, db *projectstore.DB) (usd float64, known bool, err error) {
	rows, err := db.UsageRows(ctx, "0000", "9999", projectstore.GroupProject)
	if err != nil {
		return 0, false, err
	}
	for _, r := range rows {
		switch {
		case r.Reported:
			usd += r.ReportedCostUSD
			known = true
		case r.Source == projectstore.SourceAPI:
			est, ok := m.Prices.Estimate(r.Model, prices.Tokens{
				Input: r.InputTokens, Output: r.OutputTokens, CacheRead: r.CacheReadTokens, CacheWrite: r.CacheWriteTokens,
			})
			if ok {
				usd += est
				known = true
			}
		}
	}
	if v, ok := m.Router.Spent(db.ID()); ok && (!known || v > usd) {
		usd, known = v, true
	}
	return usd, known, nil
}

// Reached reports whether spend has reached the budget. A project without a
// budget or without a known spend never has.
func (m Meter) Reached(ctx context.Context, db *projectstore.DB, budgetUSD *float64) (*router.BudgetError, error) {
	if budgetUSD == nil {
		return nil, nil
	}
	spent, known, err := m.Spent(ctx, db)
	if err != nil || !known || spent < *budgetUSD {
		return nil, err
	}
	return &router.BudgetError{Spent: spent, Budget: *budgetUSD}, nil
}
