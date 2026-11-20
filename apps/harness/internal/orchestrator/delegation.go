package orchestrator

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/ndolinschi/Octo/apps/harness/internal/features"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
	"github.com/ndolinschi/Octo/apps/harness/internal/router"
)

// Delegation outcomes: what the harness tells the router about a sub-agent the
// router chose (tier auto), so the router's delegation record gets a label.
// Everything here is best effort: a router that is down, old or slow changes
// nothing about the sub-agent's work (router.SendOutcome never blocks).

// couldNotMarker is how a sub-agent says it could not do its task: its final
// report starts with it (the sub-agent prompt asks for exactly this).
const couldNotMarker = "could not do it"

// couldNot reports whether a final report starts with the could-not marker,
// ignoring case, leading space and Markdown emphasis.
func couldNot(report string) bool {
	s := strings.TrimLeftFunc(report, func(r rune) bool { return unicode.IsSpace(r) || r == '*' || r == '_' || r == '#' || r == '>' })
	return strings.HasPrefix(strings.ToLower(s), couldNotMarker)
}

// spawnRun is how one started (or refused) sub-agent ended.
type spawnRun struct {
	// out, isErr and err are spawn_agent's tool result.
	out   string
	isErr bool
	err   error
	// child is the sub-agent row (empty ID when none was created).
	child projectstore.Agent
	tier  projectstore.Tier
	// status, signal and errKind are the outcome report's (router.Status*, router.Signal*).
	status, signal, errKind string
	started                 time.Time
	finished                time.Time
}

// failed is why a run counts as a failure for escalation ("" when it does not):
// an agent error, a timeout or too many steps, a failure other than the budget,
// or the sub-agent's own could-not. A stopped run never counts.
func (r spawnRun) failed() string {
	switch {
	case r.status == router.StatusAgentError, r.status == router.StatusTimedOut:
		return r.status
	case r.status == router.StatusFailed && r.errKind != "budget":
		return r.status
	case r.status == router.StatusCompleted && r.signal == router.SignalCouldNot:
		return "could_not"
	}
	return ""
}

// delegated is what the harness remembers of a delegation under one parent, to
// recognise a re-delegation of the same work.
type delegated struct {
	requestID   string
	title, task string
	ended       bool
	failed      bool
}

// delegationLog holds the recent delegations per parent agent (process memory
// only: a restart forgets them, so a re-delegation across a restart is missed).
type delegationLog struct {
	mu       sync.Mutex
	byParent map[string][]*delegated
}

const delegationLogPerParent = 32

func (l *delegationLog) add(parentID string, d *delegated) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.byParent == nil {
		l.byParent = map[string][]*delegated{}
	}
	list := append(l.byParent[parentID], d)
	if len(list) > delegationLogPerParent {
		list = list[len(list)-delegationLogPerParent:]
	}
	l.byParent[parentID] = list
}

func (l *delegationLog) finish(d *delegated, failed bool) {
	l.mu.Lock()
	d.ended, d.failed = true, failed
	l.mu.Unlock()
}

// similar returns the newest ended delegation under parentID whose task looks
// like this one, or nil.
func (l *delegationLog) similar(parentID, title, task string) *delegated {
	l.mu.Lock()
	defer l.mu.Unlock()
	list := l.byParent[parentID]
	for i := len(list) - 1; i >= 0; i-- {
		d := list[i]
		if d.ended && sameWork(d.title, d.task, title, task) {
			return d
		}
	}
	return nil
}

// sameWork is the re-delegation match: the same title (case and spacing
// ignored), or briefs whose word sets overlap by at least 60% (Jaccard, at least
// three distinct words each). A heuristic: a reworded retry is missed, a
// follow-up that repeats the brief is a false match.
func sameWork(aTitle, aTask, bTitle, bTask string) bool {
	norm := func(s string) string { return strings.Join(strings.Fields(strings.ToLower(s)), " ") }
	if t := norm(aTitle); t != "" && t == norm(bTitle) {
		return true
	}
	a, b := wordSet(aTask), wordSet(bTask)
	if len(a) < 3 || len(b) < 3 {
		return false
	}
	shared := 0
	for w := range a {
		if b[w] {
			shared++
		}
	}
	return float64(shared)/float64(len(a)+len(b)-shared) >= 0.6
}

func wordSet(s string) map[string]bool {
	out := map[string]bool{}
	for _, w := range strings.FieldsFunc(strings.ToLower(s), func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) }) {
		out[w] = true
	}
	return out
}

// routerOutcomes reports whether the router takes outcome reports.
func (rt *runtime) routerOutcomes() bool { return rt.o.opts.Router.Has(router.CapRouteOutcome) }

// noteRedelegation tells the router that an earlier, ended delegation under the
// same parent is being done again (by: the new decision's request id, if any).
func (rt *runtime) noteRedelegation(parent projectstore.Agent, in spawnInput, newRequestID string) {
	if !rt.routerOutcomes() {
		return
	}
	d := rt.o.dlog.similar(parent.ID, in.Title, in.Task)
	if d == nil || d.requestID == "" || d.requestID == newRequestID {
		return
	}
	after := d.failed
	rt.o.opts.Router.SendOutcome(d.requestID, router.Outcome{
		ReportID: "redelegated:" + orDash(newRequestID) + ":" + d.requestID, Event: router.EventRedelegated,
		By: newRequestID, AfterFailure: &after,
	})
}

func orDash(s string) string {
	if s == "" {
		return "-"
	}
	return s
}

// finishedOutcome is the "finished" report of a run: status, the sub-agent's own
// signal, what it used (from the usage rows and its messages) and how long it ran.
func (rt *runtime) finishedOutcome(ctx context.Context, run spawnRun) router.Outcome {
	o := router.Outcome{
		ReportID: run.child.ID + ":finished", Event: router.EventFinished, Status: run.status,
		AgentSignal: run.signal, ErrorKind: run.errKind,
	}
	if run.child.ID == "" {
		o.ReportID = "refused:" + run.started.UTC().Format(time.RFC3339Nano)
		return o
	}
	if run.child.Model != "" && !strings.HasPrefix(run.child.Model, "acp:") {
		// The built-in loop's requests carry the agent id as the router session
		// (metadata.user_id): the router reads its test summary under it.
		o.SessionID = run.child.ID
	}
	ms := run.finished.Sub(run.started).Milliseconds()
	o.DurationMS = &ms
	c, done := dbCtx(context.WithoutCancel(ctx))
	defer done()
	u := router.OutcomeUsage{}
	if t, err := rt.db.AgentUsageTotals(c, run.child.ID); err == nil {
		u.InputTokens, u.OutputTokens, u.CacheReadTokens, u.CacheWriteTokens = t.InputTokens, t.OutputTokens, t.CacheReadTokens, t.CacheWriteTokens
		u.CostUSD, u.CostEstimated, u.FlatRate = t.CostUSD, t.CostEstimated, t.FlatRate
	}
	if msgs, err := rt.db.Messages(c, run.child.ID); err == nil {
		for _, m := range msgs {
			if m.Role == "assistant" {
				u.Turns++
			}
			for _, b := range m.Content {
				switch b.Type {
				case "tool_use":
					u.ToolCalls++
				case "tool_result":
					if b.IsError != nil && *b.IsError {
						u.FailedToolCalls++
					}
				}
			}
		}
	}
	o.Usage = &u
	return o
}

// reportFinished sends the run's "finished" report. With wait it waits (a few
// seconds at most) for the router's answer, whose label can say the tests in the
// sub-agent failed; otherwise it is sent in the background.
func (rt *runtime) reportFinished(ctx context.Context, requestID string, run spawnRun, wait bool) router.OutcomeAck {
	if !rt.routerOutcomes() || requestID == "" {
		return router.OutcomeAck{}
	}
	o := rt.finishedOutcome(ctx, run)
	if !wait {
		rt.o.opts.Router.SendOutcome(requestID, o)
		return router.OutcomeAck{}
	}
	c, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	ack, err := rt.o.opts.Router.ReportOutcome(c, requestID, o)
	if err != nil {
		slog.Debug("delegation outcome not delivered", "request", requestID, "err", err)
	}
	return ack
}

// escalationEnabled is the policy delegation.escalate_on_failure: "once" when the
// feature is on, "off" otherwise.
func (rt *runtime) escalationEnabled() bool {
	return rt.featureEnabled(features.EscalateOnFailure)
}

// nextTier is the tier above t ("" above deep).
func nextTier(t projectstore.Tier) projectstore.Tier {
	switch t {
	case projectstore.TierFast:
		return projectstore.TierBalanced
	case projectstore.TierBalanced:
		return projectstore.TierDeep
	}
	return ""
}

// escalationWhy is the text of an escalation reason, for the sub-agent row.
func escalationWhy(reason string) string {
	switch reason {
	case router.StatusAgentError:
		return "an agent error"
	case router.StatusTimedOut:
		return "a timeout"
	case router.StatusFailed:
		return "a failure"
	case "could_not":
		return "it reported it could not do the task"
	case "tests_failed":
		return "its last test run failed"
	}
	return reason
}

// escalate retries a failed routed delegation once on a stronger candidate: a
// fresh sub-agent with the same brief, chosen by the router with the failed
// candidate excluded and the next tier as the floor. ok is false when it did not
// run (policy off, budget reached, nothing stronger, no router decision).
func (rt *runtime) escalate(ctx context.Context, parent projectstore.Agent, in spawnInput, first *projectstore.RouteInfo, run spawnRun, reason string) (spawnRun, bool) {
	floor := nextTier(run.tier)
	if floor == "" || ctx.Err() != nil {
		return spawnRun{}, false
	}
	if be := rt.budgetReached(ctx); be != nil {
		return spawnRun{}, false
	}
	plan := rt.resolveAutoWith(ctx, parent, in, &autoRetry{
		from: first.RequestID, exclude: []string{first.Choice}, minTier: string(floor),
	})
	if !plan.decided || plan.budget != nil {
		slog.Info("delegation not escalated: the router gave no stronger choice", "request", first.RequestID, "reason", plan.info.Reason)
		return spawnRun{}, false
	}
	rt.o.opts.Router.SendOutcome(first.RequestID, router.Outcome{
		ReportID: "escalated:" + plan.info.RequestID, Event: router.EventEscalated, By: plan.info.RequestID, Reason: reason,
	})
	retry := in
	retry.Tier, retry.Agent, retry.Model = string(plan.tier), "", ""
	if plan.agent != "" {
		retry.Agent, retry.Model = plan.agent, plan.model
		if retry.Model == "" {
			retry.Model = rt.roleModel(plan.agent, retry.Tier)
		}
	}
	model, ext, msg := rt.spawnTarget(retry)
	if msg != "" {
		slog.Info("delegation not escalated: the stronger choice cannot start", "choice", plan.info.Choice, "err", msg)
		return spawnRun{}, false
	}
	// An API tier's model is the router's to serve (the row's served_model shows
	// it once the sub-agent ran); an agent is named by its candidate id.
	on := plan.info.Choice
	if plan.agent == "" {
		on = "the " + string(plan.tier) + " tier"
	}
	info := plan.info
	info.Reason = strings.TrimSpace(fmt.Sprintf("Retried on %s after %s. %s", on, escalationWhy(reason), info.Reason))
	if plan.info.RequestID != "" {
		done := make(chan struct{})
		defer func() { <-done }()
		go func() {
			defer close(done)
			rt.recordRouteCost(ctx, parent.ID, plan.info.RequestID)
		}()
	}
	second := rt.runSpawned(ctx, parent, retry, plan.tier, model, ext, &info, nil)
	rt.reportFinished(ctx, plan.info.RequestID, second, false)
	entry := &delegated{requestID: plan.info.RequestID, title: in.Title, task: in.Task}
	rt.o.dlog.add(parent.ID, entry)
	rt.o.dlog.finish(entry, second.failed() != "")
	prefix := fmt.Sprintf("[The first attempt (%s) ended with %s; the task was retried once on %s.]\n\n", first.Choice, escalationWhy(reason), on)
	second.out = prefix + second.out
	return second, true
}

// delegationsRewound reports a rewind to every routed delegation it hides.
func (o *Orchestrator) delegationsRewound(ids []string, messageID int64) {
	for _, id := range ids {
		o.opts.Router.SendOutcome(id, router.Outcome{
			ReportID: fmt.Sprintf("rewound:%d", messageID), Event: router.EventRewound,
		})
	}
}
