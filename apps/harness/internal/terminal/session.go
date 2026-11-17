package terminal

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"
)

const (
	writeTimeout = 5 * time.Second
	readChunkSz  = 16 << 10
	replayCap    = 64 << 10
	tailCap      = 16 << 10
)

// AfterFunc schedules f after d and returns a stop function.
type AfterFunc func(d time.Duration, f func()) (stop func() bool)

func realAfter(d time.Duration, f func()) func() bool { return time.AfterFunc(d, f).Stop }

// ExitInfo describes how a terminal session ended.
type ExitInfo struct {
	Code   int
	Reason string
}

// Session owns one running interactive terminal shell and its output buffer.
type Session struct {
	ID      string
	Project string

	proc    *process
	bufSize int
	idle    time.Duration
	after   AfterFunc
	onClose func(*Session)

	writeMu sync.Mutex

	mu       sync.Mutex
	subCh    chan []byte
	replay   []byte
	closed   bool
	finished bool
	gen      uint64
	stopIdle func() bool
	reason   string
}

func newSession(id, project string, proc *process, o Options, onClose func(*Session)) *Session {
	return &Session{
		ID:      id,
		Project: project,
		proc:    proc,
		bufSize: o.Buffer,
		idle:    o.IdleTimeout,
		after:   o.After,
		onClose: onClose,
	}
}

func (s *Session) start() {
	s.mu.Lock()
	s.armIdle()
	s.mu.Unlock()
	go s.pump()
}

func (s *Session) armIdle() {
	if s.stopIdle != nil {
		s.stopIdle()
	}
	s.gen++
	gen := s.gen
	s.stopIdle = s.after(s.idle, func() {
		s.mu.Lock()
		stale := s.subCh != nil || s.gen != gen || s.closed
		s.mu.Unlock()
		if !stale {
			s.Close(fmt.Sprintf("no terminal subscriber for %s", s.idle))
		}
	})
}

func (s *Session) pump() {
	buf := make([]byte, readChunkSz)
	defer func() {
		s.mu.Lock()
		s.finished = true
		if s.subCh != nil {
			close(s.subCh)
			s.subCh = nil
		}
		s.mu.Unlock()
	}()
	for {
		n, err := s.proc.outR.Read(buf)
		if n > 0 {
			chunk := append([]byte(nil), buf[:n]...)
			s.deliver(chunk)
		}
		if err != nil {
			if isPTYEof(err) {
				select {
				case <-s.proc.exited:
				case <-time.After(waitDelay):
					s.proc.kill()
				}
			} else {
				s.Close("terminal read: " + err.Error())
			}
			return
		}
	}
}

func (s *Session) deliver(chunk []byte) {
	s.mu.Lock()
	s.replay = append(s.replay, chunk...)
	if len(s.replay) > replayCap {
		s.replay = append([]byte(nil), s.replay[len(s.replay)-replayCap:]...)
	}
	ch := s.subCh
	if ch == nil {
		s.mu.Unlock()
		return
	}
	select {
	case ch <- chunk:
		s.mu.Unlock()
	default:
		close(ch)
		s.subCh = nil
		s.armIdle()
		s.mu.Unlock()
		slog.Warn("terminal: subscriber too slow; detached stream", "session", s.ID)
	}
}

// WriteInput writes raw bytes to the terminal's PTY input.
func (s *Session) WriteInput(ctx context.Context, data []byte) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if len(data) > MaxInputSize {
		return fmt.Errorf("%w: %d bytes (limit %d)", ErrTooLarge, len(data), MaxInputSize)
	}
	if len(data) == 0 {
		return nil
	}
	s.mu.Lock()
	closed := s.closed
	s.mu.Unlock()
	if closed || s.Finished() {
		return ErrClosed
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	_ = s.proc.inW.SetWriteDeadline(time.Now().Add(writeTimeout))
	if _, err := s.proc.inW.Write(data); err != nil {
		s.Close("terminal write failed: " + err.Error())
		return fmt.Errorf("%w: %v", ErrClosed, err)
	}
	return nil
}

// Resize updates the PTY window dimensions in columns and rows.
func (s *Session) Resize(cols, rows int) error {
	s.mu.Lock()
	closed := s.closed
	s.mu.Unlock()
	if closed || s.Finished() {
		return ErrClosed
	}
	return s.proc.resize(cols, rows)
}

// Subscribe attaches an event stream, replaying recent buffered output first.
func (s *Session) Subscribe() (events <-chan []byte, release func(), err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	switch {
	case s.closed:
		return nil, nil, ErrClosed
	case s.subCh != nil:
		return nil, nil, ErrSubscribed
	}
	ch := make(chan []byte, s.bufSize)
	if len(s.replay) > 0 {
		ch <- append([]byte(nil), s.replay...)
	}
	if s.finished {
		close(ch)
		return ch, func() {}, nil
	}
	s.subCh = ch
	s.gen++
	if s.stopIdle != nil {
		s.stopIdle()
		s.stopIdle = nil
	}
	var once sync.Once
	return ch, func() {
		once.Do(func() {
			s.mu.Lock()
			defer s.mu.Unlock()
			if s.subCh == ch {
				close(ch)
				s.subCh = nil
			}
			if !s.closed && !s.finished {
				s.armIdle()
			}
		})
	}, nil
}

// Exit waits for the shell process to exit and reports its exit code and reason.
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

// Finished reports whether the underlying shell process has exited.
func (s *Session) Finished() bool {
	select {
	case <-s.proc.exited:
		return true
	default:
		return false
	}
}

// Close terminates the PTY process group and unregisters the session.
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

func (s *Session) PID() int             { return s.proc.cmd.Process.Pid }
func (s *Session) Spec() Spec           { return s.proc.spec }
func (s *Session) Shell() string        { return s.proc.shell }
func (s *Session) StartedAt() time.Time { return s.proc.startedAt }

// Subscribed reports whether a client is currently streaming output.
func (s *Session) Subscribed() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.subCh != nil
}

// OutputTail returns a sanitized UTF-8 tail of recent terminal output.
func (s *Session) OutputTail() string {
	s.mu.Lock()
	raw := append([]byte(nil), s.replay...)
	s.mu.Unlock()
	if len(raw) > tailCap {
		raw = raw[len(raw)-tailCap:]
	}
	return strings.TrimRight(strings.ToValidUTF8(string(raw), ""), "\r\n")
}
