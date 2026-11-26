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
