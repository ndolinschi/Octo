package memory

import (
	"encoding/json"
	"fmt"
)

// Context modes of the orchestrator.
const (
	ContextFull   = "full"
	ContextWindow = "window"
)

// DefaultRecentExchanges is how many recent user messages (with their replies)
// the window mode sends verbatim.
const DefaultRecentExchanges = 5

// MaxRecentExchanges bounds the setting.
const MaxRecentExchanges = 20

// Settings is a project's `memory` setting.
type Settings struct {
	// Context is "full" (the whole transcript, today's behaviour, the default)
	// or "window" (assembled from blocks with caps).
	Context         string `json:"context"`
	RecentExchanges int    `json:"recent_exchanges"`
}

// ParseSettings reads the stored JSON; absent fields take the defaults.
func ParseSettings(raw string) Settings {
	s := Settings{}
	if raw != "" {
		_ = json.Unmarshal([]byte(raw), &s)
	}
	if s.Context != ContextWindow {
		s.Context = ContextFull
	}
	if s.RecentExchanges < 1 || s.RecentExchanges > MaxRecentExchanges {
		s.RecentExchanges = DefaultRecentExchanges
	}
	return s
}

// Validate checks a setting a client sent.
func (s Settings) Validate() error {
	if s.Context != "" && s.Context != ContextFull && s.Context != ContextWindow {
		return fmt.Errorf("memory.context must be %q or %q", ContextFull, ContextWindow)
	}
	if s.RecentExchanges != 0 && (s.RecentExchanges < 1 || s.RecentExchanges > MaxRecentExchanges) {
		return fmt.Errorf("memory.recent_exchanges must be between 1 and %d", MaxRecentExchanges)
	}
	return nil
}

// Merge overlays the fields set in over onto s.
func (s Settings) Merge(over Settings) Settings {
	if over.Context != "" {
		s.Context = over.Context
	}
	if over.RecentExchanges != 0 {
		s.RecentExchanges = over.RecentExchanges
	}
	return s
}

// JSON is the stored form.
func (s Settings) JSON() string {
	b, _ := json.Marshal(s)
	return string(b)
}
