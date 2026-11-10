package project

import "fmt"

type Kind int

const (
	KindInvalid Kind = iota + 1
	KindNotFound
	KindConflict
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
