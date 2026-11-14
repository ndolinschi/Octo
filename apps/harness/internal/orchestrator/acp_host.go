package orchestrator

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/acp"
	"github.com/ndolinschi/Octo/apps/harness/internal/mcp"
	"github.com/ndolinschi/Octo/apps/harness/internal/tools"
	"github.com/ndolinschi/Octo/apps/harness/internal/usererr"
)

// DefaultACPIdle is how long an ACP orchestrator session may sit unused before
// its agent process is shut down (HARNESS_ACP_IDLE overrides it).
const DefaultACPIdle = 30 * time.Minute

// acpHost owns the long-lived ACP sessions of ACP-run orchestrators: at most
// one per main session (keyed by skey), started lazily by the session's first
// turn, kept between turns, restarted when the process dies and closed when
// idle, when too many of a project's are alive, on project delete and on shutdown.
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

// orchSession is one main session's orchestrator process. mu guards every field;
// turns of a session never overlap (the orchestrator's claim), but MCP calls
// from the agent and the idle reaper run concurrently with them.
type orchSession struct {
	h        *acpHost
	pid, sid string

	// digestMu is held while a digest prompt (memory M6) is open in the live session;
	// the next turn waits for it before it prompts.
	digestMu sync.Mutex

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
	noMCP *usererr.Error
	// modes are the session modes the agent advertised when the session was
	// created, baseMode the one it started in and curMode the one in use.
	modes    []acp.SessionMode
	baseMode string
	curMode  string

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
	// tasksSeen is when a window-mode session last got task records ("" before its first turn).
	tasksSeen string

	// unbriefed: the session is new and no prompt has carried the briefing yet (the first
	// prompt was a slash command, which is sent bare).
	unbriefed bool

	// The agent's advertised slash commands; kept apart from mu (the agent's reader goroutine
	// writes them while a close holds mu).
	cmu       sync.Mutex
	cmds      []acp.Command
	cmdsAgent string
	cmdsSet   bool

	busy     bool
	lastUsed time.Time
}

func (h *acpHost) session(key string) *orchSession {
	h.mu.Lock()
	defer h.mu.Unlock()
	s := h.sessions[key]
	if s == nil {
		pid, sid := splitKey(key)
		s = &orchSession{h: h, pid: pid, sid: sid}
		h.sessions[key] = s
	}
	return s
}

func (h *acpHost) lookup(key string) *orchSession {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.sessions[key]
}

// trim shuts down the least recently used idle processes of a project while more than limit are alive (the
// sessions resume with session/load or the recap next time).
func (h *acpHost) trim(pid string, limit int) {
	h.mu.Lock()
	var mine []*orchSession
	for k, s := range h.sessions {
		if ofProject(k, pid) {
			mine = append(mine, s)
		}
	}
	h.mu.Unlock()
	type idle struct {
		s    *orchSession
		used time.Time
	}
	alive, candidates := 0, []idle{}
	for _, s := range mine {
		s.mu.Lock()
		if s.aliveLocked() {
			alive++
			if !s.busy {
				candidates = append(candidates, idle{s, s.lastUsed})
			}
		}
		s.mu.Unlock()
	}
	for alive > limit && len(candidates) > 0 {
		oldest := 0
		for i, c := range candidates {
			if c.used.Before(candidates[oldest].used) {
				oldest = i
			}
		}
		c := candidates[oldest]
		candidates = append(candidates[:oldest], candidates[oldest+1:]...)
		c.s.mu.Lock()
		if c.s.aliveLocked() && !c.s.busy {
			slog.Info("too many acp orchestrator processes in the project; shutting the least recently used down", "project", pid, "session", c.s.sid)
			c.s.closeLocked()
			alive--
		}
		c.s.mu.Unlock()
	}
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
	s.unbriefed = false
	s.modes, s.baseMode, s.curMode = nil, "", ""
	s.costSeen, s.usedSeen = 0, 0 // the counters belong to the session that ended
}

// CloseProject ends the project's ACP orchestrator process, if any (project
// delete). It is safe to call at any time.
func (o *Orchestrator) CloseProject(projectID string) {
	o.CloseSide(projectID)
	o.dropTracker(projectID)
	o.approvals.Forget(projectID)
	o.inputs.Forget(projectID)
	o.secrets.Forget(projectID)
	o.acp.mu.Lock()
	var mine []*orchSession
	for k, s := range o.acp.sessions {
		if ofProject(k, projectID) {
			mine = append(mine, s)
			delete(o.acp.sessions, k)
		}
	}
	o.acp.mu.Unlock()
	for _, s := range mine {
		s.mu.Lock()
		if s.turnCancel != nil {
			s.turnCancel()
		}
		s.closeLocked()
		s.mu.Unlock()
	}
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

// warning is the standing warning of a main session's ACP process (nil when none).
func (h *acpHost) warning(key string) *usererr.Error {
	s := h.lookup(key)
	if s == nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.noMCP
}
