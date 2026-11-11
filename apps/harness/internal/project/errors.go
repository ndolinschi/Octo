package project

import "fmt"

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
