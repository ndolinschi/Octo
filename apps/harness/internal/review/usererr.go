package review

import (
	"strings"

	"github.com/ndolinschi/Octo/apps/harness/internal/codehost"
	"github.com/ndolinschi/Octo/apps/harness/internal/usererr"
)

// Catalogue is the failure as the person reads it. Message and the other
// sentences built in this package are technical text: they become the
// catalogue form's details, and the wording is the catalogue's (a constructor
// for the cases with their own hint or command, usererr.Generic for the rest).
func (e *Error) Catalogue() *usererr.Error {
	d := e.Message
	switch e.Code {
	case codehost.ReasonNotInstalled:
		return usererr.GitHubCLIMissing(e.Command)
	case codehost.ReasonNotLoggedIn:
		return usererr.GitHubCLINotLoggedIn(e.Command)
	case codehost.ReasonNoRepo:
		return usererr.GitHubNoRemote(e.Command)
	case usererr.CodeGitMissing:
		return usererr.GitMissing(d)
	case usererr.CodeRepoMismatch:
		return usererr.RepoMismatch(d)
	case "invalid_repo":
		return usererr.InvalidRepo(d)
	case "ambiguous_pr":
		return usererr.AmbiguousPR(d)
	case usererr.CodeDirtyWorkingCopy:
		return usererr.DirtyWorkingCopy(len(e.Files))
	case "checkout_conflict":
		return usererr.CheckoutConflict(d)
	case usererr.CodeCodeHostFailed:
		return usererr.CodeHostFailed(d)
	case usererr.CodeGitFailed:
		return usererr.GitFailed(d)
	case usererr.CodeFetchFailed:
		return usererr.FetchFailed(d)
	case usererr.CodeWorktreeFailed:
		return usererr.WorktreeFailed(d)
	case usererr.CodeNewerSchema:
		return usererr.NewerSchema(d)
	case "comment_too_large", "file_too_large":
		return usererr.Generic("file_too_large", d)
	}
	return usererr.Generic(e.Code, strings.TrimSpace(d))
}
