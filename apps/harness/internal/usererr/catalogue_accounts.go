package usererr

import "fmt"

// Codes of the agent account cases.
const (
	CodeAgentLimitReached    = "agent_limit_reached"
	CodeAccountsUnsupported  = "accounts_unsupported"
	CodeAccountNameTaken     = "account_name_taken"
	CodeAccountDefault       = "account_default"
	CodeLoginUnavailable     = "login_unavailable"
	CodeAccountsFileUnusable = "accounts_file_unusable"
)

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

// AccountsFileUnusable: the accounts file in the data folder cannot be read
// (it does not parse, or a newer Octo wrote it), so accounts stay off and the
// file is left as it is. file is the file's name, details the reason.
func AccountsFileUnusable(file, details string) *Error {
	return &Error{
		Code: CodeAccountsFileUnusable, Message: "The file " + file + " cannot be read, so accounts cannot change.",
		Hint:    "Fix the file or move it aside, then restart Octo.",
		Details: clip(details),
	}
}

// AccountsUnsupported: the agent cannot keep a second login apart; reason says why.
func AccountsUnsupported(label, reason string) *Error {
	return &Error{
		Code: CodeAccountsUnsupported, Message: label + " can keep one account only.",
		Hint: "Use its one login, or choose another agent for the other account.", Details: clip(reason),
	}
}

// AccountNameTaken: another account of the same agent has the name already.
func AccountNameTaken(name string) *Error {
	return &Error{
		Code: CodeAccountNameTaken, Message: "An account with that name exists already.",
		Hint: "Choose another name.", Details: clip(fmt.Sprintf("name %q is taken", name)),
	}
}

// AccountDefault: the agent's own (default) login cannot be removed.
func AccountDefault(label string) *Error {
	return &Error{
		Code: CodeAccountDefault, Message: "The default account cannot be removed.",
		Hint: "Rename it, or remove the other accounts instead.", Details: clip(label),
	}
}

// AccountInvalid: the name or folder of a new or renamed account is not
// acceptable; details is the technical reason.
func AccountInvalid(details string) *Error {
	return &Error{
		Code: "invalid_request", Message: "That account setting is not valid.",
		Hint:    "Give a name of up to 40 characters and, for your own folder, an existing absolute folder.",
		Details: clip(details),
	}
}

// LoginUnavailable: Octo has no login command to run for the agent. command is
// the terminal command to log in by hand ("" when unknown).
func LoginUnavailable(label, command, details string) *Error {
	return &Error{
		Code: CodeLoginUnavailable, Message: label + " cannot be logged in from Octo.",
		Hint:    "Log in to it in a terminal, then check again.",
		Command: command, Action: ActionRecheckProvider, Details: clip(details),
	}
}
