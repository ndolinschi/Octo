package orchestrator

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/acp"
	"github.com/ndolinschi/Octo/apps/harness/internal/mcp"
	"github.com/ndolinschi/Octo/apps/harness/internal/tools"
)

// DefaultACPIdle is how long an ACP orchestrator session may sit unused before
// its agent process is shut down (HARNESS_ACP_IDLE overrides it).
const DefaultACPIdle = 30 * time.Minute

// acpHost owns the long-lived ACP sessions of ACP-run orchestrators: at most
// one per project, started lazily by the first turn, kept between turns,
// restarted when the process dies and closed when idle, on project delete and
// on shutdown.
type acpHost struct {
	idle   time.Duration
	tokens *mcp.Tokens

	mu       sync.Mutex
	sessions map[string]*orchSession
}

func newACPHost(idle time.Duration) *acpHost {
	if idle <= 0 {
		idle = DefaultACPIdle
	}
	return &acpHost{idle: idle, tokens: mcp.NewTokens(), sessions: map[string]*orchSession{}}
}

// orchSession is one project's orchestrator session. mu guards every field;
// turns of a project never overlap (the orchestrator's claim), but MCP calls
// from the agent and the idle reaper run concurrently with them.
type orchSession struct {
	h   *acpHost
	pid string

	mu sync.Mutex
	// What the live process was started for.
	pluginID string
	model    string // acpTarget.recorded()
	cwd      string
	client   *acp.Client
	sessID   string
	token    string
	// noMCP is set when the agent got no harness tools; the text is the
	// warning shown on every turn of the session.
	noMCP string

	// Turn state (valid while turnCtx != nil).
	agentID    string // the project's orchestrator agent row
	rt         *runtime
	reg        *tools.Registry
	handler    *acpSession
	turnCtx    context.Context
	turnCancel context.CancelFunc
	fatal      error
	notesSent  string // hash of the notes block the agent last saw
	// costSeen and usedSeen are the agent's last cumulative usage counters.
	costSeen float64
	usedSeen int64

	busy     bool
	lastUsed time.Time
}

func (h *acpHost) session(pid string) *orchSession {
	h.mu.Lock()
	defer h.mu.Unlock()
	s := h.sessions[pid]
	if s == nil {
		s = &orchSession{h: h, pid: pid}
		h.sessions[pid] = s
	}
	return s
}

func (h *acpHost) lookup(pid string) *orchSession {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.sessions[pid]
}

// alive reports whether the process is running and its connection is up.
func (s *orchSession) aliveLocked() bool {
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

// closeLocked ends the process (reaping it) and revokes the MCP token. The
// stored ACP session id is kept so a later process can session/load it.
func (s *orchSession) closeLocked() {
	// Revoke first: the agent must not be able to call in while it is dying.
	if s.token != "" {
		s.h.tokens.Revoke(s.token)
		s.token = ""
	}
	if s.client != nil {
		s.client.Close()
		s.client = nil
	}
	s.sessID = ""
	s.costSeen, s.usedSeen = 0, 0 // the counters belong to the session that ended
}

// CloseProject ends the project's ACP orchestrator process, if any (project
// delete). It is safe to call at any time.
func (o *Orchestrator) CloseProject(projectID string) {
	o.dropTracker(projectID)
	o.approvals.Forget(projectID)
	o.inputs.Forget(projectID)
	o.secrets.Forget(projectID)
	o.acp.mu.Lock()
	s := o.acp.sessions[projectID]
	delete(o.acp.sessions, projectID)
	o.acp.mu.Unlock()
	if s == nil {
		return
	}
	s.mu.Lock()
	if s.turnCancel != nil {
		s.turnCancel()
	}
	s.closeLocked()
	s.mu.Unlock()
}

// closeAll ends every ACP orchestrator process (shutdown).
func (h *acpHost) closeAll() {
	h.mu.Lock()
	all := h.sessions
	h.sessions = map[string]*orchSession{}
	h.mu.Unlock()
	for _, s := range all {
		s.mu.Lock()
		s.closeLocked()
		s.mu.Unlock()
	}
}

// reap closes sessions idle longer than the limit, until ctx ends.
func (h *acpHost) reap(ctx context.Context) {
	tick := min(max(h.idle/4, 10*time.Millisecond), 30*time.Second)
	t := time.NewTicker(tick)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		h.mu.Lock()
		all := make([]*orchSession, 0, len(h.sessions))
		for _, s := range h.sessions {
			all = append(all, s)
		}
		h.mu.Unlock()
		for _, s := range all {
			s.mu.Lock()
			if s.client != nil && !s.busy && time.Since(s.lastUsed) >= h.idle {
				slog.Info("acp orchestrator idle; shutting its agent down", "project", s.pid, "agent", s.pluginID)
				s.closeLocked()
			}
			s.mu.Unlock()
		}
	}
}

// warning is the standing warning of the project's ACP session ("" when none).
func (h *acpHost) warning(pid string) string {
	s := h.lookup(pid)
	if s == nil {
		return ""
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.noMCP
}
