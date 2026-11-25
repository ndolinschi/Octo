package orchestrator

import (
	"context"
	"errors"
	"fmt"
	"log/slog"

	"github.com/ndolinschi/Octo/apps/harness/internal/acp"
	"github.com/ndolinschi/Octo/apps/harness/internal/changes"
	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
	"github.com/ndolinschi/Octo/apps/harness/internal/usererr"
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
	if err == nil {
		// UX-45: the sub-agent's session must follow the project's access like the
		// ACP orchestrator's does (applyMode); an agent starting in a self-approving
		// mode (Claude Code's "auto") would otherwise never ask in a supervised project.
		err = rt.applySubAgentMode(ctx, client, ag, sess)
	}
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
		if ae := h.midTurnError(); ae != nil {
			return "", agentErrorFailure(ag, *ae, client.Stderr())
		}
		if ce := h.compactionError(); ce != "" {
			return "", usererr.AgentFailed(ag.Label, joinDetails(ce, client.Stderr()))
		}
		if h.compactedDone() {
			if text := h.finalText(); text != "" {
				return text, nil
			}
			return h.compactionSummary(), nil
		}
		if h.nothing() {
			return "", nothingError(ag, client.Stderr(), h.thoughtOnly())
		}
		return h.withDenials(h.finalText()), nil
	case acp.StopCancelled:
		return "", errAgentCancelled
	}
	return "", stopError(ag, stop)
}

// applySubAgentMode puts a new ACP sub-agent session into the mode the
// project's access needs (sessionModeTarget) before the task is prompted. When
// the agent refuses to leave a self-approving mode in a supervised or
// accept-edits project the run fails closed: running it would bypass the
// approvals the project asks for.
func (rt *runtime) applySubAgentMode(ctx context.Context, client *acp.Client, ag plugins.Agent, sess acp.Session) error {
	access := ""
	accessOf := func() string {
		if access == "" {
			access = rt.accessMode(ctx)
		}
		return access
	}
	target := sessionModeTarget(rt.readOnlyMode(), rt.mode, accessOf, sess.Modes, sess.Mode)
	if target == "" || target == sess.Mode {
		return nil
	}
	if err := client.SetMode(ctx, sess.ID, target); err != nil {
		if a := accessOf(); a == projectstore.AccessSupervised || a == projectstore.AccessAcceptEdits {
			return fmt.Errorf("%s could not switch to its %q mode, so it would not ask before changes: %w", ag.Label, target, err)
		}
		slog.Warn("acp: could not set the sub-agent's session mode", "project", rt.pid(), "agent", ag.ID, "mode", target, "err", err)
	}
	return nil
}

func authPolicy(ag plugins.Agent) acp.AuthPolicy {
	p := acp.AuthPolicy{Skip: ag.AuthSkip}
	for _, m := range ag.AuthMethods {
		p.Methods = append(p.Methods, acp.AuthPref{ID: m.ID, RequiresEnv: m.RequiresEnv})
	}
	return p
}
