package orchestrator

import (
	"context"
	"errors"
	"fmt"

	"github.com/ndolinschi/Octo/apps/harness/internal/acp"
	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

// errAgentCancelled marks an ACP agent that ended its turn with stopReason
// "cancelled" without the turn context being cancelled.
var errAgentCancelled = errors.New("ACP agent cancelled")

// runACP runs the child's task on an external ACP agent in the project's
// first folder and returns the agent's final text.
func (rt *runtime) runACP(ctx context.Context, child projectstore.Agent, ag plugins.Agent) (string, error) {
	cwd := rt.folders[0].Path
	client, err := acp.Start(ctx, acp.Spec{
		Command: ag.Command, Args: ag.Args, Env: ag.Env, Dir: cwd, Name: ag.ID,
	})
	if err != nil {
		return "", fmt.Errorf("start ACP agent %q: %w", ag.ID, err)
	}
	defer client.Close()

	h := newACPSession(rt, child.ID, ag.ID)
	stop, err := client.Run(ctx, cwd, child.Task, h)
	h.finish(ctx, err != nil)
	if err != nil {
		return "", fmt.Errorf("ACP agent %q: %w", ag.ID, err)
	}
	switch stop {
	case acp.StopEndTurn:
		return h.finalText(), nil
	case acp.StopCancelled:
		return "", errAgentCancelled
	}
	return "", fmt.Errorf("ACP agent %q stopped: %s", ag.ID, stop)
}
