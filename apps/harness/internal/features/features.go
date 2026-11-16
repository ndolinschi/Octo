// Package features holds process-wide feature flags read from the environment
// (and harness.env) at startup and updated live through settings.
package features

import (
	"os"
	"slices"
	"strconv"
	"strings"
	"sync"
)

// Feature flag identifiers exposed in /v1/config ("features") and governed by
// HARNESS_FEATURE_* settings.
const (
	AutoMemory = "auto_memory"
)

// Def describes one built-in feature flag.
type Def struct {
	ID          string
	Env         string
	Label       string
	Description string
	Default     bool
}

var defs = []Def{
	{
		ID:          AutoMemory,
		Env:         "HARNESS_FEATURE_AUTO_MEMORY",
		Label:       "Auto-memory prompt & digest",
		Description: "Prompt to save remembered items when project auto-memory is off and digest completed turns when allowed.",
		Default:     true,
	},
}

// Defs returns all defined feature flags in display order.
func Defs() []Def { return slices.Clone(defs) }

// Store keeps the live boolean state of each feature flag.
type Store struct {
	mu    sync.RWMutex
	flags map[string]bool
}

// NewStore initializes the feature store using lookup (default os.LookupEnv).
func NewStore(lookup func(string) (string, bool)) *Store {
	if lookup == nil {
		lookup = os.LookupEnv
	}
	flags := make(map[string]bool, len(defs))
	for _, d := range defs {
		val := d.Default
		if raw, ok := lookup(d.Env); ok && strings.TrimSpace(raw) != "" {
			if b, err := strconv.ParseBool(strings.TrimSpace(raw)); err == nil {
				val = b
			}
		}
		flags[d.ID] = val
	}
	return &Store{flags: flags}
}

// Enabled reports whether the feature flag id is currently on. Unknown flags
// return false; a nil Store treats known flags according to their default.
func (s *Store) Enabled(id string) bool {
	if s == nil {
		for _, d := range defs {
			if d.ID == id {
				return d.Default
			}
		}
		return false
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.flags[id]
}

// Set updates the live state of flag id (ignored if unknown).
func (s *Store) Set(id string, on bool) {
	if s == nil {
		return
	}
	for _, d := range defs {
		if d.ID == id {
			s.mu.Lock()
			s.flags[id] = on
			s.mu.Unlock()
			return
		}
	}
}

// Snapshot returns a copy of all feature flag states.
func (s *Store) Snapshot() map[string]bool {
	out := make(map[string]bool, len(defs))
	if s == nil {
		for _, d := range defs {
			out[d.ID] = d.Default
		}
		return out
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	for k, v := range s.flags {
		out[k] = v
	}
	return out
}
