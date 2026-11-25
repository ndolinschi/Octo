// Package terminal manages interactive PTY shell sessions per project.
package terminal

import "errors"

const (
	MaxInputSize = 64 << 10
	DefaultCols  = 100
	DefaultRows  = 30
	MaxCols      = 500
	MaxRows      = 300
)

var (
	ErrNotFound          = errors.New("terminal session not found")
	ErrClosed            = errors.New("terminal session closed")
	ErrTooManySessions   = errors.New("too many terminal sessions for project")
	ErrTooLarge          = errors.New("terminal input too large")
	ErrSubscribed        = errors.New("terminal session already subscribed")
	ErrShutdown          = errors.New("terminal manager shutting down")
	ErrInvalidDimensions = errors.New("invalid terminal dimensions")
)
