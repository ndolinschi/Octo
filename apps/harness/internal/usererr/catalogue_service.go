package usererr

import (
	"fmt"
	"strings"
)

// The route-level and turn-level cases. Codes match the `code` the routes
// already sent before the catalogue existed.
const (
	CodeNoProvider           = "no_provider"
	CodeProviderNotReady     = "model_unavailable"
	CodeBudgetReached        = "budget_reached"
	CodeTurnInProgress       = "turn_in_progress"
	CodeTurnInterrupted      = "turn_interrupted"
	CodeSideInProgress       = "side_in_progress"
	CodeQueueFull            = "queue_full"
	CodeImagesUnsupported    = "images_unsupported"
	CodeSteerUnsupported     = "steer_unsupported"
	CodeNothingToCompact     = "nothing_to_compact"
	CodeCompactUnsupported   = "compact_unsupported"
	CodeBuiltinLoopOff       = "builtin_loop_unavailable"
	CodeNewerSchema          = "newer_schema"
	CodePlanNotPending       = "plan_not_pending"
	CodeFileChanged          = "file_changed"
	CodeUnexpected           = "internal"
	CodeProviderNotConnected = "provider_not_connected"
	CodeProviderNotSupported = "provider_not_supported"
	CodeProviderNotWorking   = "provider_not_working"
	CodeDiscoveryOff         = "discovery_off"
	CodeMemoryProblem        = "memory_problem"
	CodeNoteProblem          = "note_problem"
	CodeCompletionFailed     = "completion_failed"
	CodeCommandProblem       = "command_problem"
	CodeSideNoAnswer         = "side_no_answer"
	CodeSideCancelled        = "cancelled"
	CodeGitHubCLIMissing     = "not_installed"
	CodeGitHubCLINotLoggedIn = "not_logged_in"
	CodeGitHubNoRemote       = "no_repo"
	CodeGitMissing           = "git_not_installed"
	CodeRepoMismatch         = "repo_mismatch"
	CodeDirtyWorkingCopy     = "dirty_working_copy"
	CodeCodeHostFailed       = "code_host_error"
	CodeGitFailed            = "git_error"
	CodeFetchFailed          = "fetch_failed"
	CodeWorktreeFailed       = "worktree_failed"
)

// Unexpected: an error nobody wrote a sentence for. The text goes to Details.
func Unexpected(err error) *Error {
	e := &Error{
		Code: CodeUnexpected, Message: "Something went wrong inside Octo.",
		Hint: "Try again. If it keeps happening, copy the details when you report it.", Action: ActionRetry,
	}
	if err != nil {
		e.Caused(err)
	}
	return e
}

// NoProvider: nothing is connected that could run a model.
func NoProvider() *Error {
	return &Error{
		Code: CodeNoProvider, Message: "No model provider is connected.",
		Hint: "Add an API key in Settings, or log in to an agent such as Claude Code, then try again.", Action: ActionConnectProvider,
	}
}

// ProviderNotConnected: a provider (the API key, the router) is not set up.
func ProviderNotConnected(label, hint, details string) *Error {
	if strings.TrimSpace(hint) == "" {
		hint = "Connect it in Settings, then try again."
	}
	return &Error{
		Code: CodeProviderNotConnected, Message: label + " is not connected.",
		Hint: hint, Action: ActionConnectProvider, Details: clip(details),
	}
}

// ProviderNotSupported: the agent's program cannot work with Octo.
func ProviderNotSupported(label, reason string) *Error {
	return &Error{
		Code: CodeProviderNotSupported, Message: label + " does not work with Octo yet.",
		Hint: "Choose another agent for now.", Action: ActionOpenSettings, Details: clip(reason),
	}
}

// ProviderNotWorking: a provider that is set up but failing.
func ProviderNotWorking(label, reason string) *Error {
	return &Error{
		Code: CodeProviderNotWorking, Message: label + " is not working right now.",
		Hint: "Check it again in a moment.", Action: ActionRecheckProvider, Details: clip(reason),
	}
}

// ModelCallFailed: the model provider did not answer the request.
func ModelCallFailed(details string) *Error {
	return &Error{
		Code: "model_call_failed", Message: "The model did not answer.",
		Hint: "Try again. If it keeps happening, check the provider in Settings.", Action: ActionRetry, Details: clip(details),
	}
}

// ModelUnreachable: the connection to the model's service failed or broke off
// in the middle of an answer (refused, reset, cut).
func ModelUnreachable(details string) *Error {
	return &Error{
		Code: "model_unreachable", Message: "The connection to the model broke off.",
		Hint: "Check the network and the provider in Settings, then try again.", Action: ActionRetry, Details: clip(details),
	}
}

// RouterUnreachable: the same, when the model is reached through the Octo
// router (it stopped or restarted).
func RouterUnreachable(details string) *Error {
	return &Error{
		Code: "router_unreachable", Message: "The Octo router stopped answering.",
		Hint: "Restart Octo (it starts the router again), then try again.", Action: ActionRetry, Details: clip(details),
	}
}

// ApiKeyRejected: the provider refused the API key.
func ApiKeyRejected(details string) *Error {
	return &Error{
		Code: "api_key_rejected", Message: "The provider did not accept the API key.",
		Hint: "Check the key in Settings, then try again.", Action: ActionConnectProvider, Details: clip(details),
	}
}

// TooManySteps: the agent used all the steps one request may take.
func TooManySteps(details string) *Error {
	return &Error{
		Code: "too_many_steps", Message: "The request needed more steps than one turn allows.",
		Hint: "Ask for a smaller step, or send a follow-up to go on.", Details: clip(details),
	}
}

// BudgetReached: the project's budget is used up. spent and budget are USD;
// a negative value means unknown.
func BudgetReached(spent, budget float64) *Error {
	e := &Error{
		Code: CodeBudgetReached, Message: "This project's budget is used up.",
		Hint: "Raise the budget in the project's settings to go on.", Action: ActionOpenSettings,
	}
	if spent >= 0 && budget >= 0 {
		e.Message = fmt.Sprintf("This project's budget is used up (%s of %s).", usd(spent), usd(budget))
	}
	return e
}

// usd uses two decimals, or four for an amount under a cent so a $0.0042
// spend does not read as $0.00.
func usd(v float64) string {
	if v > 0 && v < 0.01 {
		return fmt.Sprintf("$%.4f", v)
	}
	return fmt.Sprintf("$%.2f", v)
}

// TurnInProgress: a request is already running in this project.
func TurnInProgress() *Error {
	return &Error{
		Code: CodeTurnInProgress, Message: "Octo is already working on a request in this project.",
		Hint: "Wait for it to finish, or stop it first.",
	}
}

// TurnInterrupted: the harness stopped (a crash, a kill, a restart) while a
// request was running; the turn was closed when it started again.
func TurnInterrupted() *Error {
	return &Error{
		Code: CodeTurnInterrupted, Message: "Octo's local service restarted while this request was running.",
		Hint: "What it had written before the restart is kept. Retry to run the request again.", Action: ActionRetry,
	}
}

// SideInProgress: a side question is already running.
func SideInProgress() *Error {
	return &Error{
		Code: CodeSideInProgress, Message: "A side question is already running.",
		Hint: "Wait for its answer, or clear it first.",
	}
}

// SideNoAnswer: nothing can answer a side question. reason says why when known.
func SideNoAnswer(reason string) *Error {
	return &Error{
		Code: CodeNoProvider, Message: "Nothing can answer a side question right now.",
		Hint: "Connect a provider in Settings, or choose a side model.", Action: ActionConnectProvider, Details: clip(reason),
	}
}

// QueueFull: the message queue holds its maximum.
func QueueFull(max int) *Error {
	return &Error{
		Code: CodeQueueFull, Message: "The message queue is full.",
		Hint: "Wait for the running request, or remove a queued message.", Details: fmt.Sprintf("limit %d", max),
	}
}

// ImagesUnsupported: the project's agent or model does not take images.
func ImagesUnsupported(label string) *Error {
	return &Error{
		Code: CodeImagesUnsupported, Message: label + " does not accept images.",
		Hint: "Remove the images, or choose another agent or model for this project.", Action: ActionOpenSettings,
	}
}

// SteerUnsupported: the running turn cannot take a message in the middle.
func SteerUnsupported() *Error {
	return &Error{
		Code: CodeSteerUnsupported, Message: "This agent cannot take a message while it works.",
		Hint: "The message is sent when the request ends, or send it now to stop the request first.",
	}
}

// NothingToCompact: the conversation has nothing a summary would replace.
func NothingToCompact() *Error {
	return &Error{
		Code: CodeNothingToCompact, Message: "There is nothing to summarise yet.",
		Hint: "Summarise again after a few more exchanges.",
	}
}

// CompactUnsupported: compaction does not apply to this orchestrator.
func CompactUnsupported(reason string) *Error {
	return &Error{
		Code: CodeCompactUnsupported, Message: "This conversation cannot be summarised here.",
		Hint: "The agent keeps its own context, so there is nothing to do.", Details: clip(reason),
	}
}

// BuiltinLoopOff: a request needs the built-in agent, which has no API key.
func BuiltinLoopOff(reason string) *Error {
	return &Error{
		Code: CodeBuiltinLoopOff, Message: "The built-in agent has no API key.",
		Hint: "Add a key in Settings, or choose an agent such as Claude Code for this project.", Action: ActionConnectProvider,
		Details: clip(reason),
	}
}

// NewerSchema: the project's data was written by a newer Octo.
func NewerSchema(details string) *Error {
	return &Error{
		Code: CodeNewerSchema, Message: "This project was saved by a newer version of Octo.",
		Hint: "Update Octo to open it.", Action: ActionNone, Details: clip(details),
	}
}

// PlanNotPending: the plan was approved already.
func PlanNotPending() *Error {
	return &Error{Code: CodePlanNotPending, Message: "This plan was approved already."}
}

// FileChanged: the file changed on disk since it was read.
func FileChanged() *Error {
	return &Error{
		Code: CodeFileChanged, Message: "The file changed on disk since you opened it.",
		Hint: "Reload it, then apply your edit again.", Action: ActionRetry,
	}
}

// CompletionFailed: an inline completion could not be made.
func CompletionFailed(details string) *Error {
	return &Error{
		Code: CodeCompletionFailed, Message: "The suggestion could not be made.",
		Hint: "Keep typing; it tries again by itself.", Details: clip(details),
	}
}

// ModelsLookupFailed: the agent's models could not be listed.
func ModelsLookupFailed(label, details string) *Error {
	return &Error{
		Code: CodeProviderNotWorking, Message: "The model list of " + label + " could not be read.",
		Hint: "Try again, or type a model name yourself.", Action: ActionRetry, Details: clip(details),
	}
}

// DiscoveryOff: looking for models is switched off.
func DiscoveryOff() *Error {
	return &Error{
		Code: CodeDiscoveryOff, Message: "Looking for models is switched off.",
		Hint: "Type a model name yourself, or switch it on in Settings.", Action: ActionOpenSettings,
	}
}

// CommandFailed: a pinned or slash command could not run.
func CommandFailed(details string) *Error {
	return &Error{
		Code: CodeCommandProblem, Message: "That command could not run.",
		Hint: "Check the command in the project's settings.", Action: ActionOpenSettings, Details: clip(details),
	}
}

// MemoryFailed: the memory could not be read or changed.
func MemoryFailed(details string) *Error {
	return &Error{
		Code: CodeMemoryProblem, Message: "Octo could not use its memory just now.",
		Hint: "Try again.", Action: ActionRetry, Details: clip(details),
	}
}

// NoteFailed: a note could not be read or saved.
func NoteFailed(details string) *Error {
	return &Error{
		Code: CodeNoteProblem, Message: "The note could not be saved.",
		Hint: "Check the note and try again.", Action: ActionRetry, Details: clip(details),
	}
}
