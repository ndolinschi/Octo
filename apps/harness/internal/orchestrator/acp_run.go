package orchestrator

import (
	"context"
	"errors"

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
		return "", startFailure(t, err)
	}
	defer client.Close()
	defer rt.o.adv.running(ag.ID)()

	h := newACPSession(rt, child.ID, ag.ID, child.Model)
	h.flat = ag.FlatRateIn(t.processEnv())
	toolUse := ""
	if child.SpawnToolUseID != nil {
		toolUse = *child.SpawnToolUseID
	}
	endSpan := rt.trackSpan(ctx, child.ID, toolUse, changes.SourceACPTurn)
	defer endSpan()
	sess, err := client.NewSession(ctx, cwd, nil, acp.RunOptions{
		Model: t.model, ModelRequired: t.requested, ModelApplied: t.model != "" && len(ag.ModelArg) > 0, AuthHint: ag.Hint, Auth: authPolicy(ag),
		OnModels: func(m []acp.AdvertisedModel, cur string) { rt.o.noteAdvertised(ag.ID, m, cur) },
	})
	var stop acp.StopReason
	starting := err != nil // NEW-10: an exit before session/new answered is a start failure, after it a crash mid-request
	if err == nil {
		rt.keepAgentSession(ctx, child.ID, ag.ID, t.recorded(), sess.ID)
		stop, err = client.Prompt(ctx, sess.ID, child.Task, h)
	}
	h.finish(ctx, err != nil)
	if err != nil {
		return "", acpFailure(ag, starting, err)
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
