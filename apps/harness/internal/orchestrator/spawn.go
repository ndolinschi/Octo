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
}

func (rt *runtime) spawnDef(parent projectstore.Agent) (tools.Def, error) {
	schema, err := spawnSchema(rt.acpAgents())
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
	tier := projectstore.Tier(in.Tier)
	if in.Role == "" || in.Title == "" || in.Task == "" || !tier.Valid() {
		return "spawn_agent requires role, title, task and tier (fast|balanced|deep)", true, nil
	}
	if be := rt.budgetReached(ctx); be != nil {
		return be.Error(), true, nil
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
	toolUseID := tools.ToolUseID(ctx)
	c, cancel := dbCtx(ctx)
	child, err := rt.db.CreateAgent(c, projectstore.NewAgent{
		ParentID: &parent.ID, Depth: parent.Depth + 1, Role: in.Role, Title: in.Title, Task: in.Task,
		Model: model, Tier: &tier, Status: projectstore.StatusRunning,
		SpawnToolUseID: &toolUseID, Started: true,
	})
	cancel()
	if err != nil {
		return "", false, fmt.Errorf("create agent: %w", err)
	}
	rt.publishAgent(events.AgentCreated, child)

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
		return rt.o.opts.Limits.CapReport(text), false, nil
	case router.IsBudget(err):
		// Not a recoverable tool error: stop the whole turn, no more upstream calls.
		rt.settle(ctx, child.ID, projectstore.StatusFailed, "", err.Error())
		return "", false, err
	case ctx.Err() != nil || errors.Is(err, errAgentCancelled):
		rt.settle(ctx, child.ID, projectstore.StatusCancelled, "", "")
		return "sub-agent cancelled", true, nil
	default:
		rt.settle(ctx, child.ID, projectstore.StatusFailed, "", err.Error())
		return "sub-agent failed: " + err.Error(), true, nil
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
