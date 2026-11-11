package orchestrator

import (
	"context"
	"errors"
	"fmt"

	"github.com/ndolinschi/Octo/apps/harness/internal/acp"
	"github.com/ndolinschi/Octo/apps/harness/internal/changes"
	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

// errAgentCancelled marks an ACP agent that ended its turn with stopReason
// "cancelled" without the turn context being cancelled.
var errAgentCancelled = errors.New("ACP agent cancelled")

// runACP runs the child's task on an external ACP agent in the project's
// first folder and returns the agent's final text.
func (rt *runtime) runACP(ctx context.Context, child projectstore.Agent, t acpTarget) (string, error) {
	ag := t.agent
	cwd := rt.folders[0].Path
	client, err := acp.Start(ctx, acp.Spec{
		Command: ag.Command, Args: ag.ArgsFor(t.model), Env: t.processEnv(), Dir: cwd, Name: ag.ID, Redact: rt.redact,
	})
	if err != nil {
		return "", fmt.Errorf("start ACP agent %q: %w", ag.ID, err)
	}
	defer client.Close()

	h := newACPSession(rt, child.ID, ag.ID, child.Model)
	h.flat = ag.FlatRate
	toolUse := ""
	if child.SpawnToolUseID != nil {
		toolUse = *child.SpawnToolUseID
	}
	endSpan := rt.trackSpan(ctx, child.ID, toolUse, changes.SourceACPTurn)
	defer endSpan()
	stop, err := client.RunWith(ctx, cwd, child.Task, h, acp.RunOptions{
		Model: t.model, ModelRequired: t.requested, ModelApplied: t.model != "" && len(ag.ModelArg) > 0, AuthHint: ag.Hint, Auth: authPolicy(ag),
		OnModels: func(m []acp.AdvertisedModel, cur string) { rt.o.noteAdvertised(ag.ID, m, cur) },
	})
	h.finish(ctx, err != nil)
	if err != nil {
		return "", fmt.Errorf("ACP agent %q: %w", ag.ID, err)
	}
	switch stop {
	case acp.StopEndTurn:
		if h.nothing() {
			return "", nothingError(ag)
		}
		return h.finalText(), nil
	case acp.StopCancelled:
		return "", errAgentCancelled
	}
	return "", stopError(ag, stop)
}

func authPolicy(ag plugins.Agent) acp.AuthPolicy {
	p := acp.AuthPolicy{Skip: ag.AuthSkip}
	for _, m := range ag.AuthMethods {
		p.Methods = append(p.Methods, acp.AuthPref{ID: m.ID, RequiresEnv: m.RequiresEnv})
	}
	return p
}
