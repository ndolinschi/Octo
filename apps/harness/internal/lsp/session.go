package lsp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"sync"
	"time"
)

const writeTimeout = 10 * time.Second

// AfterFunc schedules f after d and returns a stop func. f must not run
// synchronously inside AfterFunc.
type AfterFunc func(d time.Duration, f func()) (stop func() bool)

func realAfter(d time.Duration, f func()) func() bool { return time.AfterFunc(d, f).Stop }

// ExitInfo says how a session ended. Reason is empty when the server simply
// exited on its own; Code is -1 when it was killed.
type ExitInfo struct {
	Code   int
	Reason string
}

// Session is one running language server plus its message plumbing. Messages
// the server writes wait in a bounded buffer for the single subscriber.
type Session struct {
	ID      string
	Project string

	proc    *process
	out     chan []byte
	idle    time.Duration
	after   AfterFunc
	onClose func(*Session)

	writeMu sync.Mutex

	mu         sync.Mutex
	subscribed bool
	closed     bool
	gen        uint64
	stopIdle   func() bool
	reason     string
}

func newSession(id, project string, proc *process, o Options, onClose func(*Session)) *Session {
	s := &Session{
		ID: id, Project: project, proc: proc, out: make(chan []byte, o.Buffer),
		idle: o.IdleTimeout, after: o.After, onClose: onClose,
	}
	return s
}

// start arms the idle countdown and begins relaying; call once the session
// is registered so an immediate failure still unregisters it.
func (s *Session) start() {
	s.mu.Lock()
	s.armIdle()
	s.mu.Unlock()
	go s.pump()
}

// armIdle (re)starts the no-subscriber countdown; s.mu must be held.
func (s *Session) armIdle() {
	if s.stopIdle != nil {
		s.stopIdle()
	}
	s.gen++
	gen := s.gen
	s.stopIdle = s.after(s.idle, func() {
		s.mu.Lock()
		stale := s.subscribed || s.gen != gen
		s.mu.Unlock()
		if !stale {
			s.Close(fmt.Sprintf("no event subscriber for %s", s.idle))
		}
	})
}

// pump frames server output into s.out and closes it when the server is gone.
// It never blocks: a full buffer means the subscriber cannot keep up, and the
// session is dropped rather than letting memory grow.
func (s *Session) pump() {
	defer close(s.out)
	defer closeAll(s.proc.stdout)
	fr := NewFrameReader(s.proc.stdout, MaxMessageSize)
	for {
		raw, err := fr.Read()
		if err != nil {
			if errors.Is(err, io.EOF) {
				select {
				case <-s.proc.exited:
				case <-time.After(waitDelay):
					s.proc.kill()
				}
			} else {
				s.Close("language server output: " + err.Error())
			}
			return
		}
		var msg bytes.Buffer
		if err := json.Compact(&msg, raw); err != nil {
			slog.Warn("lsp: dropping invalid JSON from server", "session", s.ID, "err", err)
			continue
		}
		select {
		case s.out <- msg.Bytes():
		default:
			s.Close(fmt.Sprintf("event subscriber too slow: %d messages buffered", cap(s.out)))
			return
		}
	}
}

// Send writes one JSON-RPC message to the server.
func (s *Session) Send(ctx context.Context, msg []byte) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if len(msg) > MaxMessageSize {
		return fmt.Errorf("%w: %d bytes (limit %d)", ErrTooLarge, len(msg), MaxMessageSize)
	}
	if t := bytes.TrimSpace(msg); len(t) == 0 || t[0] != '{' || !json.Valid(t) {
		return ErrInvalidMessage
	}
	s.mu.Lock()
	closed := s.closed
	s.mu.Unlock()
	if closed || s.Finished() {
		return ErrClosed
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if err := s.proc.stdin.SetWriteDeadline(time.Now().Add(writeTimeout)); err != nil {
		slog.Debug("lsp: set write deadline", "err", err)
	}
	if err := WriteMessage(s.proc.stdin, msg, MaxMessageSize); err != nil {
		s.Close("write to language server failed: " + err.Error())
		return fmt.Errorf("%w: %v", ErrClosed, err)
	}
	return nil
}

// Subscribe claims the session's single event stream. Messages buffered since
// the session started are delivered first. The channel is closed when the
// server is gone; call Exit then. release must be called when the consumer
// stops reading; the idle countdown restarts from that moment.
func (s *Session) Subscribe() (events <-chan []byte, release func(), err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	switch {
	case s.closed:
		return nil, nil, ErrClosed
	case s.subscribed:
		return nil, nil, ErrSubscribed
	}
	s.subscribed = true
	s.gen++
	if s.stopIdle != nil {
		s.stopIdle()
		s.stopIdle = nil
	}
	var once sync.Once
	return s.out, func() {
		once.Do(func() {
			s.mu.Lock()
			defer s.mu.Unlock()
			s.subscribed = false
			if !s.closed {
				s.armIdle()
			}
		})
	}, nil
}

// Exit waits for the server to be reaped and reports how it ended.
func (s *Session) Exit(ctx context.Context) (ExitInfo, error) {
	select {
	case <-s.proc.exited:
	case <-ctx.Done():
		return ExitInfo{}, ctx.Err()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return ExitInfo{Code: s.proc.code, Reason: s.reason}, nil
}

// Finished reports whether the server process has exited.
func (s *Session) Finished() bool {
	select {
	case <-s.proc.exited:
		return true
	default:
		return false
	}
}

// Close kills the server (its whole process group on unix), waits for it to
// be reaped and removes the session. It is idempotent; reason is kept from
// the first call and surfaced by Exit.
func (s *Session) Close(reason string) {
	s.mu.Lock()
	first := !s.closed
	s.closed = true
	if s.reason == "" {
		s.reason = reason
	}
	s.gen++
	stop := s.stopIdle
	s.stopIdle = nil
	s.mu.Unlock()
	if stop != nil {
		stop()
	}
	s.proc.kill()
	<-s.proc.exited
	if first && s.onClose != nil {
		s.onClose(s)
	}
}

// PID is the server's process id (for diagnostics and tests).
func (s *Session) PID() int { return s.proc.cmd.Process.Pid }

// Spec is how the server process was started.
func (s *Session) Spec() Spec { return s.proc.spec }

// StartedAt is when the server process was started (UTC).
func (s *Session) StartedAt() time.Time { return s.proc.startedAt }

// StderrTail returns the trailing stderr output captured from the server.
func (s *Session) StderrTail() string { return s.proc.stderr.tailText() }
