// Package limits remembers the most recent rate-limit headers each provider
// returned, per model and limit kind. State is in memory only.
package limits

import (
	"cmp"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Kind is the quantity a limit applies to.
type Kind string

const (
	Requests     Kind = "requests"
	Tokens       Kind = "tokens"
	InputTokens  Kind = "input_tokens"
	OutputTokens Kind = "output_tokens"
)

var kindOrder = []Kind{Requests, Tokens, InputTokens, OutputTokens}

// Limit is one observed rate limit. Nil fields were absent or malformed.
type Limit struct {
	Provider   string  `json:"provider"`
	Model      string  `json:"model"`
	Kind       Kind    `json:"kind"`
	Limit      *int64  `json:"limit"`
	Remaining  *int64  `json:"remaining"`
	ResetsAt   *string `json:"resets_at"`
	ObservedAt string  `json:"observed_at"`
}

type key struct {
	provider, model string
	kind            Kind
}

// Store is safe for concurrent use.
type Store struct {
	now func() time.Time
	mu  sync.Mutex
	m   map[key]Limit
}

func NewStore() *Store { return &Store{now: time.Now, m: map[key]Limit{}} }

// Observe records the rate-limit headers of one response. A response without
// recognised headers leaves earlier values untouched; otherwise each kind it
// reports replaces the previous value for the same provider, model and kind.
func (s *Store) Observe(provider, model string, h http.Header) {
	observed := s.now().UTC()
	found := Parse(h, observed)
	if len(found) == 0 {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, l := range found {
		l.Provider, l.Model = provider, model
		s.m[key{provider, model, l.Kind}] = l
	}
}

// Snapshot returns the current limits ordered by provider, model, kind.
func (s *Store) Snapshot() []Limit {
	s.mu.Lock()
	out := make([]Limit, 0, len(s.m))
	for _, l := range s.m {
		out = append(out, l)
	}
	s.mu.Unlock()
	slices.SortFunc(out, func(a, b Limit) int {
		return cmp.Or(
			strings.Compare(a.Provider, b.Provider),
			strings.Compare(a.Model, b.Model),
			slices.Index(kindOrder, a.Kind)-slices.Index(kindOrder, b.Kind),
		)
	})
	return out
}

// Parse extracts limits from response headers: the anthropic-ratelimit-*
// family when present, else x-ratelimit-*. Provider and Model are left empty.
func Parse(h http.Header, observed time.Time) []Limit {
	at := observed.UTC().Format(time.RFC3339)
	var out []Limit
	for _, k := range kindOrder {
		name := strings.ReplaceAll(string(k), "_", "-")
		if l, ok := build(k, at, observed, h.Get("anthropic-ratelimit-"+name+"-limit"),
			h.Get("anthropic-ratelimit-"+name+"-remaining"), h.Get("anthropic-ratelimit-"+name+"-reset")); ok {
			out = append(out, l)
		}
	}
	if len(out) > 0 {
		return out
	}
	for _, k := range []Kind{Requests, Tokens} {
		name := string(k)
		if l, ok := build(k, at, observed, h.Get("x-ratelimit-limit-"+name),
			h.Get("x-ratelimit-remaining-"+name), h.Get("x-ratelimit-reset-"+name)); ok {
			out = append(out, l)
		}
	}
	return out
}

func build(k Kind, at string, observed time.Time, limit, remaining, reset string) (Limit, bool) {
	l := Limit{Kind: k, ObservedAt: at, Limit: parseInt(limit), Remaining: parseInt(remaining), ResetsAt: parseReset(reset, observed)}
	return l, l.Limit != nil || l.Remaining != nil || l.ResetsAt != nil
}

func parseInt(v string) *int64 {
	n, err := strconv.ParseInt(strings.TrimSpace(v), 10, 64)
	if err != nil || n < 0 {
		return nil
	}
	return &n
}

// parseReset accepts an RFC 3339 time or a Go-style duration ("1s", "6m0s")
// counted from the observation time.
func parseReset(v string, observed time.Time) *string {
	v = strings.TrimSpace(v)
	if v == "" {
		return nil
	}
	if t, err := time.Parse(time.RFC3339, v); err == nil {
		s := t.UTC().Format(time.RFC3339)
		return &s
	}
	if d, err := time.ParseDuration(v); err == nil && d >= 0 {
		s := observed.Add(d).UTC().Format(time.RFC3339)
		return &s
	}
	return nil
}
