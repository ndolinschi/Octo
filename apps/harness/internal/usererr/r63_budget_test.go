package usererr

import (
	"strings"
	"testing"
)

// R6-3: a refusal with spend under the budget (the router's check before a
// request) does not say "used up" next to "$2.03 of $3.00".
func TestBudgetReachedUnderTheBudgetSaysWhatIsLeftDoesNotCover(t *testing.T) {
	if m := BudgetReached(2.03, 3).Message; strings.Contains(m, "is used up") || !strings.Contains(m, "does not cover the next request") || !strings.Contains(m, "$2.03 of $3.00") {
		t.Fatalf("under budget: %q", m)
	}
	if m := BudgetReached(3.01, 3).Message; m != "This project's budget is used up ($3.01 of $3.00)." {
		t.Fatalf("over budget: %q", m)
	}
	if m := BudgetReached(-1, 3).Message; m != "This project's budget is used up." {
		t.Fatalf("unknown spend: %q", m)
	}
}
