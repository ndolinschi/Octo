package usererr

import "strconv"

// Parallel sessions (spec 2026-11-14-parallel-sessions-design.md, section 8): workspaces, worktrees, coordination.
// Phase 1 refuses worktrees with WorktreeUnavailable; the other cases are used by later phases and listed now so
// their wording is checked with the rest.
const (
	CodeWorktreeUnavailable = "worktree_unavailable"
	CodeWorkspaceNotFound   = "workspace_not_found"
	CodeWorkspaceMissing    = "workspace_missing"
	CodeWorkspaceDirty      = "workspace_dirty"
	CodeWorkspaceInUse      = "workspace_in_use"
	CodeApplyConflict       = "apply_conflict"
	CodeCoordinationOff     = "coordination_off"
	CodeSessionSlotsFull    = "session_slots_full"
)

// WorktreeUnavailable: a separate worktree cannot be made for the project (no folder is in a git repository, or
// worktree workspaces are not available in this version).
func WorktreeUnavailable(details string) *Error {
	return &Error{
		Code: CodeWorktreeUnavailable, Message: "None of this project's folders is in a git repository, so a separate worktree cannot be made.",
		Hint: "Use the main checkout for this session.", Details: details,
	}
}

// SessionWorktreeFailed: git could not make a session's worktree (git's text as details).
func SessionWorktreeFailed(details string) *Error {
	return &Error{
		Code: CodeWorktreeFailed, Message: "The session's worktree could not be made.",
		Hint: "Try again. The details say what git answered.", Action: ActionRetry, Details: details,
	}
}

// WorkspaceNotFound: no workspace with that id in the project.
func WorkspaceNotFound(id string) *Error {
	return &Error{Code: CodeWorkspaceNotFound, Message: "That workspace no longer exists.", Hint: "Choose another workspace.", Details: id}
}

// WorkspaceMissing: the workspace's directory is gone from the disk.
func WorkspaceMissing(path string) *Error {
	return &Error{
		Code: CodeWorkspaceMissing, Message: "This worktree's folder is gone from the disk.",
		Hint: "Its sessions can still be read. Remove the worktree to tidy up.", Details: path,
	}
}

// WorkspaceDirty: the worktree has uncommitted changes and removing it was not forced.
func WorkspaceDirty(files string) *Error {
	return &Error{
		Code: CodeWorkspaceDirty, Message: "This worktree has uncommitted changes.",
		Hint: "Apply them to the main checkout or commit them first, or remove it anyway.", Details: files,
	}
}

// WorkspaceInUse: a session in the workspace is running.
func WorkspaceInUse() *Error {
	return &Error{Code: CodeWorkspaceInUse, Message: "A session in this worktree is running.", Hint: "Stop it or wait until it ends."}
}

// ApplyConflict: the worktree's changes do not apply cleanly to the main checkout; nothing was changed.
func ApplyConflict(files string) *Error {
	return &Error{
		Code: CodeApplyConflict, Message: "Some changes do not apply cleanly to the main checkout.",
		Hint: "Nothing was changed. Merge the branch with your own tools instead.", Details: files,
	}
}

// CoordinationOff: the project switched coordination between sessions off.
func CoordinationOff() *Error {
	return &Error{
		Code: CodeCoordinationOff, Message: "Sessions of this project do not coordinate.",
		Hint: "Turn coordination on in the project's settings.", Action: ActionOpenSettings,
	}
}

// SessionSlotsFull: a turn could not start because the running caps are reached (a request that cannot wait in
// a queue, such as approving a plan).
func SessionSlotsFull(running int) *Error {
	return &Error{
		Code: CodeSessionSlotsFull, Message: "As many sessions as allowed are running already.",
		Hint: "Wait for one to finish, or allow more sessions at once in the settings.", Action: ActionOpenSettings,
		Details: strconv.Itoa(running) + " running",
	}
}

// WorkspaceAlreadyWorktree: the session is already running inside its own git worktree.
func WorkspaceAlreadyWorktree(id string) *Error {
	return &Error{
		Code: "already_in_worktree", Message: "This session already works in its own worktree.",
		Hint: "Continue working in this worktree, or start a new session.", Details: id,
	}
}
