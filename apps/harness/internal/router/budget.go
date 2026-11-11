package router

import (
	"errors"
	"fmt"
)

// BudgetError is a project budget that is used up. Its message is the one the
// agent settles with: "Project budget reached ($X of $Y)".
type BudgetError struct {
	// Spent and Budget are in USD; a negative value means unknown.
	Spent, Budget float64
}

func (e *BudgetError) Error() string {
	if e.Spent < 0 || e.Budget < 0 {
		return "Project budget reached"
	}
	return fmt.Sprintf("Project budget reached ($%s of $%s)", fmtUSD(e.Spent), fmtUSD(e.Budget))
}

// IsBudget reports whether err is, or wraps, a BudgetError.
func IsBudget(err error) bool {
	var be *BudgetError
	return errors.As(err, &be)
}

// fmtUSD uses two decimals, or four for amounts under a cent so that a $0.0042
// spend does not read as $0.00.
func fmtUSD(v float64) string {
	if v > 0 && v < 0.01 {
		return fmt.Sprintf("%.4f", v)
	}
	return fmt.Sprintf("%.2f", v)
}
