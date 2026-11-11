package fakerouter

import (
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"time"
)

// RouteScript scripts POST /autoroute/v1/route. A Route in Options turns the
// endpoint on and adds the route_api capability.
type RouteScript struct {
	// Choice is the candidate id answered; empty picks the first logged-in
	// flat-rate agent, else the first candidate (the real policy is richer).
	Choice string
	// Model, Band and Reason fill the answer; Band defaults to "medium" and
	// Reason to "fake router".
	Model, Band, Reason string
	// Delay is waited before answering (to exercise the caller's timeout).
	Delay time.Duration
	// Status, when not 200, answers with an Anthropic-shaped error of that status.
	Status int
	// CostUSD is the classifier cost on the call record (zero: a zero-cost record).
	CostUSD float64
	// NoRequestID leaves request_id out of the answer.
	NoRequestID bool
}

// RouteSeen is one route request the fake received.
type RouteSeen struct {
	Header http.Header
	Body   []byte
}

// SetRoute replaces the script (and turns the endpoint on).
func (r *Router) SetRoute(s RouteScript) {
	r.mu.Lock()
	r.route = &s
	r.mu.Unlock()
}

// RouteRequests returns the route requests seen so far, oldest first.
func (r *Router) RouteRequests() []RouteSeen {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]RouteSeen(nil), r.routeSeen...)
}

type routeCandidate struct {
	ID       string `json:"id"`
	Kind     string `json:"kind"`
	FlatRate bool   `json:"flat_rate"`
	LoggedIn bool   `json:"logged_in"`
	Tier     string `json:"tier"`
}

func (r *Router) routeEndpoint(w http.ResponseWriter, req *http.Request) {
	raw, _ := io.ReadAll(req.Body)
	r.mu.Lock()
	s := r.route
	r.routeSeen = append(r.routeSeen, RouteSeen{Header: req.Header.Clone(), Body: raw})
	r.mu.Unlock()
	if s == nil {
		http.NotFound(w, req)
		return
	}
	if s.Delay > 0 {
		select {
		case <-time.After(s.Delay):
		case <-req.Context().Done():
			return
		}
	}
	if s.Status != 0 && s.Status != http.StatusOK {
		writeJSON(w, s.Status, map[string]any{"type": "error", "error": map[string]string{
			"type": "route_error", "message": "scripted route status " + strconv.Itoa(s.Status)}})
		return
	}
	var body struct {
		BudgetKey  string           `json:"budget_key"`
		Candidates []routeCandidate `json:"candidates"`
	}
	if json.Unmarshal(raw, &body) != nil || len(body.Candidates) == 0 {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"type": "error", "error": map[string]string{
			"type": "no_candidate", "message": "no usable candidate"}})
		return
	}
	choice := s.Choice
	if choice == "" {
		choice = body.Candidates[0].ID
		for _, c := range body.Candidates {
			if c.Kind == "agent" && c.FlatRate && c.LoggedIn {
				choice = c.ID
				break
			}
		}
	}
	out := map[string]any{
		"choice": choice, "band": orDefault(s.Band, "medium"), "reason": orDefault(s.Reason, "fake router"),
		"estimated_cost_usd": nil, "alternatives": []any{},
	}
	kind, tier := "agent", ""
	for _, c := range body.Candidates {
		if c.ID == choice {
			kind, tier = c.Kind, c.Tier
		}
	}
	model := choice // the call record's model: the ladder slug, or the agent id
	if kind == "api" {
		model = Ladder[map[string]string{"fast": "low", "balanced": "mid", "deep": "high"}[tier]]
		out["model"] = model // present for an API choice only, as in the real router
	} else if s.Model != "" {
		out["model"] = s.Model // not real behaviour; lets tests exercise an agent model
	}
	if !s.NoRequestID {
		out["request_id"] = r.routeRecord(body.BudgetKey, s.CostUSD, model, kind, choice, out["band"].(string), out["reason"].(string))
	}
	writeJSON(w, http.StatusOK, out)
}

// routeRecord stores the call record of a route call's classifier and returns its id.
func (r *Router) routeRecord(key string, cost float64, model, kind, choice, band, reason string) string {
	r.mu.Lock()
	defer r.mu.Unlock()
	id := "octo_" + strconv.FormatInt(r.seq.Add(1), 16)
	r.spent[key] += cost
	r.records[id] = &record{complete: true, body: map[string]any{
		"model": model, "tier": map[bool]string{true: "agent", false: "low"}[kind == "agent"], "trigger": "route",
		"input_tokens": 120, "output_tokens": 8, "cache_read_tokens": 0, "cache_write_tokens": 0,
		"cost_usd": cost, "cost_source": r.opts.CostSource,
		"route": map[string]any{"choice": choice, "band": band, "reason": reason, "classifier": "used", "depth": 1, "budget_key": key},
	}}
	return id
}

func orDefault(s, d string) string {
	if s == "" {
		return d
	}
	return s
}
