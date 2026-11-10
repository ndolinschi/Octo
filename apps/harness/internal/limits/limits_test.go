package limits

import (
	"net/http"
	"sync"
	"testing"
	"time"
)

var t0 = time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC)

func hdr(kv ...string) http.Header {
	h := http.Header{}
	for i := 0; i < len(kv); i += 2 {
		h.Set(kv[i], kv[i+1])
	}
	return h
}

func p64(n int64) *int64    { return &n }
func pstr(s string) *string { return &s }

func TestParse(t *testing.T) {
	tests := []struct {
		name string
		h    http.Header
		want []Limit
	}{
		{"no headers", hdr(), nil},
		{"unrelated headers", hdr("content-type", "application/json"), nil},
		{
			"anthropic style with RFC 3339 reset",
			hdr("anthropic-ratelimit-requests-limit", "50", "anthropic-ratelimit-requests-remaining", "49",
				"anthropic-ratelimit-requests-reset", "2026-11-10T12:01:00Z",
				"anthropic-ratelimit-input-tokens-limit", "30000", "anthropic-ratelimit-input-tokens-remaining", "29000"),
			[]Limit{
				{Kind: Requests, Limit: p64(50), Remaining: p64(49), ResetsAt: pstr("2026-11-10T12:01:00Z")},
				{Kind: InputTokens, Limit: p64(30000), Remaining: p64(29000)},
			},
		},
		{
			"x-ratelimit style with duration resets",
			hdr("x-ratelimit-limit-requests", "100", "x-ratelimit-remaining-requests", "99", "x-ratelimit-reset-requests", "1s",
				"x-ratelimit-limit-tokens", "1000", "x-ratelimit-remaining-tokens", "900", "x-ratelimit-reset-tokens", "6m0s"),
			[]Limit{
				{Kind: Requests, Limit: p64(100), Remaining: p64(99), ResetsAt: pstr("2026-11-10T12:00:01Z")},
				{Kind: Tokens, Limit: p64(1000), Remaining: p64(900), ResetsAt: pstr("2026-11-10T12:06:00Z")},
			},
		},
		{
			"x-ratelimit without reset",
			hdr("x-ratelimit-limit-requests", "100", "x-ratelimit-remaining-requests", "7"),
			[]Limit{{Kind: Requests, Limit: p64(100), Remaining: p64(7)}},
		},
		{
			"anthropic wins over x-ratelimit",
			hdr("anthropic-ratelimit-tokens-remaining", "5", "x-ratelimit-remaining-requests", "9"),
			[]Limit{{Kind: Tokens, Remaining: p64(5)}},
		},
		{
			"malformed values are ignored, valid ones kept",
			hdr("anthropic-ratelimit-requests-limit", "many", "anthropic-ratelimit-requests-remaining", "3",
				"anthropic-ratelimit-requests-reset", "soon"),
			[]Limit{{Kind: Requests, Remaining: p64(3)}},
		},
		{"only malformed values", hdr("anthropic-ratelimit-requests-limit", "x", "anthropic-ratelimit-requests-reset", "-5s"), nil},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := Parse(tc.h, t0)
			if len(got) != len(tc.want) {
				t.Fatalf("got %d limits (%+v), want %d", len(got), got, len(tc.want))
			}
			for i, w := range tc.want {
				g := got[i]
				if g.Kind != w.Kind || !eqInt(g.Limit, w.Limit) || !eqInt(g.Remaining, w.Remaining) || !eqStr(g.ResetsAt, w.ResetsAt) {
					t.Errorf("limit %d = %s %v %v %v, want %s %v %v %v", i, g.Kind, deref(g.Limit), deref(g.Remaining), g.ResetsAt, w.Kind, deref(w.Limit), deref(w.Remaining), w.ResetsAt)
				}
				if g.ObservedAt != "2026-11-10T12:00:00Z" {
					t.Errorf("observed_at = %q", g.ObservedAt)
				}
			}
		})
	}
}

func deref(p *int64) any {
	if p == nil {
		return nil
	}
	return *p
}

func eqInt(a, b *int64) bool  { return (a == nil) == (b == nil) && (a == nil || *a == *b) }
func eqStr(a, b *string) bool { return (a == nil) == (b == nil) && (a == nil || *a == *b) }

func TestStoreReplacesAndKeys(t *testing.T) {
	s := NewStore()
	now := t0
	s.now = func() time.Time { return now }

	s.Observe("api.example", "m1", hdr("anthropic-ratelimit-requests-remaining", "10"))
	s.Observe("api.example", "m2", hdr("anthropic-ratelimit-requests-remaining", "20"))
	s.Observe("api.example", "m1", hdr("anthropic-ratelimit-tokens-remaining", "300"))
	got := s.Snapshot()
	if len(got) != 3 {
		t.Fatalf("snapshot = %+v, want 3 entries (m1 requests, m1 tokens, m2 requests)", got)
	}

	now = t0.Add(time.Minute)
	s.Observe("api.example", "m1", hdr("anthropic-ratelimit-requests-remaining", "9"))
	s.Observe("api.example", "m1", hdr("content-type", "x")) // no headers: keeps earlier values
	got = s.Snapshot()
	if len(got) != 3 {
		t.Fatalf("snapshot after replace = %+v", got)
	}
	first := got[0]
	if first.Model != "m1" || first.Kind != Requests || *first.Remaining != 9 || first.ObservedAt != "2026-11-10T12:01:00Z" {
		t.Fatalf("m1 requests = %+v, want the later observation", first)
	}
	if got[1].Kind != Tokens || got[2].Model != "m2" {
		t.Fatalf("order = %+v, want provider, model, kind", got)
	}
}

func TestStoreConcurrent(t *testing.T) {
	s := NewStore()
	var wg sync.WaitGroup
	for range 16 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for range 50 {
				s.Observe("p", "m", hdr("x-ratelimit-remaining-requests", "1", "x-ratelimit-reset-requests", "1s"))
				_ = s.Snapshot()
			}
		}()
	}
	wg.Wait()
	if len(s.Snapshot()) != 1 {
		t.Fatal("want a single entry")
	}
}
