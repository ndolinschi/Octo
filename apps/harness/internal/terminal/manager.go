package terminal

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
	DefaultMaxPerProject = 12
	DefaultIdleTimeout   = 5 * time.Minute
	DefaultBuffer        = 256
)

// Options configures a terminal Manager.
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

// SessionInfo summarizes a live terminal session for inspection (e.g. Processes tab).
type SessionInfo struct {
	ID         string
	Project    string
	Spec       Spec
	Shell      string
	PID        int
	StartedAt  time.Time
	Subscribed bool
	OutputTail string
}

// Manager owns active interactive terminal sessions across projects.
type Manager struct {
	opts Options

	mu       sync.Mutex
	sessions map[string]*Session
	starting map[string]int
	closed   bool
}

func NewManager(opts Options) *Manager {
	return &Manager{
		opts:     opts.withDefaults(),
		sessions: map[string]*Session{},
		starting: map[string]int{},
	}
}

// Start spawns a new interactive terminal session for project.
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
		return nil, ErrShutdown
	}
	m.sessions[id] = s
	m.mu.Unlock()

	s.start()
	slog.Info("terminal session started", "project", project, "session", id, "shell", s.Shell(), "pid", s.PID())
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

// Get returns the terminal session belonging to project.
func (m *Manager) Get(project, id string) (*Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.sessions[id]
	if !ok || s.Project != project {
		return nil, ErrNotFound
	}
	return s, nil
}

// Close terminates a terminal session on behalf of the client.
func (m *Manager) Close(project, id string) error {
	s, err := m.Get(project, id)
	if err != nil {
		return err
	}
	s.Close("closed by client")
	return nil
}

// CloseProject terminates all active terminal sessions belonging to project.
func (m *Manager) CloseProject(project string) {
	m.mu.Lock()
	var mine []*Session
	for _, s := range m.sessions {
		if s.Project == project {
			mine = append(mine, s)
		}
	}
	m.mu.Unlock()
	for _, s := range mine {
		s.Close("project deleted")
	}
}

// Restart closes session id and starts a fresh shell with the same Spec.
func (m *Manager) Restart(ctx context.Context, project, id string) (*Session, error) {
	s, err := m.Get(project, id)
	if err != nil {
		return nil, err
	}
	spec := s.Spec()
	s.Close("restarted by user")
	return m.Start(ctx, project, spec)
}

// ListProject snapshots live terminal sessions of project.
func (m *Manager) ListProject(project string) []SessionInfo {
	m.mu.Lock()
	var mine []*Session
	for _, s := range m.sessions {
		if s.Project == project && !s.Finished() {
			mine = append(mine, s)
		}
	}
	m.mu.Unlock()
	out := make([]SessionInfo, 0, len(mine))
	for _, s := range mine {
		if s.Finished() {
			continue
		}
		out = append(out, SessionInfo{
			ID:         s.ID,
			Project:    s.Project,
			Spec:       s.Spec(),
			Shell:      s.Shell(),
			PID:        s.PID(),
			StartedAt:  s.StartedAt(),
			Subscribed: s.Subscribed(),
			OutputTail: s.OutputTail(),
		})
	}
	return out
}

// Shutdown terminates every active terminal session and rejects new ones.
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
	slog.Info("terminal session ended", "project", s.Project, "session", s.ID)
}

func newID() (string, error) {
	var b [12]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("terminal session id: %w", err)
	}
	return "tm_" + hex.EncodeToString(b[:]), nil
}
