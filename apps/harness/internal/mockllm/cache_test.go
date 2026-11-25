package mockllm

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// convo builds a request body: sys is the system text, n user/assistant pairs
// of padding follow the first user message, and the last block of the last
// message carries a breakpoint when mark is set (plus one on the last tool and
// the system block when static is set).
func convo(sys string, n int, mark, static bool) string {
	cc := func(on bool) string {
		if on {
			return `,"cache_control":{"type":"ephemeral"}`
		}
		return ""
	}
	var msgs []string
	for i := 0; i <= n; i++ {
		last := i == n
		msgs = append(msgs, fmt.Sprintf(`{"role":"user","content":[{"type":"text","text":"question %d %s"%s}]}`,
			i, strings.Repeat("padding ", 50), cc(mark && last)))
		if !last {
			msgs = append(msgs, fmt.Sprintf(`{"role":"assistant","content":[{"type":"text","text":"answer %d"}]}`, i))
		}
	}
	return fmt.Sprintf(`{"model":"m","system":[{"type":"text","text":%q%s}],"tools":[{"name":"list_dir"},{"name":"read_file"%s}],"messages":[%s]}`,
		"Role: Tester\n"+sys, cc(static), cc(static), strings.Join(msgs, ","))
}

type cacheUsage struct{ in, read, write int }

func send(t *testing.T, h http.Handler, body string) cacheUsage {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/v1/messages", strings.NewReader(body)))
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body)
	}
	var out struct {
		Usage struct {
			In    int `json:"input_tokens"`
			Read  int `json:"cache_read_input_tokens"`
			Write int `json:"cache_creation_input_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return cacheUsage{out.Usage.In, out.Usage.Read, out.Usage.Write}
}

func TestCacheUsage(t *testing.T) {
	tests := []struct {
		name  string
		steps []string
		check func(t *testing.T, got []cacheUsage)
	}{
		{
			name:  "no breakpoints report zeros every time",
			steps: []string{convo("a", 1, false, false), convo("a", 2, false, false), convo("a", 2, false, false)},
			check: func(t *testing.T, got []cacheUsage) {
				for i, u := range got {
					if u.read != 0 || u.write != 0 || u.in == 0 {
						t.Errorf("request %d = %+v, want zero cache and non-zero input", i, u)
					}
				}
			},
		},
		{
			name:  "growing conversation writes then reads",
			steps: []string{convo("a", 1, true, true), convo("a", 2, true, true), convo("a", 3, true, true)},
			check: func(t *testing.T, got []cacheUsage) {
				if got[0].read != 0 || got[0].write == 0 {
					t.Errorf("first request = %+v, want a cache write and no read", got[0])
				}
				for i := 1; i < len(got); i++ {
					if got[i].read == 0 {
						t.Errorf("request %d = %+v, want cache_read > 0", i, got[i])
					}
					if got[i].read < got[i-1].read {
						t.Errorf("request %d read %d shrank from %d", i, got[i].read, got[i-1].read)
					}
					if got[i].write == 0 || got[i].write >= got[i].read {
						t.Errorf("request %d = %+v, want a small write for the new turn only", i, got[i])
					}
				}
			},
		},
		{
			name:  "identical request is a full read",
			steps: []string{convo("a", 2, true, true), convo("a", 2, true, true)},
			check: func(t *testing.T, got []cacheUsage) {
				if got[1].read != got[0].write || got[1].write != 0 {
					t.Errorf("repeat = %+v after %+v, want read == first write and no write", got[1], got[0])
				}
			},
		},
		{
			name:  "changed system text invalidates the prefix",
			steps: []string{convo("a", 2, true, true), convo("b", 3, true, true)},
			check: func(t *testing.T, got []cacheUsage) {
				// Only the tools block, which precedes the system prompt, can still hit.
				if got[1].read == 0 || got[1].read >= got[0].write/2 {
					t.Errorf("request after a system change read %d tokens, want only the small tools prefix (first write %d)", got[1].read, got[0].write)
				}
			},
		},
		{
			name:  "only the message breakpoint still reads the previous turn",
			steps: []string{convo("a", 1, true, false), convo("a", 2, true, false)},
			check: func(t *testing.T, got []cacheUsage) {
				if got[1].read == 0 {
					t.Errorf("second = %+v, want a read", got[1])
				}
			},
		},
		{
			name:  "another model does not share the cache",
			steps: []string{convo("a", 2, true, true), strings.Replace(convo("a", 2, true, true), `"model":"m"`, `"model":"other"`, 1)},
			check: func(t *testing.T, got []cacheUsage) {
				if got[1].read != 0 || got[1].write == 0 {
					t.Errorf("got %+v, want the other model to start cold", got)
				}
			},
		},
		{
			name:  "static breakpoints alone cache tools and system",
			steps: []string{convo("a", 1, false, true), convo("a", 4, false, true)},
			check: func(t *testing.T, got []cacheUsage) {
				if got[0].write == 0 || got[1].read != got[0].write {
					t.Errorf("got %+v, want second read == first write (static prefix only)", got)
				}
			},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			h := New(0) // fresh server, fresh cache
			var got []cacheUsage
			for _, body := range tc.steps {
				got = append(got, send(t, h, body))
			}
			tc.check(t, got)
			for i, u := range got {
				if u.in < 0 {
					t.Errorf("request %d: negative input_tokens %d", i, u.in)
				}
			}
		})
	}
}

func TestCacheUsage_Streamed(t *testing.T) {
	h := New(0)
	stream := func(body string) map[string]any {
		body = strings.Replace(body, `"model":"m"`, `"model":"m","stream":true`, 1)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/v1/messages", strings.NewReader(body)))
		for _, block := range strings.Split(rec.Body.String(), "\n\n") {
			if !strings.HasPrefix(block, "event: message_start") {
				continue
			}
			var ev struct {
				Message struct {
					Usage map[string]any `json:"usage"`
				} `json:"message"`
			}
			if err := json.Unmarshal([]byte(strings.SplitN(block, "data: ", 2)[1]), &ev); err != nil {
				t.Fatal(err)
			}
			return ev.Message.Usage
		}
		t.Fatal("no message_start")
		return nil
	}
	first := stream(convo("a", 1, true, true))
	second := stream(convo("a", 2, true, true))
	if first["cache_creation_input_tokens"].(float64) == 0 || second["cache_read_input_tokens"].(float64) == 0 {
		t.Fatalf("streamed usage = %v then %v, want a write then a read", first, second)
	}
}
