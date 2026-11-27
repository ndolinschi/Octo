// Package agentlogin runs an agent's own login command (claude auth login,
// codex login, ...) in a PTY and watches whether the login took. It reads no
// output and logs none: the terminal's frames go straight to the client.
package agentlogin

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"sync"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
	"github.com/ndolinschi/Octo/apps/harness/internal/terminal"
)

// Project is the pseudo-project key logins run under, so they never appear in a
// real project's terminal or process lists.
const Project = ":agent-login"

// Defaults of Options.
const (
	DefaultPollEvery = 5 * time.Second
	DefaultMaxLife   = 10 * time.Minute
	checkTimeout     = 30 * time.Second
)

// ErrNotFound: no such login (never started, closed, or replaced by a newer one).
var ErrNotFound = errors.New("no such login")

// UnavailableError: the agent has no login command Octo can run, or it did not start.
type UnavailableError struct {
	Label, Command, Reason string
}

func (e *UnavailableError) Error() string { return "login unavailable: " + e.Reason }

// NotInstalledError: the agent's program is not on this machine (or is too
// old), so there is no login to run. Agent carries what the catalogue error needs.
type NotInstalledError struct{ Agent plugins.Agent }

func (e *NotInstalledError) Error() string { return "agent not installed: " + e.Agent.ID }

// Agents is what the service needs of the plugin registry.
type Agents interface {
	Agent(id string) (plugins.Agent, bool)
	Recheck(ctx context.Context, id string) (plugins.Agent, bool)
}

// Terminals is the PTY session manager (terminal.Manager).
type Terminals interface {
	Start(ctx context.Context, project string, spec terminal.Spec) (*terminal.Session, error)
	Get(project, id string) (*terminal.Session, error)
	Close(project, id string) error
}

// Options tunes the service; zero values take the defaults.
type Options struct {
	PollEvery time.Duration // login check period while the command runs
	MaxLife   time.Duration // hard stop of a login command
	Home      func() string // folder a default account's login runs in
}

// Request is POST /v1/providers/{id}/login.
type Request struct {
	Method     string
	Cols, Rows int
}

// Service starts and watches logins, one per agent id at a time.
type Service struct {
	ctx    context.Context
	agents Agents
	terms  Terminals
	opts   Options

	mu     sync.Mutex
	logins map[string]*Login
}

// New makes the service. ctx ends the checks (not the processes: close the terminal manager for those).
func New(ctx context.Context, agents Agents, terms Terminals, opts Options) *Service {
	if opts.PollEvery <= 0 {
		opts.PollEvery = DefaultPollEvery
	}
	if opts.MaxLife <= 0 {
		opts.MaxLife = DefaultMaxLife
	}
	if opts.Home == nil {
		opts.Home = func() string { h, _ := os.UserHomeDir(); return h }
	}
	return &Service{ctx: ctx, agents: agents, terms: terms, opts: opts, logins: map[string]*Login{}}
}

// Start runs the agent's login command in a PTY, closing the agent's previous login.
func (s *Service) Start(ctx context.Context, agentID string, req Request) (*Login, error) {
	a, ok := s.agents.Agent(agentID)
	if !ok {
		return nil, fmt.Errorf("%w: unknown agent %s", ErrNotFound, agentID)
	}
	if a.Unsupported == "" && (!a.Available || a.VersionTooOld) {
		return nil, &NotInstalledError{Agent: a}
	}
	label := a.Label
	if label == "" {
		label = a.ID
	}
	command, args, env, ok := a.LoginSpec(req.Method)
	if !ok {
		return nil, &UnavailableError{Label: label, Command: a.LoginCmd(), Reason: "the agent has no login command to run" + methodNote(req.Method)}
	}
	sess, err := s.terms.Start(ctx, Project, terminal.Spec{
		Name: "login", Folder: agentID, Command: command, Args: args, Env: env, Dir: s.dirOf(a), Cols: req.Cols, Rows: req.Rows,
	})
	switch {
	case errors.Is(err, terminal.ErrTooManySessions), errors.Is(err, terminal.ErrShutdown), errors.Is(err, context.Canceled):
		return nil, err
	case err != nil:
		return nil, &UnavailableError{Label: label, Command: a.LoginCmd(), Reason: err.Error()}
	}
	l := newLogin(agentID, a.LoginCmd(), sess)
	s.mu.Lock()
	old := s.logins[agentID]
	s.logins[agentID] = l
	s.mu.Unlock()
	if old != nil {
		old.sess.Close("replaced by a newer login")
	}
	slog.Info("agent login started", "agent", agentID, "session", l.ID)
	go s.watch(l)
	return l, nil
}

func methodNote(m string) string {
	if m == "" {
		return ""
	}
	return " named " + m
}

// dirOf is the folder the login runs in: the account's, else the home folder.
func (s *Service) dirOf(a plugins.Agent) string {
	if a.AccountOf != "" && a.AccountDir != "" {
		return a.AccountDir
	}
	return s.opts.Home()
}

// Get returns the agent's current login when its id is id.
func (s *Service) Get(agentID, id string) (*Login, error) {
	s.mu.Lock()
	l := s.logins[agentID]
	s.mu.Unlock()
	if l == nil || l.ID != id {
		return nil, ErrNotFound
	}
	if _, err := s.terms.Get(Project, id); err != nil {
		s.mu.Lock()
		if s.logins[agentID] == l {
			delete(s.logins, agentID)
		}
		s.mu.Unlock()
		return nil, ErrNotFound
	}
	return l, nil
}

// Close stops the login's process (the final check still runs and is published).
func (s *Service) Close(agentID, id string) error {
	l, err := s.Get(agentID, id)
	if err != nil {
		return err
	}
	l.sess.Close("closed by client")
	return nil
}
