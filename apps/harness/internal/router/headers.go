package router

import (
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

// Request hint headers (harness to router, stripped by the router upstream).
const (
	HeaderBudgetKey  = "x-octo-budget-key"
	HeaderAgentRole  = "x-octo-agent-role"
	HeaderAgentDepth = "x-octo-agent-depth"
	HeaderTierHint   = "x-octo-tier-hint"
	HeaderTierPolicy = "x-octo-tier-policy"
	HeaderTask       = "x-octo-task"
	HeaderBudgetUSD  = "x-octo-budget-usd"
)

// Result headers (router to harness).
const (
	headerModel     = "x-octo-model"
	headerTier      = "x-octo-tier"
	HeaderTrigger   = "x-octo-trigger"
	headerSpentUSD  = "x-octo-spent-usd"
	headerRequestID = "x-octo-request-id"
)

// TriggerCompact is the x-octo-trigger value of a compaction response.
const TriggerCompact = "compact"

const taskMaxRunes = 200

// Hints describe the task behind one agent's requests.
type Hints struct {
	BudgetKey string
	// Role is "orchestrator" or "sub".
	Role  string
	Depth int
	// TierHint is the tier (fast|balanced|deep) the harness would have used.
	TierHint string
	// TierPolicy is auto, ceiling or fixed.
	TierPolicy string
	// Task is the task title; only sent for sub-agents.
	Task      string
	BudgetUSD *float64
	// BudgetFn, when set, is asked for the project's budget at every request
	// (a budget changed while a turn runs applies to its next request) and
	// takes the place of BudgetUSD.
	BudgetFn func() *float64
}

// Budget is the budget to send now.
func (h Hints) Budget() *float64 {
	if h.BudgetFn != nil {
		return h.BudgetFn()
	}
	return h.BudgetUSD
}

// Header renders the hints as request headers. Empty fields are left out.
func (h Hints) Header() http.Header {
	out := http.Header{}
	set := func(k, v string) {
		if v != "" {
			out.Set(k, v)
		}
	}
	set(HeaderBudgetKey, h.BudgetKey)
	set(HeaderAgentRole, h.Role)
	out.Set(HeaderAgentDepth, strconv.Itoa(h.Depth))
	set(HeaderTierHint, h.TierHint)
	set(HeaderTierPolicy, h.TierPolicy)
	if h.Role == "sub" {
		set(HeaderTask, encodeTask(h.Task))
	}
	if b := h.Budget(); b != nil {
		out.Set(HeaderBudgetUSD, strconv.FormatFloat(*b, 'f', -1, 64))
	}
	return out
}

// encodeTask clips the title to 200 characters and percent-encodes it
// (spaces as %20, which every URL decoder reads back).
func encodeTask(title string) string {
	title = strings.Join(strings.Fields(title), " ")
	if r := []rune(title); len(r) > taskMaxRunes {
		title = string(r[:taskMaxRunes])
	}
	return strings.ReplaceAll(url.QueryEscape(title), "+", "%20")
}

// Result is what the router said about one response, from its headers.
type Result struct {
	Model     string
	Tier      string
	Trigger   string
	RequestID string
	// BudgetUSD and SpentUSD are set when the router reported a budget.
	BudgetUSD *float64
	SpentUSD  *float64
}

// ParseResult reads the result headers; absent or malformed ones stay empty.
func ParseResult(h http.Header) Result {
	if h == nil {
		return Result{}
	}
	return Result{
		Model: h.Get(headerModel), Tier: h.Get(headerTier), Trigger: h.Get(HeaderTrigger),
		RequestID: h.Get(headerRequestID),
		BudgetUSD: floatHeader(h, HeaderBudgetUSD), SpentUSD: floatHeader(h, headerSpentUSD),
	}
}

func floatHeader(h http.Header, name string) *float64 {
	v, err := strconv.ParseFloat(strings.TrimSpace(h.Get(name)), 64)
	if err != nil || v < 0 {
		return nil
	}
	return &v
}

// Any reports whether the response carried any x-octo result header.
func (r Result) Any() bool {
	return r.Model != "" || r.Tier != "" || r.Trigger != "" || r.RequestID != ""
}
