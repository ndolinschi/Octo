package orchestrator_test

import (
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/config"
	"github.com/ndolinschi/Octo/apps/harness/internal/fakerouter"
	"github.com/ndolinschi/Octo/apps/harness/internal/orchestrator"
)

// reportingLLM answers every request with a short text and the given usage.
func reportingLLM(in, cacheRead, cacheWrite int) http.Handler {
	return fakeLLM(func(w http.ResponseWriter, _ *http.Request, _ fakeReq) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"id":"m","type":"message","role":"assistant","model":"x","content":[{"type":"text","text":"ok"}],`+
			`"stop_reason":"end_turn","usage":{"input_tokens":%d,"output_tokens":2,"cache_read_input_tokens":%d,"cache_creation_input_tokens":%d}}`,
			in, cacheRead, cacheWrite)
	})
}

type ctxReport struct {
	AgentID      string `json:"agent_id"`
	Model        string `json:"model"`
	WindowTokens *int64 `json:"window_tokens"`
	UsedTokens   int64  `json:"used_tokens"`
	Estimated    bool   `json:"estimated"`
	Parts        []struct {
		Key    string `json:"key"`
		Tokens int64  `json:"tokens"`
	} `json:"parts"`
}

func (a *api) context(pid, query string) ctxReport {
	a.t.Helper()
	status, body := a.do("GET", "/v1/projects/"+pid+"/context"+query, nil)
	if status != 200 {
		a.t.Fatalf("context = %d %v", status, body)
	}
	var rep ctxReport
	if err := remarshal(body, &rep); err != nil {
		a.t.Fatal(err)
	}
	return rep
}

func (c ctxReport) part(key string) int64 {
	for _, p := range c.Parts {
		if p.Key == key {
			return p.Tokens
		}
	}
	return -1
}

func (c ctxReport) check(t *testing.T) {
	t.Helper()
	keys := []string{"system", "tools", "notes", "messages", "tool_results", "summary"}
	if len(c.Parts) != len(keys) {
		t.Fatalf("parts = %+v, want keys %v", c.Parts, keys)
	}
	var sum int64
	for i, p := range c.Parts {
		if p.Key != keys[i] || p.Tokens < 0 {
			t.Fatalf("part %d = %+v, want key %s and non-negative tokens", i, p, keys[i])
		}
		sum += p.Tokens
	}
	if sum != c.UsedTokens {
		t.Fatalf("parts sum to %d, used_tokens = %d", sum, c.UsedTokens)
	}
}

func TestContextEndpoint(t *testing.T) {
	for _, tc := range []struct {
		name      string
		llm       http.Handler
		windows   config.ContextWindows
		runTurn   bool
		wantUsed  int64 // 0: the estimate
		estimated bool
		window    *int64
	}{
		{"no usage yet: estimated, unknown model has no window", reportingLLM(10, 0, 0), nil, false, 0, true, nil},
		{"reported input plus cache read and write", reportingLLM(1000, 500, 100), nil, true, 1600, false, nil},
		{"configured window for the orchestrator's model", reportingLLM(4000, 0, 0), config.ContextWindows{"claude-sonnet-5-5": 200000}, true, 4000, false, ptr(200000)},
		{"a window for another model does not apply", reportingLLM(4000, 0, 0), config.ContextWindows{"other": 5}, true, 4000, false, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := newRigWith(t, tc.llm, orchestrator.Options{Windows: tc.windows})
			pid := r.project(t, 1)
			if tc.runTurn {
				if st := r.run(t, pid, "quick hello", nil); st != "completed" {
					t.Fatalf("turn = %s", st)
				}
			}
			rep := r.api(t).context(pid, "")
			rep.check(t)
			if rep.AgentID != r.agents(t, pid)[0].ID || rep.Model != "claude-sonnet-5-5" {
				t.Fatalf("agent/model = %s/%s", rep.AgentID, rep.Model)
			}
			if rep.Estimated != tc.estimated || (tc.wantUsed != 0 && rep.UsedTokens != tc.wantUsed) || rep.UsedTokens <= 0 {
				t.Fatalf("used = %d estimated = %v, want %d / %v", rep.UsedTokens, rep.Estimated, tc.wantUsed, tc.estimated)
			}
			if (rep.WindowTokens == nil) != (tc.window == nil) || (tc.window != nil && *rep.WindowTokens != *tc.window) {
				t.Fatalf("window = %v, want %v", rep.WindowTokens, tc.window)
			}
			if rep.part("system") <= 0 || rep.part("tools") <= 0 {
				t.Fatalf("system and tools must always count: %+v", rep.Parts)
			}
			if tc.runTurn && rep.part("messages") <= 0 {
				t.Fatalf("messages part empty after a turn: %+v", rep.Parts)
			}
			if !tc.runTurn && (rep.part("messages") != 0 || rep.part("summary") != 0) {
				t.Fatalf("fresh project has messages or summary: %+v", rep.Parts)
			}
		})
	}
}

func ptr(n int64) *int64 { return &n }

// bigUsage is compactingUpstream with a large reported input, so a split into
// parts has room to show.
func bigUsage(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		next.ServeHTTP(&usageRewriter{ResponseWriter: w}, r)
	})
}

type usageRewriter struct{ http.ResponseWriter }

func (u *usageRewriter) Write(b []byte) (int, error) {
	out := strings.Replace(string(b), `"input_tokens":3,`, `"input_tokens":6000,`, 1)
	return u.ResponseWriter.Write([]byte(out))
}

func TestContextParts(t *testing.T) {
	r, _ := newFakeRig(t, bigUsage(compactingUpstream()), fakerouter.Options{CompactAt: 3}, orchestrator.Options{})
	pid := r.project(t, 1)
	a := r.api(t)
	r.run(t, pid, "first", nil)
	// The orchestrator saved no note yet; tool results exist only before compaction.
	rep := a.context(pid, "")
	rep.check(t)
	if rep.part("summary") <= 0 || rep.part("notes") <= 0 {
		t.Fatalf("after a compaction the summary counts, and the empty-notes block is still sent: %+v", rep.Parts)
	}
	if rep.Estimated {
		t.Fatalf("a response followed the compaction, so used_tokens is reported: %+v", rep)
	}

	before := rep.part("notes")
	status, _ := a.do("POST", "/v1/projects/"+pid+"/notes", map[string]string{"title": "Plan", "content": strings.Repeat("note text ", 400)})
	if status != 201 {
		t.Fatalf("create note = %d", status)
	}
	after := a.context(pid, "")
	after.check(t)
	// Reported total unchanged, so the split moves toward notes.
	if after.UsedTokens != rep.UsedTokens || after.part("notes") <= before {
		t.Fatalf("notes part %d -> %d with used %d -> %d", before, after.part("notes"), rep.UsedTokens, after.UsedTokens)
	}
}

func TestContextOfSubAgentAndErrors(t *testing.T) {
	r := newRig(t, reportingLLM(10, 0, 0))
	pid := r.project(t, 1)
	a := r.api(t)
	for _, tc := range []struct {
		name, path string
		status     int
	}{
		{"unknown project", "/v1/projects/nope/context", 404},
		{"unknown agent", "/v1/projects/" + pid + "/context?agent=nope", 404},
	} {
		if status, _ := a.do("GET", tc.path, nil); status != tc.status {
			t.Errorf("%s: status = %d, want %d", tc.name, status, tc.status)
		}
	}
	orch := r.agents(t, pid)[0]
	rep := a.context(pid, "?agent="+orch.ID)
	rep.check(t)
	if rep.AgentID != orch.ID {
		t.Fatalf("agent = %s", rep.AgentID)
	}
}

func TestContextOfSubAgent(t *testing.T) {
	r := newRig(t, fakeLLM(func(w http.ResponseWriter, _ *http.Request, req fakeReq) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case req.isOrchestrator() && len(req.Msgs) == 1:
			fmt.Fprint(w, `{"id":"m","type":"message","role":"assistant","model":"x","content":[`+spawnBlock("t1", "worker")+`],"stop_reason":"tool_use","usage":{"input_tokens":50,"output_tokens":2}}`)
		case req.isOrchestrator():
			fmt.Fprint(w, `{"id":"m","type":"message","role":"assistant","model":"x","content":[`+textBlock("done")+`],"stop_reason":"end_turn","usage":{"input_tokens":70,"output_tokens":2}}`)
		default:
			fmt.Fprint(w, `{"id":"m","type":"message","role":"assistant","model":"x","content":[`+textBlock("child report")+`],"stop_reason":"end_turn","usage":{"input_tokens":33,"output_tokens":2}}`)
		}
	}))
	pid := r.project(t, 1)
	if st := r.run(t, pid, "go", nil); st != "completed" {
		t.Fatalf("turn = %s", st)
	}
	agents := r.agents(t, pid)
	a := r.api(t)
	child := a.context(pid, "?agent="+agents[1].ID)
	child.check(t)
	if child.UsedTokens != 33 || child.Estimated || child.part("notes") != 0 {
		t.Fatalf("child = %+v, want reported 33 and no notes", child)
	}
	if orch := a.context(pid, ""); orch.UsedTokens != 70 || orch.part("notes") <= 0 {
		t.Fatalf("orchestrator = %+v, want reported 70 and a notes block", orch)
	}
}
