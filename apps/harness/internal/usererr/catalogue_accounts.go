package usererr

import "fmt"

// The cases below are the refusals of adding or removing an agent account
// (POST /v1/providers/{id}/accounts, DELETE .../accounts/{account}).

// AccountsNotSupported: the agent cannot keep more than one login in Octo.
func AccountsNotSupported(agent string) *Error {
	return &Error{Code: "invalid_request", Message: fmt.Sprintf("%s cannot have more than one account in Octo.", agent), Hint: "Add accounts to Claude Code or Codex instead."}
}

// AccountNameInvalid: an account name that is empty, too long or has control characters.
func AccountNameInvalid(max int) *Error {
	return &Error{Code: "invalid_request", Message: "An account needs a short name.", Hint: fmt.Sprintf("Use 1 to %d letters, digits or spaces.", max)}
}

// AccountFolderInvalid: a folder that is not a full path, has a $ sign or cannot be created.
func AccountFolderInvalid() *Error {
	return &Error{Code: "invalid_request", Message: "That folder cannot hold this account's login.", Hint: "Use a full path or one that starts with ~/, without $ signs, and not the agent's default folder."}
}

// AccountTaken: the agent has an account with that name or folder already.
func AccountTaken() *Error {
	return &Error{Code: "conflict", Message: "This agent has an account with that name or folder already.", Hint: "Choose another name and another folder."}
}

// AccountsFull: the agent has as many accounts as Octo keeps.
func AccountsFull(max int) *Error {
	return &Error{Code: "invalid_request", Message: fmt.Sprintf("An agent can have at most %d accounts.", max), Hint: "Remove an account you no longer use, then add this one."}
}

// AccountGone: the account a request names does not exist (any more).
func AccountGone() *Error {
	return &Error{Code: "not_found", Message: "That account no longer exists.", Hint: "Refresh the list, then try again.", Action: ActionRetry}
}

// AccountFolderNotOwned: removing an account with its folder was asked, but
// Octo did not create that folder (or it is no longer a plain folder at the
// account's path), so Octo will not delete it. Nothing was removed.
func AccountFolderNotOwned() *Error {
	return &Error{Code: "conflict", Message: "Octo did not create this account's folder, so it will not delete it.", Hint: "Remove the account and keep its folder, then delete the folder yourself if you no longer need it."}
}

// Code of the usage-limit cases below.
const CodeAgentLimitReached = "agent_limit_reached"

// AgentLimitReached: the agent (one account of it) refused a turn because its
// plan's usage limit is reached. label names the account ("Claude Code · Work");
// details is the agent's own text; accounts says the agent can keep several
// accounts, so another one is worth offering.
func AgentLimitReached(label, details string, accounts bool) *Error {
	return &Error{
		Code: CodeAgentLimitReached, Message: label + " has reached its usage limit.",
		Hint:   "Pick another " + accountOr(accounts) + "model and retry, or wait until the limit resets.",
		Action: ActionSwitchAccount, Details: clip(details),
	}
}

// AgentRateLimited: the agent refused a turn for a rate limit that says
// nothing about the plan (a bare 429); it usually lifts within moments. Same
// code and action as AgentLimitReached.
func AgentRateLimited(label, details string, accounts bool) *Error {
	return &Error{
		Code: CodeAgentLimitReached, Message: label + " is being rate limited.",
		Hint:   "Retry in a moment, or pick another " + accountOr(accounts) + "model.",
		Action: ActionSwitchAccount, Details: clip(details),
	}
}

func accountOr(accounts bool) string {
	if accounts {
		return "account or "
	}
	return ""
}

// CodeLoginUnavailable is the code of LoginUnavailable.
const CodeLoginUnavailable = "login_unavailable"

// LoginUnavailable: Octo has no login command to run for the agent. command is
// the terminal command to log in by hand ("" when unknown).
func LoginUnavailable(label, command, details string) *Error {
	return &Error{
		Code: CodeLoginUnavailable, Message: label + " cannot be logged in from Octo.",
		Hint:    "Log in to it in a terminal, then check again.",
		Command: command, Action: ActionRecheckProvider, Details: clip(details),
	}
}
