package orchestrator

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/acp"
	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
)

// DefaultSideIdle is how long a side conversation's ACP session may sit unused
// before its agent process is closed.
const DefaultSideIdle = 15 * time.Minute

// ErrNoProvider means nothing can answer a side question: the side model needs
// the built-in loop and it has no key, or it names an ACP agent that cannot run.
var ErrNoProvider = errors.New("orchestrator: nothing can answer a side question")

func noProvider(detail string) error {
	if detail == "" {
		return ErrNoProvider
	}
	return fmt.Errorf("%w: %s", ErrNoProvider, detail)
}

// sideHost keeps the ACP sessions of side conversations: at most one per
// project, separate from the orchestrator's session (own process, own ACP
// session), kept for follow-ups and closed on clear, on project delete, on
// shutdown and when idle.
type sideHost struct {
	mu       sync.Mutex
	sessions map[string]*sideSession
}

func newSideHost() *sideHost { return &sideHost{sessions: map[string]*sideSession{}} }

// sideSession is one project's side-conversation agent.
type sideSession struct {
	mu       sync.Mutex
	pluginID string
	model    string // acpTarget.recorded()
	cwd      string
	client   *acp.Client
	sessID   string
	mode     string // the agent's own read-only mode in use ("" none advertised)
	// costSeen and usedSeen are the agent's last cumulative usage counters.
	costSeen float64
	usedSeen int64
	busy     bool
	lastUsed time.Time
}

func (h *sideHost) session(pid string) *sideSession {
	h.mu.Lock()
	defer h.mu.Unlock()
	s := h.sessions[pid]
	if s == nil {
		s = &sideSession{}
		h.sessions[pid] = s
	}
	return s
}

func (s *sideSession) aliveLocked() bool {
	if s.client == nil {
		return false
	}
	select {
	case <-s.client.Done():
		return false
	default:
		return true
	}
}

func (s *sideSession) closeLocked() {
	if s.client != nil {
		s.client.Close()
		s.client = nil
	}
	s.sessID, s.mode = "", ""
	s.costSeen, s.usedSeen = 0, 0
}

// now is the orchestrator's clock (Options.Clock, else the wall clock).
func (o *Orchestrator) now() time.Time {
	if o.opts.Clock != nil {
		return o.opts.Clock()
	}
	return time.Now()
}

func (o *Orchestrator) sideIdle() time.Duration {
	if o.opts.SideIdle > 0 {
		return o.opts.SideIdle
	}
	return DefaultSideIdle
}

// CloseSide stops a running side question and ends the project's
// side-conversation agent, if any (the side conversation was cleared, or the
// project is deleted).
func (o *Orchestrator) CloseSide(projectID string) {
	o.CancelSide(projectID)
	o.side.mu.Lock()
	s := o.side.sessions[projectID]
	delete(o.side.sessions, projectID)
	o.side.mu.Unlock()
	if s != nil {
		s.mu.Lock()
		s.closeLocked()
		s.mu.Unlock()
	}
}

// SideSessionOpen reports whether the project has a live side-conversation
// agent process.
func (o *Orchestrator) SideSessionOpen(projectID string) bool {
	o.side.mu.Lock()
	s := o.side.sessions[projectID]
	o.side.mu.Unlock()
	if s == nil {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.aliveLocked()
}

// reapSide closes side sessions unused for longer than the idle limit.
func (o *Orchestrator) reapSide() {
	o.side.mu.Lock()
	all := make(map[string]*sideSession, len(o.side.sessions))
	for pid, s := range o.side.sessions {
		all[pid] = s
	}
	o.side.mu.Unlock()
	now, idle := o.now(), o.sideIdle()
	for pid, s := range all {
		s.mu.Lock()
		if s.client != nil && !s.busy && now.Sub(s.lastUsed) >= idle {
			slog.Info("side conversation idle; closing its agent", "project", pid, "agent", s.pluginID)
			s.closeLocked()
		}
		s.mu.Unlock()
	}
}

func (o *Orchestrator) reapSideLoop(ctx context.Context) {
	t := time.NewTicker(min(max(o.sideIdle()/4, 10*time.Millisecond), 30*time.Second))
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			o.reapSide()
		}
	}
}

// sideRoute decides what answers the project's side question. isACP is true
// when the side conversation runs on an ACP agent: models.side names one, or
// models.side is empty and the orchestrator is an ACP agent (the side question
// follows the project). Otherwise it runs on the Messages API, which needs the
// built-in loop; without it the error is ErrNoProvider.
func (rt *runtime) sideRoute() (t acpTarget, isACP bool, err error) {
	model := rt.models.Side
	if model == "" && rt.isACPOrchestrator() {
		model = rt.models.Orchestrator
	}
	if id, m, ok := plugins.ParseACPRef(model); ok {
		target, msg := rt.pickACPAgent(id, m)
		if msg != "" {
			return acpTarget{}, true, noProvider(msg)
		}
		return target, true, nil
	}
	if rt.o.builtinOff() != "" {
		return acpTarget{}, false, noProvider("")
	}
	return acpTarget{}, false, nil
}

// closeAll ends every side agent process (shutdown).
func (h *sideHost) closeAll() {
	h.mu.Lock()
	all := h.sessions
	h.sessions = map[string]*sideSession{}
	h.mu.Unlock()
	for _, s := range all {
		s.mu.Lock()
		s.closeLocked()
		s.mu.Unlock()
	}
}
