package bridge_test

import (
	"net/http"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/orchestrator"
	"github.com/ndolinschi/Octo/apps/harness/internal/project"
)

// A conversation of three user messages is three orchestrator requests. With
// prompt caching the mock reports a cache write on the first and cache reads from
// the second on, and /v1/usage carries those tokens; with caching off it reports
// none.
func TestCacheTokensFlowToUsage(t *testing.T) {
	tests := []struct {
		name    string
		opts    orchestrator.Options
		caching bool
	}{
		{"prompt caching on (default)", orchestrator.Options{}, true},
		{"prompt caching off", orchestrator.Options{NoPromptCaching: true}, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			s := buildUsageStack(t, opusOnlyPrices, false, tc.opts, nil)
			var p struct{ ID string }
			s.into(t, http.MethodPost, "/v1/projects", map[string]any{"name": "cache"}, http.StatusCreated, &p)

			var cum []project.UsageBucket // cumulative total after each message
			for _, msg := range []string{"a quick question", "another quick question", "one more quick question"} {
				s.post(t, p.ID, msg)
				cum = append(cum, s.report(t, map[string]string{"group": "model", "project": p.ID}).Total)
			}
			for i, c := range cum {
				if c.Requests != int64(i+1) {
					t.Fatalf("after message %d: %d requests, want %d (one orchestrator request per quick turn)", i+1, c.Requests, i+1)
				}
			}
			delta := func(i int) (read, write int64) {
				r, w := cum[i].CacheReadTokens, cum[i].CacheWriteTokens
				if i > 0 {
					r, w = r-cum[i-1].CacheReadTokens, w-cum[i-1].CacheWriteTokens
				}
				return r, w
			}
			for i := range cum {
				read, write := delta(i)
				switch {
				case !tc.caching:
					if read != 0 || write != 0 {
						t.Errorf("request %d: cache read/write = %d/%d with caching off", i+1, read, write)
					}
				case i == 0:
					if read != 0 || write == 0 {
						t.Errorf("request 1: cache read/write = %d/%d, want a write and no read", read, write)
					}
				default:
					if read == 0 {
						t.Errorf("request %d: cache_read = 0, want > 0 from the second request on", i+1)
					}
				}
			}
			total := cum[len(cum)-1]
			if tc.caching && (total.CacheReadTokens == 0 || total.CacheWriteTokens == 0) {
				t.Errorf("/v1/usage total = %+v, want cache read and write tokens", total)
			}
		})
	}
}
