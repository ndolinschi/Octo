package providers

import (
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
)

// CacheFile is the advertised-models cache inside the data directory.
const CacheFile = "agent-models.json"

const (
	maxCachedModels = 200
	// rewriteEvery bounds how often a session that advertised the same models
	// as before rewrites the file (only the timestamps differ).
	rewriteEvery = 10 * time.Minute
)

// advertised is what one agent offered. Last is the latest session's list;
// Order is every model ever seen, the latest list first; Seen maps a model to
// the last time (RFC 3339) a session advertised it.
type advertised struct {
	At      string            `json:"at,omitempty"`
	Current string            `json:"current,omitempty"`
	Last    []string          `json:"last,omitempty"`
	Order   []string          `json:"order,omitempty"`
	Seen    map[string]string `json:"seen,omitempty"`
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

// sanitize drops ids that could not be a model id and bounds the size: the file
// is plain data on disk and is not trusted.
func sanitize(a advertised) advertised {
	keep := func(in []string) []string {
		var out []string
		for _, id := range in {
			if plugins.ModelPattern.MatchString(id) && !slices.Contains(out, id) && len(out) < maxCachedModels {
				out = append(out, id)
			}
		}
		return out
	}
	a.Last, a.Order = keep(a.Last), keep(a.Order)
	seen := map[string]string{}
	for id, at := range a.Seen {
		if slices.Contains(a.Order, id) {
			seen[id] = at
		}
	}
	a.Seen = seen
	if !plugins.ModelPattern.MatchString(a.Current) {
		a.Current = ""
	}
	return a
}

func (c *cache) get(id string) advertised {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.agents[id]
}

// record stores one session's advertised models; it reports whether the lists
// or the current model changed (not merely when they were seen).
func (c *cache) record(agentID string, models []string, current string) bool {
	if agentID == "" {
		return false
	}
	last := sanitize(advertised{Last: models, Order: models}).Last
	if len(last) == 0 {
		return false
	}
	if !plugins.ModelPattern.MatchString(current) {
		current = ""
	}
	at := c.now().UTC().Format(time.RFC3339)

	c.mu.Lock()
	old := c.agents[agentID]
	next := advertised{At: at, Current: current, Last: last, Seen: map[string]string{}}
	for id, t := range old.Seen {
		next.Seen[id] = t
	}
	for _, id := range last {
		next.Seen[id] = at
	}
	next.Order = slices.Clone(last)
	for _, id := range old.Order {
		if !slices.Contains(next.Order, id) && len(next.Order) < maxCachedModels {
			next.Order = append(next.Order, id)
		}
	}
	changed := !slices.Equal(old.Last, next.Last) || !slices.Equal(old.Order, next.Order) || old.Current != next.Current
	c.agents[agentID] = next
	write := changed || c.now().Sub(c.lastWrite) >= rewriteEvery
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
