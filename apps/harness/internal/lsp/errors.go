package lsp

import "errors"

var (
	ErrNotFound        = errors.New("lsp: session not found")
	ErrTooManySessions = errors.New("lsp: too many sessions for this project")
	ErrTooLarge        = errors.New("lsp: message exceeds the size limit")
	ErrInvalidMessage  = errors.New("lsp: message is not a JSON object")
	ErrSubscribed      = errors.New("lsp: session already has an event subscriber")
	ErrClosed          = errors.New("lsp: session is closed")
	ErrShutdown        = errors.New("lsp: manager is shut down")
	ErrBadFrame        = errors.New("lsp: malformed message framing")
)
