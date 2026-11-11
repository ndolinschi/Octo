// Package lsp runs language-server processes and relays their stdio messages.
// It frames and validates JSON but never interprets LSP.
package lsp

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log/slog"
	"sync"
	"time"
)

const (
	DefaultMaxPerProject = 8
	DefaultIdleTimeout   = 30 * time.Second
	// DefaultBuffer is how many server messages may wait for the subscriber.
	// At the 4 MiB message cap that bounds a session near 1 GiB in theory;
	// real servers send small notifications, so slow readers hit the count
	// long before the bytes matter.
	DefaultBuffer = 256
)

// Options tunes a Manager; zero values take the defaults.
type Options struct {
	MaxPerProject int
	IdleTimeout   time.Duration
	Buffer        int
	After         AfterFunc
}

func (o Options) withDefaults() Options {
	if o.MaxPerProject <= 0 {
		o.MaxPerProject = DefaultMaxPerProject
	}
	if o.IdleTimeout <= 0 {
		o.IdleTimeout = DefaultIdleTimeout
	}
	if o.Buffer <= 0 {
		o.Buffer = DefaultBuffer
	}
	if o.After == nil {
		o.After = realAfter
	}
	return o
}

// Manager owns every live session, keyed by id and scoped to a project.
type Manager struct {
	opts Options

	mu       sync.Mutex
	sessions map[string]*Session
	starting map[string]int
	closed   bool
}

func NewManager(opts Options) *Manager {
	return &Manager{opts: opts.withDefaults(), sessions: map[string]*Session{}, starting: map[string]int{}}
}

// Start launches spec for the project. It returns ErrTooManySessions when the
// project already has MaxPerProject live sessions.
func (m *Manager) Start(ctx context.Context, project string, spec Spec) (*Session, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if err := m.reserve(project); err != nil {
		return nil, err
	}
	proc, err := startProcess(spec)
	if err != nil {
		m.release(project)
		return nil, err
	}
	id, err := newID()
	if err != nil {
		proc.kill()
		<-proc.exited
		closeAll(proc.stdout)
		m.release(project)
		return nil, err
	}
	s := newSession(id, project, proc, m.opts, m.remove)

	m.mu.Lock()
	m.starting[project]--
	if m.closed {
		m.mu.Unlock()
		proc.kill()
		<-proc.exited
		closeAll(proc.stdout)
		return nil, ErrShutdown
	}
	m.sessions[id] = s
	m.mu.Unlock()
	s.start()
	slog.Info("lsp session started", "project", project, "server", spec.Name, "session", id, "pid", s.PID())
	return s, nil
}

func (m *Manager) reserve(project string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return ErrShutdown
	}
	live := m.starting[project]
	for _, s := range m.sessions {
		if s.Project == project && !s.Finished() {
			live++
		}
	}
	if live >= m.opts.MaxPerProject {
		return ErrTooManySessions
	}
	m.starting[project]++
	return nil
}

func (m *Manager) release(project string) {
	m.mu.Lock()
	m.starting[project]--
	m.mu.Unlock()
}

// Get returns the session if it belongs to the project.
func (m *Manager) Get(project, id string) (*Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.sessions[id]
	if !ok || s.Project != project {
		return nil, ErrNotFound
	}
	return s, nil
}

// Close ends a session on behalf of its client.
func (m *Manager) Close(project, id string) error {
	s, err := m.Get(project, id)
	if err != nil {
		return err
	}
	s.Close("closed by client")
	return nil
}

// Shutdown kills every session and refuses new ones.
func (m *Manager) Shutdown(ctx context.Context) error {
	m.mu.Lock()
	m.closed = true
	all := make([]*Session, 0, len(m.sessions))
	for _, s := range m.sessions {
		all = append(all, s)
	}
	m.mu.Unlock()

	var wg sync.WaitGroup
	for _, s := range all {
		wg.Add(1)
		go func() {
			defer wg.Done()
			s.Close("harness shutting down")
		}()
	}
	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (m *Manager) remove(s *Session) {
	m.mu.Lock()
	delete(m.sessions, s.ID)
	m.mu.Unlock()
	slog.Info("lsp session ended", "project", s.Project, "session", s.ID)
}

func newID() (string, error) {
	var b [12]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("session id: %w", err)
	}
	return "ls_" + hex.EncodeToString(b[:]), nil
}
