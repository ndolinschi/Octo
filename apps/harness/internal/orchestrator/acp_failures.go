package orchestrator

import (
	"errors"
	"fmt"
	"strings"

	"github.com/ndolinschi/Octo/apps/harness/internal/acp"
	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
)

// userError is a failure written for the person using the app: msg says what
// happened, hint what to do about it. The hint travels in its own field (the
// agent row's error_hint, turn.finished's hint) and is never part of the text,
// so a UI that shows both does not print it twice.
type userError struct {
	msg, hint string
	cause     error
}

func (e *userError) Error() string { return e.msg }
func (e *userError) Unwrap() error { return e.cause }

// hintOf returns the hint of the first userError in err's chain, else "".
func hintOf(err error) string {
	var u *userError
	if errors.As(err, &u) {
		return u.hint
	}
	return ""
}

// loginHint is the manifest's login hint of the agent, else a generic one.
func loginHint(ag plugins.Agent) string {
	if h := strings.TrimSpace(ag.Hint); h != "" {
		return h
	}
	return "Check that it is installed and logged in (run it once in a terminal)."
}

// nothingError ends a turn in which the agent said and did nothing: no text,
// no tool call. A silent agent is usually one that is not logged in, so the
// manifest's login hint is the error's hint.
func nothingError(ag plugins.Agent) error {
	return &userError{msg: fmt.Sprintf("the agent %q returned nothing (no text and no tool calls)", ag.ID), hint: loginHint(ag)}
}

// stopError explains a prompt that ended for another reason than end_turn.
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
	return &userError{msg: fmt.Sprintf("the agent %q %s", ag.ID, what), hint: loginHint(ag)}
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

// acpFailure turns an error from talking to an ACP agent into the one the user
// sees: "<label> is not logged in" (hint separate) for a login problem, else the
// error wrapped with the agent's id. what is "ACP agent" or "start ACP agent".
func acpFailure(ag plugins.Agent, what string, err error) error {
	if isAuthFailure(err) {
		return &userError{msg: ag.Label + " is not logged in", hint: loginHint(ag), cause: err}
	}
	var me *acp.ModelError
	if errors.As(err, &me) {
		return &userError{msg: fmt.Sprintf("%s does not accept model %s", ag.Label, me.Model), hint: modelHint(ag, me.Offers), cause: err}
	}
	return fmt.Errorf("%s %q: %w", what, ag.ID, err)
}

// modelHint says what to choose instead of a model the agent refused: what it
// advertised in the session, else what the manifest lists.
func modelHint(ag plugins.Agent, offers []string) string {
	switch {
	case len(offers) > 0:
		return "It advertises: " + strings.Join(offers, ", ") + ". Choose one of those, or the agent's default."
	case len(ag.Models) > 0:
		return "It advertised no models in this session; the manifest lists: " + strings.Join(ag.Models, ", ") + ". Choose one of those, or the agent's default."
	}
	return "It advertised no models in this session. Choose the agent's default, or check the model name."
}

// startFailure is acpFailure for an agent that did not start; when the model
// was passed as a start-up argument, a refusal of it shows as an early exit.
func startFailure(t acpTarget, err error) error {
	ag := t.agent
	if t.requested && len(ag.ModelArg) > 0 && !isAuthFailure(err) {
		return &userError{msg: fmt.Sprintf("%s does not accept model %s (it did not start with it)", ag.Label, t.model),
			hint: modelHint(ag, nil), cause: err}
	}
	return acpFailure(ag, "start ACP agent", err)
}
