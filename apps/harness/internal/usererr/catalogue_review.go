package usererr

import "fmt"

// Review and code-host cases. Codes are the ones the review routes sent already.

// GitHubCLIMissing: the `gh` program is not installed. command is the install line.
func GitHubCLIMissing(command string) *Error {
	return &Error{
		Code: "gh_not_installed", Message: "The GitHub command line tool is not installed.",
		Hint: "Install it, then check again.", Command: command, Action: ActionRetry,
	}
}

// GitHubCLINotLoggedIn: `gh` is installed but not logged in.
func GitHubCLINotLoggedIn(command string) *Error {
	return &Error{
		Code: "not_logged_in", Message: "The GitHub command line tool is not logged in.",
		Hint: "Log in in a terminal, then try again.", Command: command, Action: ActionRetry,
	}
}

// GitHubNoRemote: the folder has no GitHub remote.
func GitHubNoRemote(command string) *Error {
	return &Error{
		Code: "no_github_repo", Message: "This folder is not connected to a GitHub repository.",
		Hint: "Add the repository as a remote, or review a local branch.", Command: command,
	}
}

// GitMissing: git is not installed.
func GitMissing(details string) *Error {
	return &Error{
		Code: CodeGitMissing, Message: "Git is not installed.",
		Hint: "Install Git, then try again.", Action: ActionRetry, Details: clip(details),
	}
}

// RepoMismatch: the pull request is not in one of the folder's repositories.
func RepoMismatch(details string) *Error {
	return &Error{
		Code: CodeRepoMismatch, Message: "That pull request is not in this project's repositories.",
		Hint: "Pick one of the repositories listed, or add the folder it belongs to.", Details: clip(details),
	}
}

// InvalidRepo: the repository named is not one of the folder's.
func InvalidRepo(details string) *Error {
	return &Error{
		Code: "invalid_repo", Message: "That repository is not one of this project's folders.",
		Hint: "Pick one of the repositories listed.", Details: clip(details),
	}
}

// AmbiguousPR: the pull request number exists in several repositories.
func AmbiguousPR(details string) *Error {
	return &Error{
		Code: "ambiguous_pr", Message: "That pull request number exists in more than one repository.",
		Hint: "Say which repository you mean.", Details: clip(details),
	}
}

// DirtyWorkingCopy: uncommitted changes would travel with a branch switch.
func DirtyWorkingCopy(changes int) *Error {
	return &Error{
		Code: CodeDirtyWorkingCopy, Message: "The working copy has uncommitted changes.",
		Hint: "Confirm to carry them to the new branch; nothing is discarded.", Details: fmt.Sprintf("%d changed file(s)", changes),
	}
}

// CheckoutConflict: uncommitted changes conflict with the pull request's branch.
func CheckoutConflict(details string) *Error {
	return &Error{
		Code: "checkout_conflict", Message: "Your uncommitted changes conflict with that branch.",
		Hint: "Commit or stash them first. Nothing was changed.", Details: clip(details),
	}
}

// CodeHostFailed: the code host (GitHub) refused or failed a call.
func CodeHostFailed(details string) *Error {
	return &Error{
		Code: CodeCodeHostFailed, Message: "GitHub did not accept the request.",
		Hint: "Try again in a moment.", Action: ActionRetry, Details: clip(details),
	}
}

// GitFailed: a git command failed.
func GitFailed(details string) *Error {
	return &Error{
		Code: CodeGitFailed, Message: "Git could not do that.",
		Hint: "Try again. The details say what git printed.", Action: ActionRetry, Details: clip(details),
	}
}

// FetchFailed: the pull request or its base could not be fetched.
func FetchFailed(details string) *Error {
	return &Error{
		Code: CodeFetchFailed, Message: "The pull request could not be downloaded.",
		Hint: "Check the connection and try again.", Action: ActionRetry, Details: clip(details),
	}
}

// WorktreeFailed: the review's private copy of the code could not be made.
func WorktreeFailed(details string) *Error {
	return &Error{
		Code: CodeWorktreeFailed, Message: "The review's copy of the code could not be made.",
		Hint: "Try again. Free disk space if it keeps failing.", Action: ActionRetry, Details: clip(details),
	}
}
