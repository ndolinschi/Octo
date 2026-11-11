package orchestrator

import (
	"fmt"
	"strings"

	"github.com/ndolinschi/Octo/apps/harness/internal/acp"
	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
)

// loginHint is ", if it is not logged in: <hint>" for an agent whose manifest has one.
func loginHint(ag plugins.Agent) string {
	if h := strings.TrimSpace(ag.Hint); h != "" {
		return "; if it is not logged in: " + h
	}
	return "; check that it is installed and logged in (run it once in a terminal)"
}

// nothingError ends a turn in which the agent said and did nothing: no text,
// no tool call. A silent agent is usually one that is not logged in, so the
// manifest's login hint is part of the message.
func nothingError(ag plugins.Agent) error {
	return fmt.Errorf("the agent %q returned nothing (no text and no tool calls)%s", ag.ID, loginHint(ag))
}

// stopError explains a prompt that ended for another reason than end_turn,
// with what to do about it.
func stopError(ag plugins.Agent, stop acp.StopReason) error {
	var what string
	switch stop {
	case acp.StopRefusal:
		what = "declined the request; rephrase it or use another agent"
	case acp.StopMaxTokens:
		what = "ran out of output tokens; ask for a smaller step"
	case acp.StopMaxTurnRequests:
		what = "hit its limit of model requests for one prompt; ask for a smaller step"
	default:
		what = fmt.Sprintf("stopped with an unexpected reason %q", string(stop))
	}
	return fmt.Errorf("the agent %q %s%s", ag.ID, what, loginHint(ag))
}
