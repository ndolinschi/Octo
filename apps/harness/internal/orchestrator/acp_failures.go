package orchestrator

import (
	"context"
	"errors"
	"io/fs"
	"net/http"
	"os/exec"
	"strings"

	"github.com/anthropics/anthropic-sdk-go/v2"

	"github.com/ndolinschi/Octo/apps/harness/internal/acp"
	"github.com/ndolinschi/Octo/apps/harness/internal/agent"
	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
	"github.com/ndolinschi/Octo/apps/harness/internal/router"
	"github.com/ndolinschi/Octo/apps/harness/internal/usererr"
)

// nothingError ends a turn in which the agent said and did nothing: no text,
// no tool call. A silent agent is usually one that is not logged in.
func nothingError(ag plugins.Agent) error {
	return usererr.AgentSilent(ag.Label, ag.LoginCmd(), ag.Hint)
}

// stopError explains a prompt that ended for another reason than end_turn.
func stopError(ag plugins.Agent, stop acp.StopReason) error {
	kind := usererr.StopUnknown
	switch stop {
	case acp.StopRefusal:
		kind = usererr.StopDeclined
	case acp.StopMaxTokens:
		kind = usererr.StopOutOfRoom
	case acp.StopMaxTurnRequests:
		kind = usererr.StopTooManyRequests
	}
	return usererr.AgentStopped(ag.Label, kind, string(stop))
}

// isAuthFailure reports whether err says the agent is not logged in: the
// client's own verdict (it offers no login it can complete) or the agent's
// JSON-RPC refusal ("Authentication required", usually -32000) of a session
// or a prompt.
func isAuthFailure(err error) bool {
	if errors.Is(err, acp.ErrAuthRequired) {
		return true
	}
	var rpcErr *acp.RPCError
	if !errors.As(err, &rpcErr) {
		return false
	}
	m := strings.ToLower(rpcErr.Message)
	for _, s := range []string{"authentication required", "auth required", "not authenticated", "not logged in", "login required", "unauthenticated"} {
		if strings.Contains(m, s) {
			return true
		}
	}
	return false
}

// acpFailure turns an error from talking to an ACP agent into the catalogue
// error the user sees. starting says the agent was still starting up.
func acpFailure(ag plugins.Agent, starting bool, err error) error {
	if isAuthFailure(err) {
		return usererr.AgentNotLoggedIn(ag.Label, ag.LoginCmd(), ag.Hint).Caused(err)
	}
	if u := launchRejection(ag, err); u != nil {
		return u
	}
	var me *acp.ModelError
	if errors.As(err, &me) {
		offers := me.Offers
		if len(offers) == 0 {
			offers = ag.Models
		}
		return usererr.AgentModelRejected(ag.Label, me.Model, offers, err.Error()).Caused(err)
	}
	var exit *acp.ExitError
	switch {
	case errors.Is(err, exec.ErrNotFound), errors.Is(err, fs.ErrNotExist):
		return usererr.AgentNotInstalled(ag.Label, ag.InstallCmd(), err.Error()).Caused(err)
	case errors.Is(err, context.DeadlineExceeded):
		return usererr.AgentTimedOut(ag.Label, err.Error()).Caused(err)
	case starting && (errors.As(err, &exit) || errors.Is(err, acp.ErrClosed)):
		return usererr.AgentExitedDuringStart(ag.Label, err.Error()).Caused(err)
	case errors.As(err, &exit) || errors.Is(err, acp.ErrClosed):
		return usererr.AgentCrashed(ag.Label, err.Error()).Caused(err)
	}
	return usererr.AgentFailed(ag.Label, err.Error()).Caused(err)
}

// startFailure is acpFailure for an agent that did not start; when the model
// was passed as a start-up argument, a refusal of it shows as an early exit.
func startFailure(t acpTarget, err error) error {
	ag := t.agent
	if u := launchRejection(ag, err); u != nil {
		return u
	}
	if t.requested && len(ag.ModelArg) > 0 && !isAuthFailure(err) {
		return usererr.AgentModelRejected(ag.Label, t.model, ag.Models, "It did not start with that model. "+err.Error()).Caused(err)
	}
	return acpFailure(ag, true, err)
}

// describe is the catalogue error a failed turn, side question or child agent
// settles with: the one in err's chain, else the catalogue's reading of a known
// error type (budget, no built-in loop, the model provider's HTTP errors), else
// Unexpected with err's text as its details.
func describe(err error) *usererr.Error {
	if u := usererr.As(err); u != nil {
		return u
	}
	var be *router.BudgetError
	var api *anthropic.Error
	switch {
	case errors.As(err, &be):
		return usererr.BudgetReached(be.Spent, be.Budget).Caused(err)
	case IsNoBuiltinLoop(err):
		return usererr.BuiltinLoopOff(err.Error()).Caused(err)
	case errors.Is(err, agent.ErrMaxTurns):
		return usererr.TooManySteps(err.Error()).Caused(err)
	case errors.As(err, &api) && (api.StatusCode == http.StatusUnauthorized || api.StatusCode == http.StatusForbidden):
		return usererr.ApiKeyRejected(err.Error()).Caused(err)
	case errors.As(err, &api):
		return usererr.ModelCallFailed(err.Error()).Caused(err)
	}
	return usererr.Unexpected(err)
}
