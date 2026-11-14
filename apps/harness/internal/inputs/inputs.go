// Package inputs holds the forms agents open with the request_input tool: a
// pending form blocks only the agent that raised it until the user submits or
// skips it. The manager never sees a secret's destination: the caller stores
// secret values and passes on only what the model may know.
package inputs

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"sync"

	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
	"github.com/ndolinschi/Octo/apps/harness/internal/secrets"
)

// Field kinds.
const (
	KindSecret  = "secret"
	KindText    = "text"
	KindSelect  = "select"
	KindConfirm = "confirm"
	KindPath    = "path"
)

// Limits of a form.
const (
	MaxFields    = 8
	MaxOptions   = 24
	MaxTextBytes = 16 << 10
)

// Statuses of an answered form.
const (
	StatusSubmitted = "submitted"
	StatusSkipped   = "skipped"
	StatusCancelled = "cancelled"
)

var fieldID = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_.-]{0,63}$`)

var (
	// ErrNotFound: no such open form.
	ErrNotFound = errors.New("inputs: no such open form")
)

// ValidationError is a refused submission or schema; it names fields, never values.
type ValidationError struct{ Msg string }

func (e *ValidationError) Error() string { return e.Msg }

func bad(format string, args ...any) error { return &ValidationError{fmt.Sprintf(format, args...)} }

// Field is one input of a form.
type Field struct {
	ID       string   `json:"id"`
	Label    string   `json:"label"`
	Kind     string   `json:"kind"`
	Options  []string `json:"options,omitempty"`
	Required bool     `json:"required,omitempty"`
	Help     string   `json:"help,omitempty"`
}

// Input is an open form.
type Input struct {
	ID      string `json:"id"`
	AgentID string `json:"agent_id"`
	// SessionID is the main session whose turn asks (schema 15).
	SessionID  string  `json:"session_id,omitempty"`
	AgentLabel string  `json:"agent_label"`
	TurnID     int64   `json:"turn_id"`
	Title      string  `json:"title"`
	Reason     string  `json:"reason"`
	Fields     []Field `json:"fields"`
	CreatedAt  string  `json:"created_at"`
}

// Answer is what the user submitted: Skip, or Values by field id (strings;
// booleans for confirm fields).
type Answer struct {
	Skip   bool           `json:"skip"`
	Values map[string]any `json:"values"`
}

// Result is a validated answer.
type Result struct {
	Status string
	// Values are the non-secret fields' values (text, select, path as strings, confirm as bool).
	Values map[string]any
	// Secrets are the secret fields' values by field id. They go to the secret
	// store and nowhere else.
	Secrets map[string]string
}

// Validate checks a form schema.
func Validate(title string, fields []Field) error {
	if strings.TrimSpace(title) == "" || len(title) > 200 {
		return bad("title is required (at most 200 characters)")
	}
	if len(fields) == 0 || len(fields) > MaxFields {
		return bad("a form takes 1 to %d fields", MaxFields)
	}
	seen := map[string]bool{}
	for _, f := range fields {
		switch {
		case !fieldID.MatchString(f.ID):
			return bad("field id %q must start with a letter and use letters, digits, _ . - (at most 64)", f.ID)
		case seen[f.ID]:
			return bad("duplicate field id %q", f.ID)
		case strings.TrimSpace(f.Label) == "":
			return bad("field %q needs a label", f.ID)
		case !slices.Contains([]string{KindSecret, KindText, KindSelect, KindConfirm, KindPath}, f.Kind):
			return bad("field %q: kind must be secret, text, select, confirm or path", f.ID)
		case f.Kind == KindSelect && (len(f.Options) == 0 || len(f.Options) > MaxOptions):
			return bad("field %q: a select takes 1 to %d options", f.ID, MaxOptions)
		case f.Kind != KindSelect && len(f.Options) > 0:
			return bad("field %q: only select fields take options", f.ID)
		}
		seen[f.ID] = true
	}
	return nil
}

// check validates an answer against the form. Messages name fields only.
func check(in Input, a Answer) (Result, error) {
	if a.Skip {
		return Result{Status: StatusSkipped}, nil
	}
	res := Result{Status: StatusSubmitted, Values: map[string]any{}, Secrets: map[string]string{}}
	byID := map[string]Field{}
	for _, f := range in.Fields {
		byID[f.ID] = f
	}
	for id := range a.Values {
		if _, ok := byID[id]; !ok {
			return res, bad("unknown field %q", id)
		}
	}
	for _, f := range in.Fields {
		v, given := a.Values[f.ID]
		if f.Kind == KindConfirm {
			b, isBool := v.(bool)
			if given && !isBool {
				return res, bad("field %q takes true or false", f.ID)
			}
			if !given && f.Required {
				return res, bad("field %q is required", f.ID)
			}
			if given {
				res.Values[f.ID] = b
			}
			continue
		}
		s, isStr := v.(string)
		if given && !isStr {
			return res, bad("field %q takes a string", f.ID)
		}
		if strings.TrimSpace(s) == "" {
			if f.Required {
				return res, bad("field %q is required", f.ID)
			}
			continue
		}
		if len(s) > MaxTextBytes {
			return res, bad("field %q is too long", f.ID)
		}
		switch f.Kind {
		case KindSelect:
			if !slices.Contains(f.Options, s) {
				return res, bad("field %q: not one of the options", f.ID)
			}
		case KindSecret:
			if len(s) < secrets.MinLen {
				return res, bad("field %q: a secret needs at least %d characters", f.ID, secrets.MinLen)
			}
			if !secrets.ValidName(f.ID) {
				return res, bad("field %q cannot name a secret", f.ID)
			}
			res.Secrets[f.ID] = s
			continue
		}
		res.Values[f.ID] = s
	}
	return res, nil
}

type item struct {
	in   Input
	ch   chan Result
	done bool
}

// Manager keeps the open forms of every project.
type Manager struct {
	publish func(pid, typ string, fields map[string]any)
	changed func(pid string)

	mu      sync.Mutex
	pending map[string]map[string]*item
}

// New makes a manager. changed (optional) runs after a project's set of open
// forms changed.
func New(publish func(pid, typ string, fields map[string]any), changed func(pid string)) *Manager {
	return &Manager{publish: publish, changed: changed, pending: map[string]map[string]*item{}}
}

// Request opens the form and blocks until it is submitted or skipped, or ctx
// ends (the turn was cancelled: the result is cancelled and ctx.Err() is
// returned too).
func (m *Manager) Request(ctx context.Context, pid string, in Input) (Result, error) {
	in.ID, in.CreatedAt = projectstore.NewID("inp"), projectstore.Now()
	it := &item{in: in, ch: make(chan Result, 1)}
	m.mu.Lock()
	if m.pending[pid] == nil {
		m.pending[pid] = map[string]*item{}
	}
	m.pending[pid][in.ID] = it
	m.mu.Unlock()
	m.publish(pid, "input.requested", map[string]any{"input": in})
	m.notify(pid)
	select {
	case r := <-it.ch:
		return r, nil
	case <-ctx.Done():
		m.mu.Lock()
		if it.done {
			m.mu.Unlock()
			return <-it.ch, nil
		}
		it.done = true
		delete(m.pending[pid], in.ID)
		m.mu.Unlock()
		m.publish(pid, "input.resolved", map[string]any{"id": in.ID, "status": StatusCancelled, "provided": []string{}, "values": map[string]any{}})
		m.notify(pid)
		return Result{Status: StatusCancelled}, ctx.Err()
	}
}

// Submit validates and delivers the user's answer. The returned Result carries
// the secrets so the caller can store them; the event published here does not.
// store runs before the agent is released, so the value is in place when it continues.
func (m *Manager) Submit(pid, id string, a Answer, store func(Result) error) error {
	m.mu.Lock()
	it := m.pending[pid][id]
	m.mu.Unlock()
	if it == nil {
		return ErrNotFound
	}
	res, err := check(it.in, a)
	if err != nil {
		return err
	}
	m.mu.Lock()
	if it.done {
		m.mu.Unlock()
		return ErrNotFound
	}
	it.done = true
	delete(m.pending[pid], id)
	m.mu.Unlock()
	if store != nil {
		if err := store(res); err != nil {
			// The form stays open: nothing was lost, the user can submit again.
			m.mu.Lock()
			it.done = false
			m.pending[pid][id] = it
			m.mu.Unlock()
			return err
		}
	}
	provided := make([]string, 0, len(res.Secrets))
	for id := range res.Secrets {
		provided = append(provided, id)
	}
	slices.Sort(provided)
	vals := res.Values
	if vals == nil {
		vals = map[string]any{}
	}
	it.ch <- res
	m.publish(pid, "input.resolved", map[string]any{"id": id, "status": res.Status, "provided": provided, "values": vals})
	m.notify(pid)
	return nil
}

// List returns the open forms of a project, oldest first.
func (m *Manager) List(pid string) []Input {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]Input, 0, len(m.pending[pid]))
	for _, it := range m.pending[pid] {
		out = append(out, it.in)
	}
	slices.SortFunc(out, func(a, b Input) int { return strings.Compare(a.CreatedAt+a.ID, b.CreatedAt+b.ID) })
	return out
}

// Count is the number of open forms of a project.
func (m *Manager) Count(pid string) int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.pending[pid])
}

// Forget drops a deleted project's state.
func (m *Manager) Forget(pid string) {
	m.mu.Lock()
	delete(m.pending, pid)
	m.mu.Unlock()
}

func (m *Manager) notify(pid string) {
	if m.changed != nil {
		m.changed(pid)
	}
}
