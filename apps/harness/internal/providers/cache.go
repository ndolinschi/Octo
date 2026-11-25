package providers

import (
	"context"
	"encoding/json"
	"log/slog"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
)

// CacheFile is the per-agent models cache inside the data directory: what the
// agents advertised, what a models command printed, the names the user typed
// and when models were last looked for.
const CacheFile = "agent-models.json"

const (
	maxCachedModels = 200
	// rewriteEvery bounds how often a session that advertised the same models
	// as before rewrites the file (only the timestamps differ).
	rewriteEvery = 10 * time.Minute
)

// advertised is what is known about one agent's models. Last is the latest
// session's list; Order is every model ever seen, the latest list first; Seen
// maps a model to the last time (RFC 3339) a session advertised it. Labels name
// some of them. Cmd is what the manifest's models command printed last, Custom
// the names the user typed. RefreshedAt is the last model discovery (RFC 3339)
// and Error why it failed ("" when it worked).
type advertised struct {
	At          string            `json:"at,omitempty"`
	Current     string            `json:"current,omitempty"`
	Last        []string          `json:"last,omitempty"`
	Order       []string          `json:"order,omitempty"`
	Seen        map[string]string `json:"seen,omitempty"`
	Labels      map[string]string `json:"labels,omitempty"`
	Cmd         []string          `json:"cmd,omitempty"`
	Custom      []string          `json:"custom,omitempty"`
	RefreshedAt string            `json:"refreshed_at,omitempty"`
	Error       string            `json:"error,omitempty"`
	// Preferred and Roles are the user's choices (nil / absent key: not set, the
	// manifest's hint or the agent's default applies; "" is an explicit "agent default").
	Preferred *string           `json:"preferred,omitempty"`
	Roles     map[string]string `json:"roles,omitempty"`
}

// ModelInfo is a model id with an optional display name.
type ModelInfo struct {
	ID    string
	Label string
}

type cacheFile struct {
	Version int                   `json:"version"`
	Agents  map[string]advertised `json:"agents"`
}

type cache struct {
	dir string
	now func() time.Time

	mu        sync.Mutex
	agents    map[string]advertised
	lastWrite time.Time
}

func loadCache(dir string, now func() time.Time) *cache {
	c := &cache{dir: dir, now: now, agents: map[string]advertised{}}
	if dir == "" {
		return c
	}
	raw, err := os.ReadFile(filepath.Join(dir, CacheFile))
	if err != nil {
		return c
	}
	var f cacheFile
	if err := json.Unmarshal(raw, &f); err != nil || f.Version != 1 {
		slog.Warn("ignoring the advertised-models cache", "file", CacheFile)
		return c
	}
	for id, a := range f.Agents {
		c.agents[id] = sanitize(a)
	}
	return c
}

// MaxCustomModels is how many custom model names one agent keeps.
const MaxCustomModels = 50

// maxCustomLen is the longest custom model name.
const maxCustomLen = 80

// ValidCustomModel reports whether name may be stored as a custom model: 1 to
// 80 characters, none of them whitespace or a control character, and a first
// character that is a letter or digit (the name ends up in process arguments).
func ValidCustomModel(name string) bool {
	return len(name) <= maxCustomLen && plugins.ModelPattern.MatchString(name)
}

// sanitize drops ids that could not be a model id and bounds the size: the file
// is plain data on disk and is not trusted.
func sanitize(a advertised) advertised {
	keep := func(in []string, ok func(string) bool, limit int) []string {
		var out []string
		for _, id := range in {
			if ok(id) && !slices.Contains(out, id) && len(out) < limit {
				out = append(out, id)
			}
		}
		return out
	}
	valid := plugins.ModelPattern.MatchString
	a.Last, a.Order = keep(a.Last, valid, maxCachedModels), keep(a.Order, valid, maxCachedModels)
	a.Cmd, a.Custom = keep(a.Cmd, valid, maxCachedModels), keep(a.Custom, ValidCustomModel, MaxCustomModels)
	seen := map[string]string{}
	for id, at := range a.Seen {
		if slices.Contains(a.Order, id) {
			seen[id] = at
		}
	}
	a.Seen = seen
	labels := map[string]string{}
	for id, l := range a.Labels {
		if l = cleanLabel(l); l != "" && l != id && (slices.Contains(a.Order, id) || slices.Contains(a.Cmd, id)) {
			labels[id] = l
		}
	}
	a.Labels = labels
	if !plugins.ModelPattern.MatchString(a.Current) {
		a.Current = ""
	}
	a.Error = cleanLabel(a.Error)
	if a.Preferred != nil && *a.Preferred != "" && !ValidCustomModel(*a.Preferred) {
		a.Preferred = nil
	}
	roles := map[string]string{}
	for tier, m := range a.Roles {
		if slices.Contains(plugins.RoleTiers(), tier) && (m == "" || ValidCustomModel(m)) {
			roles[tier] = m
		}
	}
	a.Roles = roles
	return a
}

// cleanLabel trims a display name or message: no control characters, at most
// 200 characters.
func cleanLabel(l string) string {
	l = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, l)
	l = strings.TrimSpace(l)
	if r := []rune(l); len(r) > 200 {
		l = string(r[:200])
	}
	return l
}

func (c *cache) get(id string) advertised {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.agents[id]
}

// update applies fn to one agent's entry. fn returns the new entry, whether the
// visible picture changed, and whether the file must be written now (else it is
// written when changed, or when rewriteEvery has passed). It reports changed.
func (c *cache) update(agentID string, fn func(old advertised) (next advertised, changed, force bool)) bool {
	if agentID == "" {
		return false
	}
	c.mu.Lock()
	next, changed, force := fn(c.agents[agentID])
	c.agents[agentID] = next
	write := changed || force || c.now().Sub(c.lastWrite) >= rewriteEvery
	var snap cacheFile
	if write && c.dir != "" {
		snap = cacheFile{Version: 1, Agents: make(map[string]advertised, len(c.agents))}
		for id, a := range c.agents {
			snap.Agents[id] = a
		}
		c.lastWrite = c.now()
	}
	c.mu.Unlock()

	if write && c.dir != "" {
		if err := writeCache(c.dir, snap); err != nil {
			slog.Warn("cannot write the advertised-models cache", "err", err)
		}
	}
	return changed
}

func labelsOf(models []ModelInfo) map[string]string {
	out := map[string]string{}
	for _, m := range models {
		if l := cleanLabel(m.Label); l != "" && l != m.ID {
			out[m.ID] = l
		}
	}
	return out
}

func idsOf(models []ModelInfo) []string {
	out := make([]string, len(models))
	for i, m := range models {
		out[i] = m.ID
	}
	return out
}

// record stores one session's advertised models; it reports whether the lists,
// labels or the current model changed (not merely when they were seen).
func (c *cache) record(agentID string, models []ModelInfo, current string) bool {
	last := sanitize(advertised{Last: idsOf(models), Order: idsOf(models)}).Last
	if len(last) == 0 {
		return false
	}
	if !plugins.ModelPattern.MatchString(current) {
		current = ""
	}
	at := c.now().UTC().Format(time.RFC3339)
	fresh := labelsOf(models)
	return c.update(agentID, func(old advertised) (advertised, bool, bool) {
		next := old
		next.At, next.Current, next.Last, next.Seen = at, current, last, map[string]string{}
		maps.Copy(next.Seen, old.Seen)
		for _, id := range last {
			next.Seen[id] = at
		}
		next.Order = slices.Clone(last)
		for _, id := range old.Order {
			if !slices.Contains(next.Order, id) && len(next.Order) < maxCachedModels {
				next.Order = append(next.Order, id)
			}
		}
		next.Labels = maps.Clone(old.Labels)
		if next.Labels == nil {
			next.Labels = map[string]string{}
		}
		for _, id := range last {
			delete(next.Labels, id)
			if l, ok := fresh[id]; ok {
				next.Labels[id] = l
			}
		}
		changed := !slices.Equal(old.Last, next.Last) || !slices.Equal(old.Order, next.Order) || old.Current != next.Current ||
			!maps.Equal(old.Labels, next.Labels) && (len(old.Labels) > 0 || len(next.Labels) > 0)
		return next, changed, false
	})
}

// setCommand stores what the models command printed.
func (c *cache) setCommand(agentID string, models []ModelInfo) bool {
	ids := sanitize(advertised{Cmd: idsOf(models), Order: idsOf(models)}).Cmd
	fresh := labelsOf(models)
	return c.update(agentID, func(old advertised) (advertised, bool, bool) {
		next := old
		next.Cmd = ids
		next.Labels = maps.Clone(old.Labels)
		if next.Labels == nil {
			next.Labels = map[string]string{}
		}
		for _, id := range old.Cmd {
			delete(next.Labels, id)
		}
		for _, id := range ids {
			delete(next.Labels, id)
			if l, ok := fresh[id]; ok {
				next.Labels[id] = l
			}
		}
		changed := !slices.Equal(old.Cmd, next.Cmd) || !maps.Equal(old.Labels, next.Labels) && (len(old.Labels) > 0 || len(next.Labels) > 0)
		return next, changed, false
	})
}

// setCustom replaces the custom model names of an agent.
func (c *cache) setCustom(agentID string, names []string) bool {
	return c.update(agentID, func(old advertised) (advertised, bool, bool) {
		next := old
		next.Custom = sanitize(advertised{Custom: names}).Custom
		return next, !slices.Equal(old.Custom, next.Custom), true
	})
}

// setPrefs stores the user's preferred model and role models; a nil preferred
// and absent roles are left as they were.
func (c *cache) setPrefs(agentID string, preferred *string, roles map[string]string) bool {
	return c.update(agentID, func(old advertised) (advertised, bool, bool) {
		next := old
		if preferred != nil {
			p := *preferred
			next.Preferred = &p
		}
		next.Roles = maps.Clone(old.Roles)
		if next.Roles == nil {
			next.Roles = map[string]string{}
		}
		maps.Copy(next.Roles, roles)
		same := preferredOf(old) == preferredOf(next) && (old.Preferred == nil) == (next.Preferred == nil) && maps.Equal(old.Roles, next.Roles)
		return next, !same, true
	})
}

// markRefresh notes a model discovery: when it ran and why it failed ("" when
// it did not). It reports whether the error changed.
func (c *cache) markRefresh(agentID string, at time.Time, errText string) bool {
	errText = cleanLabel(errText)
	return c.update(agentID, func(old advertised) (advertised, bool, bool) {
		next := old
		next.RefreshedAt, next.Error = at.UTC().Format(time.RFC3339), errText
		return next, old.Error != errText, true
	})
}

func writeCache(dir string, f cacheFile) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, CacheFile+".*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer os.Remove(name)
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(raw); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(name, filepath.Join(dir, CacheFile))
}

// Watch refreshes the picture every interval until ctx ends, which catches
// what no hook reports (the router answering or going away). The first
// refresh happens at once, only to remember the picture.
func (s *Service) Watch(ctx context.Context, interval time.Duration) {
	s.mu.Lock()
	s.bg = ctx
	s.mu.Unlock()
	s.Refresh()
	go func() {
		t := time.NewTicker(interval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				s.Refresh()
			}
		}
	}()
}
