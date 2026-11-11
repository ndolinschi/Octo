package orchestrator

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/anthropics/anthropic-sdk-go/v2"

	"github.com/ndolinschi/Octo/apps/harness/internal/events"
	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
	"github.com/ndolinschi/Octo/apps/harness/internal/router"
	"github.com/ndolinschi/Octo/apps/harness/internal/tools"
)

const ToolSpawnAgent = "spawn_agent"

const spawnDescription = "Delegate a task to a new sub-agent with a fresh context. It runs to completion and " +
	"its final report is returned as this tool's result. Calls made in the same message run in parallel."

type spawnInput struct {
	Role  string `json:"role"`
	Title string `json:"title"`
	Task  string `json:"task"`
	Tier  string `json:"tier"`
	Agent string `json:"agent"`
	Model string `json:"model"`
	// Env maps environment variable names to secret references for an
	// external agent's process.
	Env map[string]string `json:"env"`
}

func (rt *runtime) spawnDef(parent projectstore.Agent) (tools.Def, error) {
	schema, err := spawnSchemaFor(rt.acpAgents(), rt.routeEnabled())
	if err != nil {
		return tools.Def{}, fmt.Errorf("spawn_agent schema: %w", err)
	}
	return tools.Def{
		Name:        ToolSpawnAgent,
		Description: spawnDescription,
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
		if routed {
			return "spawn_agent requires role, title and task, and tier if given (auto|fast|balanced|deep)", true, nil
		}
		return "spawn_agent requires role, title, task and tier (fast|balanced|deep)", true, nil
	}
	// A delegation refused for budget reasons before the sub-agent starts still
	// gets its row, settled as failed with the reason, so the delegation does not
	// sit "starting" forever. (Malformed calls and unknown agents are plain tool
	// errors: nothing was going to start.)
	refuse := func(msg string) (string, bool, error) {
		rt.refuseChild(ctx, parent, in, tier, msg)
		return msg, true, nil
	}
	if be := rt.budgetReached(ctx); be != nil {
		return refuse(be.Error())
	}
	var route *projectstore.RouteInfo
	var budgetErr error
	if auto {
		plan := rt.resolveAuto(ctx, parent, in)
		tier, in.Tier, route, budgetErr = plan.tier, string(plan.tier), &plan.info, plan.budget
		if plan.agent != "" {
			in.Agent, in.Model = plan.agent, plan.model
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
	var ext *acpTarget
	model := rt.models.ForTier(in.Tier)
	if in.Agent == "" && strings.TrimSpace(in.Model) != "" {
		return "spawn_agent: model only applies together with agent; built-in sub-agents use tier", true, nil
	}
	if in.Agent != "" {
		target, msg := rt.pickACPAgent(in.Agent, strings.TrimSpace(in.Model))
		if msg != "" {
			return msg, true, nil
		}
		ext, model = &target, target.recorded()
	} else if plugins.IsACPRef(model) {
		// The tier is mapped to an ACP agent (models.<tier> = acp:<id>[/<model>]).
		id, m, _ := plugins.ParseACPRef(model)
		target, msg := rt.pickACPAgent(id, m)
		if msg != "" {
			return fmt.Sprintf("tier %q is mapped to %q: %s", in.Tier, model, msg), true, nil
		}
		ext, model = &target, target.recorded()
	}
	if len(in.Env) > 0 {
		if ext == nil {
			return "spawn_agent: env only applies together with agent; a built-in sub-agent passes env on its own bash calls", true, nil
		}
		env, err := rt.o.secrets.Resolve(rt.pid(), in.Env)
		if err != nil {
			return "spawn_agent: " + err.Error(), true, nil
		}
		ext.env = env
	}
	toolUseID := tools.ToolUseID(ctx)
	c, cancel := dbCtx(ctx)
	child, err := rt.db.CreateAgent(c, projectstore.NewAgent{
		ParentID: &parent.ID, Depth: parent.Depth + 1, Role: in.Role, Title: in.Title, Task: in.Task,
		Model: model, Tier: &tier, Status: projectstore.StatusRunning,
		SpawnToolUseID: &toolUseID, Started: true, Route: route,
	})
	cancel()
	if err != nil {
		return "", false, fmt.Errorf("create agent: %w", err)
	}
	rt.publishAgent(events.AgentCreated, child)
	if budgetErr != nil {
		// The router's 402: the same failure as a budget stop mid-run.
		rt.settle(ctx, child.ID, projectstore.StatusFailed, "", budgetErr.Error())
		return "", false, budgetErr
	}

	task := anthropic.NewUserMessage(anthropic.NewTextBlock(in.Task))
	sink := &agentSink{rt: rt, agentID: child.ID}
	if err := sink.Message(ctx, "user", task); err != nil {
		rt.settle(ctx, child.ID, projectstore.StatusFailed, "", err.Error())
		return "sub-agent failed: " + err.Error(), true, nil
	}
	text, err := rt.runChild(ctx, child, task, ext)
	switch {
	case err == nil:
		rt.settle(ctx, child.ID, projectstore.StatusCompleted, text, "")
		if text == "" {
			return "(sub-agent returned no report)", false, nil
		}
		return rt.o.opts.Limits.CapReport(rt.redact(text)), false, nil
	case router.IsBudget(err):
		// Not a recoverable tool error: stop the whole turn, no more upstream calls.
		rt.settle(ctx, child.ID, projectstore.StatusFailed, "", err.Error())
		return "", false, err
	case ctx.Err() != nil || errors.Is(err, errAgentCancelled):
		rt.settle(ctx, child.ID, projectstore.StatusCancelled, "", "")
		return "sub-agent cancelled", true, nil
	default:
		rt.settleHint(ctx, child.ID, projectstore.StatusFailed, "", err.Error(), hintOf(err))
		return rt.redact("sub-agent failed: " + err.Error()), true, nil
	}
}

// runChild runs the child through the built-in loop, or through ext when set.
func (rt *runtime) runChild(ctx context.Context, child projectstore.Agent, task anthropic.MessageParam, ext *acpTarget) (string, error) {
	if ext != nil {
		return rt.runACP(ctx, child, *ext)
	}
	res, err := rt.runAgent(ctx, child, []anthropic.MessageParam{task})
	return res.Text, err
}

// refuseChild records a delegation that was refused before it started: the
// sub-agent row is created and settled as failed with the reason, both
// announced, and linked to the spawn_agent call.
func (rt *runtime) refuseChild(ctx context.Context, parent projectstore.Agent, in spawnInput, tier projectstore.Tier, reason string) {
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
	rt.settle(ctx, child.ID, projectstore.StatusFailed, "", reason)
}
