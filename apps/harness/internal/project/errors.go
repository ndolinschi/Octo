package project

import (
	"errors"
	"fmt"

	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
	"github.com/ndolinschi/Octo/apps/harness/internal/usererr"
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
	// User is the catalogue form of the failure (plain message, hint, command,
	// action, details). When set it is what the bridge sends; Message is its
	// plain message. Without it the bridge reads Message as technical text and
	// sends the catalogue's generic wording for Code (usererr.Generic).
	User *usererr.Error
	// Provider and Reason are set for model_unavailable: who would run the
	// model and what is missing.
	Provider string
	Reason   string
	// CanForce (model_unavailable): the refusal rests on an advisory login
	// probe; repeat the request with force_unverified to have it accepted.
	CanForce bool
	// Details is extra machine-readable data of the error (rewind_conflict lists the files).
	Details any
	// Fields is a refused form answer's message by property id (error.fields).
	Fields map[string]string
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

// ToolFacing says the message is meant for whoever made the call (a bad
// argument, something missing), so an agent's tool call reports it as a tool
// error instead of failing the turn.
func (e *Error) ToolFacing() bool { return e.Kind == KindInvalid || e.Kind == KindNotFound }

// Catalogue is the failure as the person reads it: User, or the generic
// wording of Code with Message as its details.
func (e *Error) Catalogue() *usererr.Error {
	if e.User != nil {
		return e.User
	}
	return usererr.Generic(e.Code, e.Message)
}

// of is an Error that carries a catalogue case; the code is the case's.
func of(kind Kind, u *usererr.Error) *Error {
	return &Error{Kind: kind, Code: u.Code, Message: u.Message, User: u}
}

func invalid(format string, args ...any) *Error {
	return &Error{Kind: KindInvalid, Code: "invalid_request", Message: fmt.Sprintf(format, args...)}
}

func notFound(what string) *Error {
	return &Error{Kind: KindNotFound, Code: "not_found", Message: what + " not found"}
}

func turnInProgress() *Error { return of(KindConflict, usererr.TurnInProgress()) }

func sideInProgress() *Error { return of(KindConflict, usererr.SideInProgress()) }

func fileChanged() *Error { return of(KindConflict, usererr.FileChanged()) }

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

func queueFull() *Error { return of(KindConflict, usererr.QueueFull(projectstore.MaxQueue)) }

// storeErr maps a store failure that has a clear meaning for the caller: a
// database written by a newer version of the app answers 409 newer_schema with
// what to do about it, not a bare 500.
func storeErr(err error) error {
	var ue *projectstore.UnavailableError
	if errors.As(err, &ue) {
		return &Error{Kind: KindConflict, Code: ue.User.Code, Message: ue.User.Message, User: ue.User}
	}
	var ne *projectstore.NewerSchemaError
	if errors.As(err, &ne) {
		return of(KindConflict, usererr.NewerSchema(ne.Error()))
	}
	return err
}
