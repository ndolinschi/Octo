// Package secrets is the per-project secret store: values the user typed into
// a form for an agent's tool to use (decision 43). A value is written to one
// file in the project's data directory (mode 0600, atomic replace) and read
// back only by the harness when it builds a child process environment. It is
// never put in SQLite, an event, a log line, an error or the model's context:
// the API lists names, and Redact scrubs the values from text that is about
// to be stored or sent.
package secrets

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"
)

// Prefix introduces a reference to a secret ("secret:api_key") wherever an
// agent may name one.
const Prefix = "secret:"

const (
	// MinLen is the shortest value that is stored: redaction of anything
	// shorter would mangle ordinary text, so it is refused rather than left
	// unprotected.
	MinLen = 4
	// MaxLen is the longest value.
	MaxLen = 16 << 10
	// Mask replaces a value in redacted text.
	Mask = "[secret]"
	file = "secrets.json"
)

// NamePattern is what a secret's name must look like.
var NamePattern = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_.-]{0,63}$`)

var (
	ErrInvalidName  = errors.New("secrets: invalid name (letters, digits, _ . -; start with a letter; at most 64)")
	ErrInvalidValue = fmt.Errorf("secrets: a value must be %d to %d bytes and contain no NUL byte", MinLen, MaxLen)
	ErrNotFound     = errors.New("secrets: no such secret")
)

// Info is what the API shows of a secret.
type Info struct {
	Name      string `json:"name"`
	UpdatedAt string `json:"updated_at"`
}

type record struct {
	Value     string `json:"value"`
	UpdatedAt string `json:"updated_at"`
}

type project struct {
	mu   sync.Mutex
	path string
	data map[string]record
	// sorted values longest first, for Redact; rebuilt on change.
	values []string
	loaded bool
}

// Manager keeps the stores of all projects. dirOf maps a project id to its
// data directory.
type Manager struct {
	dirOf func(pid string) string

	mu       sync.Mutex
	projects map[string]*project
}

// New makes a manager.
func New(dirOf func(pid string) string) *Manager {
	return &Manager{dirOf: dirOf, projects: map[string]*project{}}
}

func (m *Manager) of(pid string) *project {
	m.mu.Lock()
	defer m.mu.Unlock()
	p := m.projects[pid]
	if p == nil {
		p = &project{path: filepath.Join(m.dirOf(pid), file)}
		m.projects[pid] = p
	}
	return p
}

// Forget drops a deleted project's cache.
func (m *Manager) Forget(pid string) {
	m.mu.Lock()
	delete(m.projects, pid)
	m.mu.Unlock()
}

func (p *project) load() error {
	if p.loaded {
		return nil
	}
	p.data = map[string]record{}
	b, err := os.ReadFile(p.path)
	switch {
	case errors.Is(err, fs.ErrNotExist):
	case err != nil:
		return err
	default:
		var f struct {
			Secrets map[string]record `json:"secrets"`
		}
		if err := json.Unmarshal(b, &f); err != nil {
			return errors.New("secrets: the secret file is damaged") // never echo its content
		}
		if f.Secrets != nil {
			p.data = f.Secrets
		}
	}
	p.loaded = true
	p.rebuild()
	return nil
}

func (p *project) rebuild() {
	p.values = p.values[:0]
	for _, r := range p.data {
		p.values = append(p.values, r.Value)
	}
	slices.SortFunc(p.values, func(a, b string) int { return len(b) - len(a) })
}

// save replaces the file atomically with mode 0600.
func (p *project) save() error {
	b, err := json.Marshal(map[string]any{"secrets": p.data})
	if err != nil {
		return err
	}
	dir := filepath.Dir(p.path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".secrets-*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	cleanup := func() { _ = os.Remove(name) }
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		cleanup()
		return err
	}
	if _, err := tmp.Write(b); err != nil {
		_ = tmp.Close()
		cleanup()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		cleanup()
		return err
	}
	if err := tmp.Close(); err != nil {
		cleanup()
		return err
	}
	if err := os.Rename(name, p.path); err != nil {
		cleanup()
		return err
	}
	if d, err := os.Open(dir); err == nil {
		_ = d.Sync()
		_ = d.Close()
	}
	return nil
}

// ValidName reports whether name can name a secret.
func ValidName(name string) bool { return NamePattern.MatchString(name) }

// Put stores (or replaces) a secret.
func (m *Manager) Put(pid, name, value string) error {
	if !ValidName(name) {
		return ErrInvalidName
	}
	if len(value) < MinLen || len(value) > MaxLen || strings.ContainsRune(value, 0) {
		return ErrInvalidValue
	}
	p := m.of(pid)
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := p.load(); err != nil {
		return err
	}
	old, had := p.data[name]
	p.data[name] = record{Value: value, UpdatedAt: time.Now().UTC().Format("2006-01-02T15:04:05.000Z07:00")}
	if err := p.save(); err != nil {
		if had {
			p.data[name] = old
		} else {
			delete(p.data, name)
		}
		return err
	}
	p.rebuild()
	return nil
}

// Delete removes a secret.
func (m *Manager) Delete(pid, name string) error {
	p := m.of(pid)
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := p.load(); err != nil {
		return err
	}
	old, ok := p.data[name]
	if !ok {
		return ErrNotFound
	}
	delete(p.data, name)
	if err := p.save(); err != nil {
		p.data[name] = old
		return err
	}
	p.rebuild()
	return nil
}

// List returns the secrets' names, sorted. Never values.
func (m *Manager) List(pid string) ([]Info, error) {
	p := m.of(pid)
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := p.load(); err != nil {
		return nil, err
	}
	out := make([]Info, 0, len(p.data))
	for n, r := range p.data {
		out = append(out, Info{Name: n, UpdatedAt: r.UpdatedAt})
	}
	slices.SortFunc(out, func(a, b Info) int { return strings.Compare(a.Name, b.Name) })
	return out, nil
}

// Has reports whether the secret exists.
func (m *Manager) Has(pid, name string) bool {
	p := m.of(pid)
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.load() != nil {
		return false
	}
	_, ok := p.data[name]
	return ok
}

// Resolve turns references (NAME -> "secret:<name>") into values for a child
// environment. The error names the variable and the secret, never a value.
func (m *Manager) Resolve(pid string, refs map[string]string) (map[string]string, error) {
	if len(refs) == 0 {
		return nil, nil
	}
	p := m.of(pid)
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := p.load(); err != nil {
		return nil, err
	}
	out := make(map[string]string, len(refs))
	for env, ref := range refs {
		name, ok := strings.CutPrefix(ref, Prefix)
		if !ok {
			return nil, fmt.Errorf("env %s: the value must be a reference %s<name>", env, Prefix)
		}
		r, ok := p.data[name]
		if !ok {
			return nil, fmt.Errorf("env %s: there is no secret named %q (ask for it with request_input)", env, name)
		}
		out[env] = r.Value
	}
	return out, nil
}

// Redact replaces every stored value in s (also as JSON-escaped) with Mask.
func (m *Manager) Redact(pid, s string) string {
	vals := m.values(pid)
	for _, v := range vals {
		if strings.Contains(s, v) {
			s = strings.ReplaceAll(s, v, Mask)
		}
		if j, err := json.Marshal(v); err == nil {
			if esc := string(j[1 : len(j)-1]); esc != v && strings.Contains(s, esc) {
				s = strings.ReplaceAll(s, esc, Mask)
			}
		}
	}
	return s
}

// RedactBytes is Redact for a JSON document.
func (m *Manager) RedactBytes(pid string, b []byte) []byte {
	if len(m.values(pid)) == 0 {
		return b
	}
	return []byte(m.Redact(pid, string(b)))
}

// MaxValueLen is the length of the longest stored value (0 without secrets).
func (m *Manager) MaxValueLen(pid string) int {
	if v := m.values(pid); len(v) > 0 {
		return len(v[0])
	}
	return 0
}

func (m *Manager) values(pid string) []string {
	p := m.of(pid)
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.load() != nil {
		return nil
	}
	return slices.Clone(p.values)
}
