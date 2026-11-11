package project

import (
	"fmt"

	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

type Kind int

const (
	KindInvalid Kind = iota + 1
	KindNotFound
	KindConflict
	KindTooLarge
	KindUnsupported
)

// Error is a caller-visible failure with a stable machine code.
type Error struct {
	Kind    Kind
	Code    string
	Message string
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

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
