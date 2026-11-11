// Package approval holds the approval requests agents raise in a supervised
// project: one pending request blocks only the agent that raised it, the user
// answers over the bridge, and the answer unblocks the agent.
package approval

import (
	"context"
	"errors"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

// Kinds of an approval.
const (
	KindWrite   = "write"
	KindCommand = "command"
	KindACP     = "acp"
)

// Decisions.
const (
	Allow        = "allow"
	AllowForTurn = "allow_for_turn"
	Deny         = "deny"
)

// DefaultTimeout is how long a request waits for an answer before it is
// denied (nobody is looking). Options.Timeout overrides it; negative: never.
const DefaultTimeout = 30 * time.Minute

var (
	// ErrNotFound: no pending approval of that id (answered, cancelled or never there).
	ErrNotFound = errors.New("approval: no such pending approval")
	// ErrInvalid: the answer is malformed.
	ErrInvalid = errors.New("approval: invalid decision")
)

// Option is one choice an ACP agent offered.
type Option struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	Kind  string `json:"kind"`
}

// DiffStat is the size of a write.
type DiffStat struct {
	Added   int `json:"added"`
	Removed int `json:"removed"`
}

// Detail is what the user needs to decide.
type Detail struct {
	Folder  string    `json:"folder,omitempty"`
	Path    string    `json:"path,omitempty"`
	Diff    *DiffStat `json:"diff,omitempty"`
	Command string    `json:"command,omitempty"`
	Options []Option  `json:"options,omitempty"`
}

// Approval is one pending request.
type Approval struct {
	ID      string `json:"id"`
	AgentID string `json:"agent_id"`
	// AgentLabel names the agent: its role, or the plugin id of an ACP agent.
	AgentLabel string `json:"agent_label"`
	TurnID     int64  `json:"turn_id"`
	Kind       string `json:"kind"`
	Title      string `json:"title"`
	Detail     Detail `json:"detail"`
	CreatedAt  string `json:"created_at"`
}

// Resolution is the user's answer (or the automatic one).
type Resolution struct {
	Decision string
	OptionID string
	Note     string
}

type item struct {
	a    Approval
	ch   chan Resolution
	done bool
}

type grantKey struct {
	turn  int64
	agent string
	key   string
}

// Manager keeps the pending approvals and the "allow for this turn" grants of
// every project.
type Manager struct {
	publish func(pid, typ string, fields map[string]any)
	changed func(pid string)
	timeout time.Duration

	mu      sync.Mutex
	pending map[string]map[string]*item // project -> id -> item
	grants  map[string]map[grantKey]bool
}

// New makes a manager. publish delivers events; changed (optional) is called
// after the set of pending approvals of a project changed.
func New(publish func(pid, typ string, fields map[string]any), changed func(pid string), timeout time.Duration) *Manager {
	if timeout == 0 {
		timeout = DefaultTimeout
	}
	return &Manager{
		publish: publish, changed: changed, timeout: timeout,
		pending: map[string]map[string]*item{}, grants: map[string]map[grantKey]bool{},
	}
}

// Request registers a, announces it and blocks until it is answered, the
// context ends (the turn was cancelled: denied) or the timeout passes (denied).
func (m *Manager) Request(ctx context.Context, pid string, a Approval) Resolution {
	a.ID, a.CreatedAt = projectstore.NewID("apr"), projectstore.Now()
	it := &item{a: a, ch: make(chan Resolution, 1)}
	m.mu.Lock()
	if m.pending[pid] == nil {
		m.pending[pid] = map[string]*item{}
	}
	m.pending[pid][a.ID] = it
	m.mu.Unlock()
	m.publish(pid, "approval.requested", map[string]any{"approval": a})
	m.notify(pid)

	var timer <-chan time.Time
	if m.timeout > 0 {
		t := time.NewTimer(m.timeout)
		defer t.Stop()
		timer = t.C
	}
	select {
	case r := <-it.ch:
		return r
	case <-ctx.Done():
		return m.autoDeny(pid, it, "the turn was cancelled")
	case <-timer:
		return m.autoDeny(pid, it, "nobody answered within "+m.timeout.String())
	}
}

// autoDeny resolves an unanswered request; if an answer slipped in first, that wins.
func (m *Manager) autoDeny(pid string, it *item, why string) Resolution {
	m.mu.Lock()
	if it.done {
		m.mu.Unlock()
		return <-it.ch
	}
	it.done = true
	delete(m.pending[pid], it.a.ID)
	m.mu.Unlock()
	m.publish(pid, "approval.resolved", map[string]any{"id": it.a.ID, "decision": Deny})
	m.notify(pid)
	return Resolution{Decision: Deny, Note: why}
}

// Resolve answers a pending approval.
func (m *Manager) Resolve(pid, id string, r Resolution) error {
	if !slices.Contains([]string{Allow, AllowForTurn, Deny}, r.Decision) {
		return ErrInvalid
	}
	m.mu.Lock()
	it := m.pending[pid][id]
	if it == nil || it.done {
		m.mu.Unlock()
		return ErrNotFound
	}
	it.done = true
	delete(m.pending[pid], id)
	m.mu.Unlock()
	it.ch <- r
	m.publish(pid, "approval.resolved", map[string]any{"id": id, "decision": r.Decision})
	m.notify(pid)
	return nil
}

// List returns the pending approvals of a project, oldest first.
func (m *Manager) List(pid string) []Approval {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]Approval, 0, len(m.pending[pid]))
	for _, it := range m.pending[pid] {
		out = append(out, it.a)
	}
	slices.SortFunc(out, func(a, b Approval) int { return strings.Compare(a.CreatedAt+a.ID, b.CreatedAt+b.ID) })
	return out
}

// Count is the number of pending approvals of a project.
func (m *Manager) Count(pid string) int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.pending[pid])
}

// Granted reports whether the agent was allowed key for the rest of the turn.
func (m *Manager) Granted(pid string, turn int64, agent, key string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.grants[pid][grantKey{turn, agent, key}]
}

// Grant allows key for the agent for the rest of the turn.
func (m *Manager) Grant(pid string, turn int64, agent, key string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.grants[pid] == nil {
		m.grants[pid] = map[grantKey]bool{}
	}
	m.grants[pid][grantKey{turn, agent, key}] = true
}

// EndTurn forgets the turn's grants.
func (m *Manager) EndTurn(pid string, turn int64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for k := range m.grants[pid] {
		if k.turn == turn {
			delete(m.grants[pid], k)
		}
	}
}

// Forget drops a deleted project's state.
func (m *Manager) Forget(pid string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.pending, pid)
	delete(m.grants, pid)
}

func (m *Manager) notify(pid string) {
	if m.changed != nil {
		m.changed(pid)
	}
}
