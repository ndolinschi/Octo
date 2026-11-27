package orchestrator

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/anthropics/anthropic-sdk-go/v2"

	"github.com/ndolinschi/Octo/apps/harness/internal/agent"
	"github.com/ndolinschi/Octo/apps/harness/internal/events"
	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
	"github.com/ndolinschi/Octo/apps/harness/internal/router"
	"github.com/ndolinschi/Octo/apps/harness/internal/tools"
	"github.com/ndolinschi/Octo/apps/harness/internal/usererr"
)

const ToolSpawnAgent = "spawn_agent"

const spawnDescription = "Delegate a task to a new sub-agent with a fresh context. It runs to completion and " +
	"its final report is returned as this tool's result. Calls made in the same message run in parallel."

// spawnDescriptionFor names the required arguments in the description too.
func spawnDescriptionFor(routed bool) string {
	if routed {
		return spawnDescription + " Requires role, title and task; tier is optional (auto by default)."
	}
	return spawnDescription + " Requires role, title, task and tier."
}

type spawnInput struct {
	Role  string `json:"role"`
	Title string `json:"title"`
	Task  string `json:"task"`
	Tier  string `json:"tier"`
	Agent string `json:"agent"`
	// Prompt and Description are accepted for task and title when those are
	// empty: the names an agent guesses when it calls the tool before loading
	// its schema (Claude Code's own Task tool takes description and prompt).
	Prompt      string `json:"prompt"`
	Description string `json:"description"`
	Model       string `json:"model"`
	// Env maps environment variable names to secret references for an
	// external agent's process.
	Env map[string]string `json:"env"`
}

func (rt *runtime) spawnDef(parent projectstore.Agent) (tools.Def, error) {
	schema, err := spawnSchemaFor(rt.offeredAgents(), rt.routeEnabled())
	if err != nil {
		return tools.Def{}, fmt.Errorf("spawn_agent schema: %w", err)
	}
	return tools.Def{
		Name:        ToolSpawnAgent,
		Description: spawnDescriptionFor(rt.routeEnabled()),
		InputSchema: schema,
		Handle: func(ctx context.Context, input json.RawMessage) (string, bool, error) {
			return rt.spawn(ctx, parent, input)
		},
	}, nil
}

// spawn creates a child agent, runs it to completion and returns its report.
// A failed or cancelled child is an error result, never a failed parent.
func (rt *runtime) spawn(ctx context.Context, parent projectstore.Agent, input json.RawMessage) (string, bool, error) {
	var in spawnInput
	if err := json.Unmarshal(input, &in); err != nil {
		return "invalid spawn_agent input: " + err.Error(), true, nil
	}
	in.Role, in.Title, in.Task = strings.TrimSpace(in.Role), strings.TrimSpace(in.Title), strings.TrimSpace(in.Task)
	if in.Task == "" {
		in.Task = strings.TrimSpace(in.Prompt)
	}
	if in.Title == "" {
		in.Title = strings.TrimSpace(in.Description)
	}
	routed := rt.routeEnabled()
	if in.Tier == "" && routed {
		in.Tier = TierAuto // the default while the router can choose
	}
	auto := in.Tier == TierAuto
	if auto && in.Agent != "" {
		// An agent named by the caller is an explicit choice: nothing to route.
		in.Tier, auto = string(projectstore.TierBalanced), false
	}
	tier := projectstore.Tier(in.Tier)
	if in.Role == "" || in.Title == "" || in.Task == "" || !(auto || tier.Valid()) {
		return spawnRefusal(in, routed), true, nil
	}
	// A delegation refused for budget reasons before the sub-agent starts still
	// gets its row, settled as failed with the reason, so the delegation does not
	// sit "starting" forever. (Malformed calls and unknown agents are plain tool
	// errors: nothing was going to start.)
	refuse := func(p *usererr.Error) (string, bool, error) {
		rt.refuseChild(ctx, parent, in, tier, p)
		return p.Message + " " + p.Hint, true, nil
	}
	if be := rt.budgetReached(ctx); be != nil {
		return refuse(describe(be))
	}
	var route *projectstore.RouteInfo
	var budgetErr error
	if auto {
		plan := rt.resolveAuto(ctx, parent, in)
		tier, in.Tier, route, budgetErr = plan.tier, string(plan.tier), &plan.info, plan.budget
		if plan.agent != "" {
			in.Agent, in.Model = plan.agent, plan.model
			if in.Model == "" {
				// The router decided a difficulty band: the agent's model for that role.
				in.Model = rt.roleModel(plan.agent, in.Tier)
			}
		}
		if plan.info.RequestID != "" {
			// The classifier's cost is fetched while the sub-agent runs.
			done := make(chan struct{})
			defer func() { <-done }()
			go func() {
				defer close(done)
				rt.recordRouteCost(ctx, parent.ID, plan.info.RequestID)
			}()
		}
	}
	requestID := ""
	if route != nil {
		requestID = route.RequestID
	}
	// The same work delegated again under this parent: the earlier delegation's
	// result was not enough (a "not solved" signal for its record).
	rt.noteRedelegation(parent, in, requestID)
	if in.Agent == "" && strings.TrimSpace(in.Model) != "" {
		return "spawn_agent: model only applies together with agent; built-in sub-agents use tier", true, nil
	}
	model, ext, msg := rt.spawnTarget(in)
	if msg != "" {
		return msg, true, nil
	}
	run := rt.runSpawned(ctx, parent, in, tier, model, ext, route, budgetErr)
	if requestID == "" {
		rt.o.dlog.add(parent.ID, &delegated{title: in.Title, task: in.Task, ended: true, failed: run.failed() != ""})
		return run.out, run.isErr, run.err
	}
	entry := &delegated{requestID: requestID, title: in.Title, task: in.Task}
	rt.o.dlog.add(parent.ID, entry)
	escalate := rt.escalationEnabled() && rt.routerOutcomes()
	why := run.failed()
	// When a retry is possible, wait for the router's label: it knows whether
	// the tests in the sub-agent failed at the end.
	ack := rt.reportFinished(ctx, requestID, run, escalate && why == "" && run.status == router.StatusCompleted)
	if why == "" && ack.Rule == "tests_failed" {
		why = "tests_failed"
	}
	rt.o.dlog.finish(entry, why != "")
	if escalate && why != "" && route.Choice != "" {
		if second, ok := rt.escalate(ctx, parent, in, route, run, why); ok {
			return second.out, second.isErr, second.err
		}
	}
	return run.out, run.isErr, run.err
}

// spawnTarget resolves who runs a sub-agent: the model recorded on its row and,
// for an ACP agent, the target to start. msg is a tool error when it cannot start.
func (rt *runtime) spawnTarget(in spawnInput) (model string, ext *acpTarget, msg string) {
	model = rt.models.ForTier(in.Tier)
	if in.Agent != "" {
		target, msg := rt.pickOfferedAgent(in.Agent, strings.TrimSpace(in.Model))
		if msg != "" {
			return "", nil, msg
		}
		ext, model = &target, target.recorded()
	} else if plugins.IsACPRef(model) {
		// The tier is mapped to an ACP agent (models.<tier> = acp:<id>[/<model>]).
		id, m, _ := plugins.ParseACPRef(model)
		if m == "" {
			// No model named on the tier: the agent's model for this role, else its
			// preferred one (pickACPAgent). An explicit acp:<id>/<model> always wins.
			m = rt.roleModel(id, in.Tier)
		}
		target, msg := rt.pickACPAgent(id, m)
		if msg != "" {
			return "", nil, fmt.Sprintf("tier %q is mapped to %q: %s", in.Tier, model, msg)
		}
		ext, model = &target, target.recorded()
	} else if model == "" && rt.isACPOrchestrator() {
		// Single-provider fallback when a tier slot is unset while the session runs on an ACP agent.
		if id, _, ok := plugins.ParseACPRef(rt.models.Orchestrator); ok {
			m := rt.roleModel(id, in.Tier)
			target, msg := rt.pickACPAgent(id, m)
			if msg != "" {
				return "", nil, fmt.Sprintf("tier %q on session agent %q: %s", in.Tier, rt.models.Orchestrator, msg)
			}
			ext, model = &target, target.recorded()
		}
	}
	if len(in.Env) > 0 {
		if ext == nil {
			return "", nil, "spawn_agent: env only applies together with agent; a built-in sub-agent passes env on its own bash calls"
		}
		env, err := rt.o.secrets.Resolve(rt.pid(), in.Env)
		if err != nil {
			return "", nil, "spawn_agent: " + err.Error()
		}
		ext.env = env
	}
	return model, ext, ""
}

// runSpawned creates the sub-agent row, runs it to completion, settles it and
// returns spawn_agent's tool result with how the run ended.
func (rt *runtime) runSpawned(ctx context.Context, parent projectstore.Agent, in spawnInput, tier projectstore.Tier,
	model string, ext *acpTarget, route *projectstore.RouteInfo, budgetErr error) (run spawnRun) {
	run.tier, run.started = tier, time.Now()
	defer func() { run.finished = time.Now() }()
	toolUseID := tools.ToolUseID(ctx)
	c, cancel := dbCtx(ctx)
	child, err := rt.db.CreateAgent(c, projectstore.NewAgent{
		ParentID: &parent.ID, Depth: parent.Depth + 1, Role: in.Role, Title: in.Title, Task: in.Task,
		Model: model, Tier: &tier, Status: projectstore.StatusRunning,
		SpawnToolUseID: &toolUseID, Started: true, Route: route,
	})
	cancel()
	if err != nil {
		run.err, run.status, run.errKind = fmt.Errorf("create agent: %w", err), router.StatusFailed, "harness"
		return run
	}
	run.child = child
	rt.publishAgent(events.AgentCreated, child)
	rt.registerAgentSession(ctx, child)
	if budgetErr != nil {
		// The router's 402: the same failure as a budget stop mid-run.
		rt.settleProblem(ctx, child.ID, describe(budgetErr))
		run.err, run.status, run.errKind = budgetErr, router.StatusFailed, "budget"
		return run
	}

	task := anthropic.NewUserMessage(anthropic.NewTextBlock(in.Task))
	sink := &agentSink{rt: rt, agentID: child.ID}
	if err := sink.Message(ctx, "user", task); err != nil {
		rt.settleProblem(ctx, child.ID, describe(err))
		run.out, run.isErr, run.status, run.errKind = rt.redact("sub-agent failed: "+modelText(describe(err))), true, router.StatusAgentError, "harness"
		return run
	}
	childCtx, stopChild := context.WithCancel(ctx)
	endRun := rt.o.registerRun(child.ID, stopChild, ext == nil, false)
	text, err := rt.runChild(childCtx, child, task, ext)
	late := endRun()
	stoppedByUser := childCtx.Err() != nil && ctx.Err() == nil
	stopChild()
	if len(late) > 0 && !stoppedByUser && err == nil {
		// Messages sent to the sub-agent after its last tool boundary: it continues with them once settled.
		defer func() {
			if cerr := rt.o.continueAgentByID(rt.pid(), child.ID, strings.Join(late, "\n\n"), false); cerr != nil {
				rt.logErr("continue sub-agent with late messages", cerr)
			}
		}()
	}
	switch {
	case stoppedByUser:
		rt.settle(ctx, child.ID, projectstore.StatusCancelled, "", "")
		run.out, run.isErr, run.status = "sub-agent stopped by the user", true, router.StatusStopped
	case err == nil:
		rt.settle(ctx, child.ID, projectstore.StatusCompleted, text, "")
		run.status, run.signal = router.StatusCompleted, router.SignalDone
		switch {
		case strings.TrimSpace(text) == "":
			run.out, run.signal = "(sub-agent returned no report)", router.SignalNone
		case couldNot(text):
			run.out, run.signal = rt.o.opts.Limits.CapReport(rt.redact(text)), router.SignalCouldNot
		default:
			run.out = rt.o.opts.Limits.CapReport(rt.redact(text))
		}
	case router.IsBudget(err):
		// Not a recoverable tool error: stop the whole turn, no more upstream calls.
		rt.settleProblem(ctx, child.ID, describe(err))
		run.err, run.status, run.errKind = err, router.StatusFailed, "budget"
	case ctx.Err() != nil || errors.Is(err, errAgentCancelled):
		rt.settle(ctx, child.ID, projectstore.StatusCancelled, "", "")
		run.out, run.isErr, run.status = "sub-agent cancelled", true, router.StatusStopped
	default:
		u := describe(err)
		rt.settleProblem(ctx, child.ID, u)
		run.out, run.isErr, run.status, run.errKind = rt.redact("sub-agent failed: "+modelText(u)), true, router.StatusAgentError, u.Code
		if errors.Is(err, agent.ErrMaxTurns) || errors.Is(err, context.DeadlineExceeded) {
			run.status = router.StatusTimedOut
		}
	}
	return run
}

// runChild runs the child through the built-in loop, or through ext when set.
func (rt *runtime) runChild(ctx context.Context, child projectstore.Agent, task anthropic.MessageParam, ext *acpTarget) (string, error) {
	if ext != nil {
		text, err := rt.runACP(ctx, child, *ext)
		rt.o.noteLogin(ext.agent.ID, err)
		return text, err
	}
	res, err := rt.runAgent(ctx, child, []anthropic.MessageParam{task})
	return res.Text, err
}

// refuseChild records a delegation that was refused before it started: the
// sub-agent row is created and settled as failed with the reason, both
// announced, and linked to the spawn_agent call.
func (rt *runtime) refuseChild(ctx context.Context, parent projectstore.Agent, in spawnInput, tier projectstore.Tier, p *usererr.Error) {
	if !tier.Valid() {
		tier = projectstore.TierBalanced
	}
	toolUseID := tools.ToolUseID(ctx)
	c, cancel := dbCtx(ctx)
	child, err := rt.db.CreateAgent(c, projectstore.NewAgent{
		ParentID: &parent.ID, Depth: parent.Depth + 1, Role: in.Role, Title: in.Title, Task: in.Task,
		Model: rt.models.ForTier(string(tier)), Tier: &tier, Status: projectstore.StatusRunning,
		SpawnToolUseID: &toolUseID, Started: true,
	})
	cancel()
	if err != nil {
		rt.logErr("record refused sub-agent", err)
		return
	}
	rt.publishAgent(events.AgentCreated, child)
	rt.registerAgentSession(ctx, child)
	rt.settleHint(ctx, child.ID, projectstore.StatusFailed, "", p.Message, p.Hint)
}
