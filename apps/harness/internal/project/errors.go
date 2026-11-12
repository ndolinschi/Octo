package project

import (
	"errors"
	"fmt"

	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
	"github.com/ndolinschi/Octo/apps/harness/internal/providers"
)

type Kind int

const (
	KindInvalid Kind = iota + 1
	KindNotFound
	KindConflict
	KindTooLarge
	KindUnsupported
	// KindUpstream: a model call failed (502).
	KindUpstream
	// KindUnprocessable: well-formed but cannot be done (422).
	KindUnprocessable
)

// Error is a caller-visible failure with a stable machine code.
type Error struct {
	Kind    Kind
	Code    string
	Message string
	// Provider and Reason are set for model_unavailable: who would run the
	// model and what is missing.
	Provider string
	Reason   string
	// CanForce (model_unavailable): the refusal rests on an advisory login
	// probe; repeat the request with force_unverified to have it accepted.
	CanForce bool
	// Details is extra machine-readable data of the error (rewind_conflict lists the files).
	Details any
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

// ToolFacing says the message is meant for whoever made the call (a bad
// argument, something missing), so an agent's tool call reports it as a tool
// error instead of failing the turn.
func (e *Error) ToolFacing() bool { return e.Kind == KindInvalid || e.Kind == KindNotFound }

func invalid(format string, args ...any) *Error {
	return &Error{Kind: KindInvalid, Code: "invalid_request", Message: fmt.Sprintf(format, args...)}
}

func notFound(what string) *Error {
	return &Error{Kind: KindNotFound, Code: "not_found", Message: what + " not found"}
}

func turnInProgress(msg string) *Error {
	return &Error{Kind: KindConflict, Code: "turn_in_progress", Message: msg}
}

func sideInProgress() *Error {
	return &Error{Kind: KindConflict, Code: "side_in_progress", Message: "a side question is already running for this project"}
}

func fileChanged() *Error {
	return &Error{Kind: KindConflict, Code: "file_changed", Message: "file changed on disk"}
}

func reviewReadOnly() *Error {
	return &Error{Kind: KindConflict, Code: "review_workspace_read_only",
		Message: "the review workspace is read-only: refreshing the review moves its worktree and would discard edits"}
}

func fileTooLarge(msg string) *Error {
	return &Error{Kind: KindTooLarge, Code: "file_too_large", Message: msg}
}

func binaryFile() *Error {
	return &Error{Kind: KindUnsupported, Code: "binary_file", Message: "file is not UTF-8 text"}
}

func revertUnavailable(note string) *Error {
	msg := "the content before this change was not kept"
	if note != "" {
		msg += " (" + note + ")"
	}
	return &Error{Kind: KindConflict, Code: "revert_unavailable", Message: msg}
}

func queueFull() *Error {
	return &Error{Kind: KindConflict, Code: "queue_full",
		Message: fmt.Sprintf("the message queue is full (%d messages); wait for the running turn or remove one", projectstore.MaxQueue)}
}

// storeErr maps a store failure that has a clear meaning for the caller: a
// database written by a newer version of the app answers 409 newer_schema with
// the store's own message (what to do), not a bare 500.
func storeErr(err error) error {
	var ne *projectstore.NewerSchemaError
	if errors.As(err, &ne) {
		return &Error{Kind: KindConflict, Code: "newer_schema", Message: ne.Error()}
	}
	return err
}

// modelUnavailable is 422: the model's provider cannot run it now.
func modelUnavailable(field, model string, u *providers.Unavailable) *Error {
	return &Error{
		Kind: KindUnprocessable, Code: "model_unavailable", Provider: u.Provider, Reason: u.Reason, CanForce: u.CanForce,
		Message: fmt.Sprintf("models.%s %q cannot run: %s", field, model, u.Reason),
	}
}

// noProvider is 409: no provider is connected, so no project can run.
func noProvider() *Error {
	return &Error{Kind: KindConflict, Code: "no_provider",
		Message: "No provider is connected. Add an API key in Settings, or log in to an agent such as Claude Code, then try again."}
}
