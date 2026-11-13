package usererr

import (
	"fmt"
	"strings"
)

// Codes of the agent cases (the `code` of an error body, besides the
// route-level ones in catalogue_service.go).
const (
	CodeAgentNotLoggedIn   = "agent_not_logged_in"
	CodeAgentNotInstalled  = "agent_not_installed"
	CodeAgentLaunchFailed  = "agent_launch_rejected"
	CodeAgentExitedOnStart = "agent_exited_on_start"
	CodeAgentTimedOut      = "agent_timed_out"
	CodeAgentNoToolServer  = "agent_tool_server_refused"
	CodeAgentModelRejected = "agent_model_rejected"
	CodeAgentSilent        = "agent_silent"
	CodeAgentStopped       = "agent_stopped"
	CodeAgentCrashed       = "agent_crashed"
	CodeAgentFailed        = "agent_failed"
)

// AgentNotLoggedIn: "<Label> is not logged in." command is the login command
// of the agent ("" when unknown); instructions is the manifest's full login
// text, kept as Details.
func AgentNotLoggedIn(label, command, instructions string) *Error {
	return &Error{
		Code: CodeAgentNotLoggedIn, Message: label + " is not logged in.",
		Hint:    "Log in to it in a terminal, then check again.",
		Command: command, Action: ActionRecheckProvider, Details: clip(instructions),
	}
}

// AgentNotInstalled: the agent's program is not on this machine. installCommand
// is a copyable install line ("" when unknown); reason is the technical cause.
func AgentNotInstalled(label, installCommand, reason string) *Error {
	return &Error{
		Code: CodeAgentNotInstalled, Message: label + " is not installed.",
		Hint:    "Install it, then check again.",
		Command: installCommand, Action: ActionRecheckProvider, Details: clip(reason),
	}
}

// AgentLaunchRejected: the program started but did not accept the arguments
// Octo gave it (an older version, or a different flag). startHint is the
// manifest's own remark (for example "update it"), cli the program's name.
func AgentLaunchRejected(label, cli, stderrFirst, startHint string) *Error {
	hint := "Update it, then try again."
	if strings.TrimSpace(startHint) != "" {
		hint = "It may be too old. Update it, then try again."
	}
	return &Error{
		Code: CodeAgentLaunchFailed, Message: label + " did not start the way Octo asked.",
		Hint: hint, Command: cli + " --help", Action: ActionUpdateAgent,
		Details: clip(strings.TrimSpace(startHint + " " + fmt.Sprintf("Its launch command was rejected: %s", stderrFirst))),
	}
}

// AgentExitedDuringStart: the process ended before it was ready.
func AgentExitedDuringStart(label, details string) *Error {
	return &Error{
		Code: CodeAgentExitedOnStart, Message: label + " stopped while starting.",
		Hint: "Check that it runs in a terminal, then try again.", Action: ActionRetry, Details: clip(details),
	}
}

// AgentTimedOut: the agent did not answer in time.
func AgentTimedOut(label, details string) *Error {
	return &Error{
		Code: CodeAgentTimedOut, Message: label + " did not answer in time.",
		Hint: "Try again. If it keeps happening, check that it runs in a terminal.", Action: ActionRetry, Details: clip(details),
	}
}

// AgentRefusedToolServer: the agent could not take Octo's tool server (or Octo
// had none to offer), so the request ran without delegation and notes.
func AgentRefusedToolServer(label, details string) *Error {
	return &Error{
		Code:    CodeAgentNoToolServer,
		Message: label + " could not use Octo's tools this time; the request ran without delegation and notes.",
		Hint:    "Update the agent, or choose another one as the orchestrator.", Action: ActionUpdateAgent, Details: clip(details),
	}
}

// AgentModelRejected: the agent does not offer the model asked for. offers is
// what it advertised (may be empty).
func AgentModelRejected(label, model string, offers []string, details string) *Error {
	hint := "Choose another model, or the agent's default."
	if len(offers) > 0 {
		d := "It offers: " + strings.Join(offers, ", ") + "."
		if details != "" {
			d += " " + details
		}
		details = d
	}
	return &Error{
		Code: CodeAgentModelRejected, Message: fmt.Sprintf("%s does not offer the model %s.", label, model),
		Hint: hint, Action: ActionOpenSettings, Details: clip(details),
	}
}

// AgentSilent: the agent finished without saying or doing anything, which is
// usually a login that lapsed.
func AgentSilent(label, command, instructions string) *Error {
	return &Error{
		Code: CodeAgentSilent, Message: label + " answered with nothing.",
		Hint:    "It may not be logged in. Check it, then try again.",
		Command: command, Action: ActionRecheckProvider, Details: clip(instructions),
	}
}

// StopKind is why an agent ended a prompt without finishing it.
type StopKind int

const (
	StopDeclined StopKind = iota + 1
	StopOutOfRoom
	StopTooManyRequests
	StopUnknown
)

// AgentStopped: the agent ended the prompt early. raw is the protocol's own
// stop reason, kept as Details.
func AgentStopped(label string, kind StopKind, raw string) *Error {
	e := &Error{Code: CodeAgentStopped, Details: clip(raw), Action: ActionRetry}
	switch kind {
	case StopDeclined:
		e.Message, e.Hint, e.Action = label+" declined the request.", "Rephrase it, or use another agent.", ActionNone
	case StopOutOfRoom:
		e.Message, e.Hint = label+" ran out of room for its answer.", "Ask for a smaller step."
	case StopTooManyRequests:
		e.Message, e.Hint = label+" reached its limit of steps for one request.", "Ask for a smaller step."
	default:
		e.Message, e.Hint = label+" stopped unexpectedly.", "Try again."
	}
	return e
}

// AgentCrashed: the process ended in the middle of a request.
func AgentCrashed(label, details string) *Error {
	return &Error{
		Code: CodeAgentCrashed, Message: label + " stopped in the middle of the request.",
		Hint: "Try again. Octo starts it again by itself.", Action: ActionRetry, Details: clip(details),
	}
}

// AgentUnavailable: the agent or model chosen for the project cannot be used
// (unknown, unavailable, no folder to work in, a malformed setting).
func AgentUnavailable(details string) *Error {
	return &Error{
		Code: "agent_unavailable", Message: "The agent chosen for this project cannot be used.",
		Hint: "Choose another agent or model in the project's settings.", Action: ActionOpenSettings, Details: clip(details),
	}
}

// AgentFailed: anything else that went wrong while talking to an agent.
func AgentFailed(label, details string) *Error {
	return &Error{
		Code: CodeAgentFailed, Message: label + " could not finish the request.",
		Hint: "Try again. If it keeps happening, open the details.", Action: ActionRetry, Details: clip(details),
	}
}
