package router

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// CapRouteAPI is the capability of a router that answers POST
// /autoroute/v1/route (who should do a delegated task).
const CapRouteAPI = "route_api"

// DefaultRouteTimeout is how long a route call may take by default.
//
// It is deliberately generous: the router's own classifier timeout is 2000 ms
// by default and a sub-agent runs for minutes, so waiting is cheaper than a
// wrong choice. Keep it above the router's [autoroute.route] classifier_timeout_ms.
const DefaultRouteTimeout = 2500 * time.Millisecond

// WithRouteTimeout overrides the route call's timeout (HARNESS_ROUTE_TIMEOUT).
func WithRouteTimeout(d time.Duration) Option {
	return func(r *Router) {
		if d > 0 {
			r.routeTimeout = d
		}
	}
}

// WithAPIKey sets the token the router uses for its classifier call on a route
// request (sent as x-api-key); without one the router falls back to its text rule.
func WithAPIKey(k string) Option { return func(r *Router) { r.apiKey = k } }

// RouteTask is the task a route call is about.
type RouteTask struct {
	Title string   `json:"title"`
	Brief string   `json:"brief"`
	Tools []string `json:"tools"`
	Depth int      `json:"depth"`
}

// Candidate is one who-can-do-it option offered to the router: an API tier
// (Kind "api") or a local agent (Kind "agent").
type Candidate struct {
	ID   string `json:"id"`
	Kind string `json:"kind"`
	// Tier is set for Kind "api": fast, balanced or deep.
	Tier string `json:"tier,omitempty"`
	// The rest is for Kind "agent".
	Label          string   `json:"label,omitempty"`
	FlatRate       *bool    `json:"flat_rate,omitempty"`
	LoggedIn       *bool    `json:"logged_in,omitempty"`
	LimitRemaining *float64 `json:"limit_remaining,omitempty"`
	Strengths      []string `json:"strengths,omitempty"`
}

// RouteRequest is the body of POST /autoroute/v1/route.
type RouteRequest struct {
	BudgetKey  string      `json:"budget_key"`
	Task       RouteTask   `json:"task"`
	Candidates []Candidate `json:"candidates"`
}

// RouteDecision is the router's answer.
type RouteDecision struct {
	Choice string `json:"choice"`
	// Model is present for an API choice only (the ladder slug), informational:
	// the harness sends the tier hint and lets the router serve it. The
	// harness also accepts one for an agent when the agent offers that model.
	Model string `json:"model"`
	// Band is easy, medium or hard.
	Band             string        `json:"band"`
	Reason           string        `json:"reason"`
	EstimatedCostUSD *float64      `json:"estimated_cost_usd"`
	RequestID        string        `json:"request_id"`
	Alternatives     []Alternative `json:"alternatives"`
}

// Alternative is a candidate the router considered but did not choose.
type Alternative struct {
	ID               string   `json:"id"`
	EstimatedCostUSD *float64 `json:"estimated_cost_usd"`
}

// RouteFailure says why a route call gave no decision.
type RouteFailure int

const (
	// RouteUnavailable: timeout, connection failure, 5xx, or an unreadable
	// answer; the router did not answer.
	RouteUnavailable RouteFailure = iota
	// RouteBudget: 402, the budget for the budget key is reached.
	RouteBudget
	// RouteNoCandidate: 422, no usable candidate.
	RouteNoCandidate
	// RouteRejected: another 4xx (the router does not understand the request).
	RouteRejected
)

// RouteError is a failed route call.
type RouteError struct {
	Kind   RouteFailure
	Status int
	Msg    string
}

func (e *RouteError) Error() string {
	switch e.Kind {
	case RouteBudget:
		return "router: project budget reached"
	case RouteNoCandidate:
		return "router: no usable candidate"
	}
	if e.Status != 0 {
		return fmt.Sprintf("router: route call: HTTP %d %s", e.Status, e.Msg)
	}
	return "router: route call: " + e.Msg
}

// Route asks the router who should do a task. It never retries, and ctx plus
// the route timeout bound it. A nil or detached router fails with
// RouteUnavailable.
func (r *Router) Route(ctx context.Context, req RouteRequest) (RouteDecision, error) {
	if r == nil || r.origin == "" {
		return RouteDecision{}, &RouteError{Kind: RouteUnavailable, Msg: "no router"}
	}
	body, err := json.Marshal(req)
	if err != nil {
		return RouteDecision{}, &RouteError{Kind: RouteUnavailable, Msg: err.Error()}
	}
	timeout := r.routeTimeout
	if timeout <= 0 {
		timeout = DefaultRouteTimeout
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	hreq, err := http.NewRequestWithContext(ctx, http.MethodPost, r.origin+"/autoroute/v1/route", bytes.NewReader(body))
	if err != nil {
		return RouteDecision{}, &RouteError{Kind: RouteUnavailable, Msg: err.Error()}
	}
	hreq.Header.Set("Content-Type", "application/json")
	hreq.Header.Set(HeaderBudgetKey, req.BudgetKey)
	if r.octoKey != "" {
		hreq.Header.Set("x-octo-key", r.octoKey)
	}
	if r.apiKey != "" {
		// The router uses this token for its classifier call.
		hreq.Header.Set("x-api-key", r.apiKey)
	}
	resp, err := r.http.Do(hreq)
	if err != nil {
		msg := "connection failed"
		if errors.Is(err, context.DeadlineExceeded) {
			msg = fmt.Sprintf("no answer within %s", timeout)
		}
		return RouteDecision{}, &RouteError{Kind: RouteUnavailable, Msg: msg}
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return RouteDecision{}, &RouteError{Kind: RouteUnavailable, Status: resp.StatusCode, Msg: "unreadable answer"}
	}
	switch {
	case resp.StatusCode == http.StatusOK:
	case resp.StatusCode == http.StatusPaymentRequired:
		return RouteDecision{}, &RouteError{Kind: RouteBudget, Status: resp.StatusCode, Msg: errorMessage(raw)}
	case resp.StatusCode == http.StatusUnprocessableEntity:
		return RouteDecision{}, &RouteError{Kind: RouteNoCandidate, Status: resp.StatusCode, Msg: errorMessage(raw)}
	case resp.StatusCode >= 500:
		return RouteDecision{}, &RouteError{Kind: RouteUnavailable, Status: resp.StatusCode, Msg: errorMessage(raw)}
	default:
		return RouteDecision{}, &RouteError{Kind: RouteRejected, Status: resp.StatusCode, Msg: errorMessage(raw)}
	}
	var d RouteDecision
	if err := json.Unmarshal(raw, &d); err != nil || strings.TrimSpace(d.Choice) == "" {
		return RouteDecision{}, &RouteError{Kind: RouteUnavailable, Status: resp.StatusCode, Msg: "unreadable answer"}
	}
	return d, nil
}

// errorMessage reads the message of an Anthropic-shaped error body, or the
// clipped body text.
func errorMessage(raw []byte) string {
	var e struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if json.Unmarshal(raw, &e) == nil && e.Error.Message != "" {
		return clip(e.Error.Message)
	}
	return clip(strings.TrimSpace(string(raw)))
}

func clip(s string) string {
	if r := []rune(s); len(r) > 200 {
		return string(r[:200])
	}
	return s
}
