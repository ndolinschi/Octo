package orchestrator

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"strings"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
	"github.com/ndolinschi/Octo/apps/harness/internal/router"
)

// TierAuto is the spawn_agent tier that leaves the choice of who does the task
// to the router.
const TierAuto = "auto"

const (
	// routeBriefRunes caps the brief sent with a route call.
	routeBriefRunes = 4000
	// routeRecordTimeout bounds the fetch of the route call's cost record.
	routeRecordTimeout = 3 * time.Second
)

// Route reasons the harness itself writes (the router's own reason is stored
// verbatim on success).
const (
	reasonNoRouter = "no router"
)

// routeEnabled reports whether the router advertises the route API, which also
// makes "auto" the default tier of spawn_agent.
func (rt *runtime) routeEnabled() bool { return rt.o.opts.Router.Has(router.CapRouteAPI) }

// tierGuidance is the orchestrator prompt's sentence on choosing a tier.
func (rt *runtime) tierGuidance() string {
	const byDifficulty = "Choose the tier by difficulty: fast for lookups and simple edits, balanced for normal engineering, deep for hard design or debugging."
	if !rt.routeEnabled() {
		return byDifficulty
	}
	return "Leave the tier to auto (the router decides who does the task) unless you have a reason to choose one. " +
		"Otherwise choose by difficulty: fast for lookups and simple edits, balanced for normal engineering, deep for hard design or debugging."
}

// autoCand is a candidate with what it takes to start it.
type autoCand struct {
	c    router.Candidate
	tier projectstore.Tier // API candidate
	// agent and model start an ACP candidate (model "" is the agent's default).
	agent, model string
}

// autoPlan is the outcome of resolving tier "auto": who starts and what the
// agent row records.
type autoPlan struct {
	tier         projectstore.Tier
	agent, model string // an ACP agent starts when agent != ""
	info         projectstore.RouteInfo
	// budget is set when the router said the budget is reached.
	budget error
}

func (rt *runtime) apiCandidates() []autoCand {
	if rt.o.builtinOff() != "" {
		return nil
	}
	var out []autoCand
	for _, t := range []projectstore.Tier{projectstore.TierFast, projectstore.TierBalanced, projectstore.TierDeep} {
		if c, ok := rt.apiCandidate(string(t)); ok {
			out = append(out, c)
		}
	}
	return out
}

// apiCandidate is a tier candidate; a tier mapped to an ACP agent is not an API
// tier (the agent is its own candidate).
func (rt *runtime) apiCandidate(tier string) (autoCand, bool) {
	if rt.o.builtinOff() != "" || plugins.IsACPRef(rt.models.ForTier(tier)) {
		return autoCand{}, false
	}
	return autoCand{c: router.Candidate{ID: tier, Kind: "api", Tier: tier}, tier: projectstore.Tier(tier)}, true
}

// agentCandidate offers an available ACP agent. Its login state comes from the
// probe; an agent with a probe whose result is not in yet is left out, and one
// without a probe counts as logged in (as for the default orchestrator).
func (rt *runtime) agentCandidate(a plugins.Agent, model string) (autoCand, bool) {
	if !a.Available || len(rt.folders) == 0 || (a.ProbeCommand != "" && a.LoggedIn == nil) {
		return autoCand{}, false
	}
	id, label := plugins.ACPPrefix+a.ID, a.Label
	if model != "" {
		id += "/" + model
		label += " (" + model + ")"
	}
	flat, in := a.FlatRate, loggedIn(a)
	return autoCand{
		c: router.Candidate{
			ID: id, Kind: "agent", Label: label, FlatRate: &flat, LoggedIn: &in, Strengths: slices.Clone(a.Strengths),
		},
		agent: a.ID, model: model,
	}, true
}

// autoCandidates is the set offered to the router: models.auto_candidates in
// its order when set, else the API tiers and every ready ACP agent.
func (rt *runtime) autoCandidates() []autoCand {
	agents := rt.o.agents()
	var out []autoCand
	add := func(c autoCand, ok bool) {
		if ok && !slices.ContainsFunc(out, func(o autoCand) bool { return o.c.ID == c.c.ID }) {
			out = append(out, c)
		}
	}
	if list := rt.models.AutoCandidates; len(list) > 0 {
		for _, ref := range list {
			if !plugins.IsACPRef(ref) {
				add(rt.apiCandidate(ref))
				continue
			}
			id, model, ok := plugins.ParseACPRef(ref)
			if !ok || plugins.ValidateACPRef(ref, agents) != nil {
				continue
			}
			if i := slices.IndexFunc(agents, func(a plugins.Agent) bool { return a.ID == id }); i >= 0 {
				add(rt.agentCandidate(agents[i], model))
			}
		}
		return out
	}
	for _, c := range rt.apiCandidates() {
		add(c, true)
	}
	for _, a := range agents {
		add(rt.agentCandidate(a, ""))
	}
	return out
}

// childTools lists the tools a sub-agent spawned by parent will have.
func (rt *runtime) childTools(parent projectstore.Agent) []string {
	reg, err := rt.registry(projectstore.Agent{ParentID: &parent.ID, Depth: parent.Depth + 1})
	if err != nil {
		return []string{}
	}
	names := []string{}
	for _, d := range reg.All() {
		names = append(names, d.Name)
	}
	return names
}

// bandTier maps the router's difficulty band to the tier recorded for an
// agent it chose.
func bandTier(band string) projectstore.Tier {
	switch band {
	case "easy":
		return projectstore.TierFast
	case "hard":
		return projectstore.TierDeep
	}
	return projectstore.TierBalanced
}

// autoDefault is what "auto" resolves to when the router gives no usable
// choice: today's default, the balanced tier; with the built-in loop
// unavailable, the first ready ACP agent (as for the default orchestrator).
func (rt *runtime) autoDefault(reason string) autoPlan {
	p := autoPlan{tier: projectstore.TierBalanced, info: projectstore.RouteInfo{Reason: reason, Choice: string(projectstore.TierBalanced)}}
	if rt.o.builtinOff() == "" {
		return p
	}
	if a, ok := rt.o.readyAgent(); ok {
		if _, msg := rt.pickACPAgent(a.ID, ""); msg == "" {
			p.agent, p.info.Choice = a.ID, plugins.ACPPrefix+a.ID
		}
	}
	return p
}

// resolveAuto decides who runs a task whose tier is "auto". It never fails:
// without a usable router answer the plan is autoDefault with the reason.
func (rt *runtime) resolveAuto(ctx context.Context, parent projectstore.Agent, in spawnInput) autoPlan {
	if !rt.routeEnabled() {
		return rt.autoDefault(reasonNoRouter)
	}
	cands := rt.autoCandidates()
	if len(cands) == 0 {
		return rt.autoDefault("no candidates to offer the router")
	}
	req := router.RouteRequest{
		BudgetKey: rt.pid(),
		Task: router.RouteTask{
			Title: in.Title, Brief: clipRunes(in.Task, routeBriefRunes), Tools: rt.childTools(parent), Depth: parent.Depth + 1,
		},
	}
	for _, c := range cands {
		req.Candidates = append(req.Candidates, c.c)
	}
	d, err := rt.o.opts.Router.Route(ctx, req)
	if err != nil {
		return rt.routeFailed(err)
	}
	i := slices.IndexFunc(cands, func(c autoCand) bool { return c.c.ID == d.Choice })
	if i < 0 {
		p := rt.autoDefault(fmt.Sprintf("router chose %q, which is not a candidate", d.Choice))
		p.info.RequestID = d.RequestID
		return p
	}
	c := cands[i]
	p := autoPlan{info: projectstore.RouteInfo{
		Reason: strings.TrimSpace(d.Reason), Band: d.Band, RequestID: d.RequestID, Choice: c.c.ID,
	}}
	if c.agent == "" {
		// The model of an API tier is the router's to serve: the tier hint and
		// the project's tier policy carry the choice, as for any sub-agent.
		p.tier = c.tier
		return p
	}
	model := c.model
	if _, msg := rt.pickACPAgent(c.agent, model); msg != "" {
		fb := rt.autoDefault(fmt.Sprintf("router chose %q, which cannot be started: %s", c.c.ID, msg))
		fb.info.RequestID = d.RequestID
		return fb
	}
	if model == "" && d.Model != "" {
		// The router may name a model for the agent; ignored when the agent
		// does not accept it.
		if _, msg := rt.pickACPAgent(c.agent, d.Model); msg == "" {
			model = d.Model
		}
	}
	p.tier, p.agent, p.model = bandTier(d.Band), c.agent, model
	return p
}

// routeFailed maps a failed route call to the plan: a fallback, or the budget
// failure of a 402.
func (rt *runtime) routeFailed(err error) autoPlan {
	var re *router.RouteError
	if !errors.As(err, &re) {
		return rt.autoDefault("router did not answer: " + err.Error())
	}
	switch re.Kind {
	case router.RouteBudget:
		p := rt.autoDefault("router: project budget reached")
		p.budget = rt.budgetError()
		return p
	case router.RouteNoCandidate:
		return rt.autoDefault("router found no usable candidate")
	case router.RouteRejected:
		return rt.autoDefault("router did not accept the route request: " + re.Error())
	}
	return rt.autoDefault("router did not answer: " + strings.TrimPrefix(re.Error(), "router: route call: "))
}

// budgetError is the "Project budget reached" error from the last known spend
// and the project's budget (unknown amounts read as a bare message).
func (rt *runtime) budgetError() error {
	be := &router.BudgetError{Spent: -1, Budget: -1}
	if v, ok := rt.o.opts.Router.Spent(rt.pid()); ok {
		be.Spent = v
	}
	if rt.info.BudgetUSD != nil {
		be.Budget = *rt.info.BudgetUSD
	}
	return be
}

// recordRouteCost writes the usage row of the router's classifier call: role
// "route", attributed to the spawning agent. Records without a cost write
// nothing.
func (rt *runtime) recordRouteCost(ctx context.Context, agentID, requestID string) {
	fctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), routeRecordTimeout)
	defer cancel()
	rec, err := rt.o.opts.Router.FetchCall(fctx, requestID)
	if err != nil {
		slog.Warn("route call record unavailable; its cost is not recorded", "request", requestID, "err", err)
		return
	}
	if rec.CostUSD == nil || !(*rec.CostUSD > 0) {
		return
	}
	model := rec.Model
	if model == "" {
		model = "router"
	}
	c, done := dbCtx(ctx)
	defer done()
	_, err = rt.db.RecordUsage(c, projectstore.UsageRecord{
		AgentID: agentID, Role: projectstore.RoleRoute, Model: model, Source: projectstore.SourceAPI,
		InputTokens: rec.InputTokens, OutputTokens: rec.OutputTokens,
		CacheReadTokens: rec.CacheReadTokens, CacheWriteTokens: rec.CacheWriteTokens,
		CostUSD: rec.CostUSD, ServedModel: rec.Model, Tier: rec.Tier, RouteTrigger: rec.Trigger,
		RouterRequestID: requestID, CostEstimated: rec.CostSource == router.CostEstimated,
	})
	if err != nil {
		rt.logErr("record route usage", err)
	}
}

func clipRunes(s string, n int) string {
	if r := []rune(s); len(r) > n {
		return string(r[:n])
	}
	return s
}
