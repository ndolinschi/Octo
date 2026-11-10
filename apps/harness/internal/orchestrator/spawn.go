package orchestrator

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/anthropics/anthropic-sdk-go/v2"

	"github.com/ndolinschi/Octo/apps/harness/internal/events"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
	"github.com/ndolinschi/Octo/apps/harness/internal/tools"
)

const ToolSpawnAgent = "spawn_agent"

const spawnDescription = "Delegate a task to a new sub-agent with a fresh context. It runs to completion and " +
	"its final report is returned as this tool's result. Calls made in the same message run in parallel."

var spawnSchema = json.RawMessage(`{"type":"object","properties":{` +
	`"role":{"type":"string","description":"Specialist role, e.g. Code explorer"},` +
	`"title":{"type":"string","description":"Short task title"},` +
	`"task":{"type":"string","description":"Self-contained brief including the expected report format"},` +
	`"tier":{"type":"string","enum":["fast","balanced","deep"],"description":"Model tier by task difficulty"}},` +
	`"required":["role","title","task","tier"]}`)

type spawnInput struct {
	Role  string `json:"role"`
	Title string `json:"title"`
	Task  string `json:"task"`
	Tier  string `json:"tier"`
}

func (rt *runtime) spawnDef(parent projectstore.Agent) tools.Def {
	return tools.Def{
		Name:        ToolSpawnAgent,
		Description: spawnDescription,
		InputSchema: spawnSchema,
		Handle: func(ctx context.Context, input json.RawMessage) (string, bool, error) {
			return rt.spawn(ctx, parent, input)
		},
	}
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
	toolUseID := tools.ToolUseID(ctx)
	c, cancel := dbCtx(ctx)
	child, err := rt.db.CreateAgent(c, projectstore.NewAgent{
		ParentID: &parent.ID, Depth: parent.Depth + 1, Role: in.Role, Title: in.Title, Task: in.Task,
		Model: rt.models.ForTier(in.Tier), Tier: &tier, Status: projectstore.StatusRunning,
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
	res, err := rt.runAgent(ctx, child, []anthropic.MessageParam{task})
	switch {
	case err == nil:
		rt.settle(ctx, child.ID, projectstore.StatusCompleted, res.Text, "")
		if res.Text == "" {
			return "(sub-agent returned no report)", false, nil
		}
		return tools.CapString(res.Text), false, nil
	case ctx.Err() != nil:
		rt.settle(ctx, child.ID, projectstore.StatusCancelled, "", "")
		return "sub-agent cancelled", true, nil
	default:
		rt.settle(ctx, child.ID, projectstore.StatusFailed, "", err.Error())
		return "sub-agent failed: " + err.Error(), true, nil
	}
}
