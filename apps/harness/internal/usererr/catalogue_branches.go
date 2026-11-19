package usererr

import "strconv"

// Branch choice in the composer (UI decision 97; parallel-sessions spec, "As built" 2026-11-19): the main
// checkout's branch is switched only when nothing can be lost or disturbed; every refusal changes nothing.
const (
	CodeUncommittedChanges = "uncommitted_changes"
	CodeCheckoutInUse      = "checkout_in_use"
	CodeBranchNotFound     = "branch_not_found"
	CodeBranchExists       = "branch_exists"
	CodeInvalidBranchName  = "invalid_branch_name"
	CodeNotAGitRepository  = "not_a_git_repository"
	CodeBranchSwitchFailed = "branch_switch_failed"
)

// UncommittedChanges: the main checkout has uncommitted changes, so it was not switched (files as details).
func UncommittedChanges(files string) *Error {
	return &Error{
		Code: CodeUncommittedChanges, Message: "The main checkout has uncommitted changes, so it stays on its branch.",
		Hint: "Start in a worktree from that branch instead. Your changes stay where they are.", Action: ActionUseWorktree,
		Details: files,
	}
}

// CheckoutInUse: a session is working in the main checkout, so its branch is not switched under it.
func CheckoutInUse(running int) *Error {
	return &Error{
		Code: CodeCheckoutInUse, Message: "A session is working in the main checkout, so it stays on its branch.",
		Hint: "Start in a worktree from that branch instead, or wait until the session ends.", Action: ActionUseWorktree,
		Details: strconv.Itoa(running) + " running",
	}
}

// BranchNotFound: no local branch of that name.
func BranchNotFound(name string) *Error {
	return &Error{
		Code: CodeBranchNotFound, Message: "There is no branch of that name in this repository.",
		Hint: "Choose a branch from the list, or create it.", Details: name,
	}
}

// BranchExists: a branch to create exists already.
func BranchExists(name string) *Error {
	return &Error{Code: CodeBranchExists, Message: "A branch of that name exists already.", Hint: "Choose it from the list instead.", Details: name}
}

// InvalidBranchName: git does not accept the name.
func InvalidBranchName(name string) *Error {
	return &Error{
		Code: CodeInvalidBranchName, Message: "That is not a valid branch name.",
		Hint: "Use letters, digits, dashes and slashes, without spaces or two dots in a row.", Details: name,
	}
}

// InvalidPage: a list's offset or limit is not a whole number of zero or more.
func InvalidPage() *Error {
	return &Error{Code: "invalid_request", Message: "That part of the list cannot be shown.", Hint: "Ask for the list again from the start."}
}

// NotAGitRepository: the folder is not inside a git repository.
func NotAGitRepository(folder string) *Error {
	return &Error{
		Code: CodeNotAGitRepository, Message: "This folder is not in a git repository.",
		Hint: "Branches can be chosen only for a folder under git.", Details: folder,
	}
}

// BranchSwitchFailed: git refused the switch (an untracked file it would overwrite, a branch checked out in
// another worktree); nothing was changed.
func BranchSwitchFailed(details string) *Error {
	return &Error{
		Code: CodeBranchSwitchFailed, Message: "Git did not switch the branch, so nothing was changed.",
		Hint: "Start in a worktree from that branch instead. The details say what git answered.", Action: ActionUseWorktree,
		Details: details,
	}
}
