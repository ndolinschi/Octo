package orchestrator

import (
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/acp"
	"github.com/ndolinschi/Octo/apps/harness/internal/config"
	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
	"github.com/ndolinschi/Octo/apps/harness/internal/usererr"
)

var limitAgent = plugins.Agent{ID: "cc@work", AccountOf: "cc", Label: "Claude Code · Work",
	LimitPatterns: []*regexp.Regexp{regexp.MustCompile(`(?i)weekly limit`)}}

func TestRPCLimitClassifier(t *testing.T) {
	reset := time.Date(2026, 11, 26, 15, 0, 0, 0, time.UTC)
	// A bare rate limit says nothing about the plan: it is not a usage limit.
	transient := map[string]bool{"rate reason": true, "status 429": true, "429 with a plan pattern is a plan limit": false}
	for _, tc := range []struct {
		name      string
		err       error
		wantCode  string
		wantReset *time.Time
	}{
		{"structured with unix reset", &acp.RPCError{Code: -32000, Message: "limited",
			Data: json.RawMessage(fmt.Sprintf(`{"errorKind":"rate_limit","rateLimit":{"resetsAt":%d}}`, reset.Unix()))},
			usererr.CodeAgentLimitReached, &reset},
		{"structured nested with RFC 3339 reset", fmt.Errorf("prompt: %w", &acp.RPCError{Code: -32603, Message: "x",
			Data: json.RawMessage(`{"data":{"errorKind":"rate_limit","rateLimit":{"resetsAt":"2026-11-26T15:00:00Z"}}}`)}),
			usererr.CodeAgentLimitReached, &reset},
		{"quota code", &acp.RPCError{Code: -32000, Message: "x", Data: json.RawMessage(`{"code":"QUOTA_EXHAUSTED"}`)},
			usererr.CodeAgentLimitReached, nil},
		{"rate reason", &acp.RPCError{Code: -32000, Message: "x", Data: json.RawMessage(`{"error":{"reason":"RATE_LIMIT_EXCEEDED"}}`)},
			usererr.CodeAgentLimitReached, nil},
		{"status 429", &acp.RPCError{Code: -32000, Message: "x", Data: json.RawMessage(`{"statusCode":429}`)},
			usererr.CodeAgentLimitReached, nil},
		{"429 with a plan pattern is a plan limit", &acp.RPCError{Code: -32000, Message: "You've hit your weekly limit", Data: json.RawMessage(`{"statusCode":429}`)},
			usererr.CodeAgentLimitReached, nil},
		{"manifest pattern", &acp.RPCError{Code: -32000, Message: "You've hit your weekly limit"},
			usererr.CodeAgentLimitReached, nil},
		{"auth wins over limit", &acp.RPCError{Code: -32000, Message: "Authentication required",
			Data: json.RawMessage(`{"errorKind":"rate_limit"}`)}, usererr.CodeAgentNotLoggedIn, nil},
		{"plain failure is not a limit", &acp.RPCError{Code: -32603, Message: "Internal error"}, usererr.CodeAgentFailed, nil},
		{"not an RPC error", errors.New("weekly limit"), usererr.CodeAgentFailed, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			u := usererr.As(acpFailure(limitAgent, false, tc.err))
			if u == nil || u.Code != tc.wantCode {
				t.Fatalf("got %+v, want code %s", u, tc.wantCode)
			}
			var le *limitError
			if got := errors.As(u, &le); got != (tc.wantCode == usererr.CodeAgentLimitReached) {
				t.Fatalf("limit marker = %v", got)
			}
			if le != nil && !sameReset(le.resetsAt, tc.wantReset) {
				t.Fatalf("resets at %v, want %v", le.resetsAt, tc.wantReset)
			}
			wantMsg := "Claude Code · Work has reached its usage limit."
			if transient[tc.name] {
				wantMsg = "Claude Code · Work is being rate limited."
			}
			if le != nil && (u.Message != wantMsg || u.Action != usererr.ActionSwitchAccount) {
				t.Fatalf("error = %+v, want message %q", u, wantMsg)
			}
			if le != nil && le.transient != transient[tc.name] {
				t.Fatalf("transient = %v, want %v", le.transient, transient[tc.name])
			}
		})
	}
}

func sameReset(a, b *time.Time) bool {
	if a == nil || b == nil {
		return a == b
	}
	return a.Equal(*b)
}

func TestAgentErrorLimitClassifier(t *testing.T) {
	for _, tc := range []struct {
		name string
		ae   acp.AgentError
		want string
	}{
		{"structured", acp.AgentError{Message: "limit", Data: json.RawMessage(`{"errorKind":"rate_limit"}`)}, usererr.CodeAgentLimitReached},
		{"gemini name", acp.AgentError{Name: "RATE_LIMIT_EXCEEDED", Message: "slow down"}, usererr.CodeAgentLimitReached},
		{"gemini code", acp.AgentError{Code: "quota_exhausted", Message: "quota"}, usererr.CodeAgentLimitReached},
		{"429", acp.AgentError{Name: "APIError", Message: "Upstream provider rate limit reached", StatusCode: 429}, usererr.CodeAgentLimitReached},
		{"pattern", acp.AgentError{Message: "You've hit your weekly limit · resets 3pm"}, usererr.CodeAgentLimitReached},
		{"auth wins over limit", acp.AgentError{Name: "AuthError", Message: "not logged in", StatusCode: 429}, usererr.CodeAgentNotLoggedIn},
		{"plain failure", acp.AgentError{Name: "APIError", Message: "Overloaded", StatusCode: 529}, usererr.CodeAgentFailed},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if u := usererr.As(agentErrorFailure(limitAgent, tc.ae, "")); u == nil || u.Code != tc.want {
				t.Fatalf("got %+v, want %s", u, tc.want)
			}
		})
	}
}

func TestNoteLimitReportsReachedAndCleared(t *testing.T) {
	type call struct {
		id      string
		reset   *time.Time
		reached bool
	}
	var calls []call
	o := &Orchestrator{opts: Options{OnAgentLimit: func(id string, r *time.Time, reached bool) { calls = append(calls, call{id, r, reached}) }}}
	reset := time.Date(2026, 11, 26, 15, 0, 0, 0, time.UTC)
	o.noteLogin("cc@work", usererr.AgentLimitReached("x", "y", false).Caused(&limitError{resetsAt: &reset}))
	// A bare rate limit is not the agent's limit: nothing is recorded or cleared.
	o.noteLogin("cc@work", usererr.AgentRateLimited("x", "y", false).Caused(&limitError{transient: true}))
	o.noteLogin("cc@work", usererr.AgentFailed("x", "y"))
	o.noteLogin("cc@work", nil)
	if len(calls) != 2 || !calls[0].reached || !calls[0].reset.Equal(reset) || calls[1].reached || calls[1].reset != nil {
		t.Fatalf("calls = %+v", calls)
	}
}

func agentsOf(ids ...string) []plugins.Agent {
	out := make([]plugins.Agent, len(ids))
	for i, id := range ids {
		out[i] = plugins.Agent{ID: id, Available: true}
		if base, _, ok := plugins.SplitAccountID(id); ok {
			out[i].AccountOf = base
		}
	}
	return out
}

func idsOf(agents []plugins.Agent) []string {
	out := []string{}
	for _, a := range agents {
		out = append(out, a.ID)
	}
	return out
}

func TestOfferedAgents(t *testing.T) {
	all := agentsOf("cc", "cc@work", "cc@side", "codex", "codex@two", "zed")
	for _, tc := range []struct {
		name   string
		models config.Models
		want   []string
	}{
		{"names nothing: default accounts only", config.Models{Orchestrator: "claude-opus-5-5"}, []string{"cc", "codex", "zed"}},
		{"names an account: only it for that agent", config.Models{Orchestrator: "acp:cc@work/opus"}, []string{"cc@work", "codex", "zed"}},
		{"names default and account", config.Models{Orchestrator: "acp:cc", Deep: "acp:cc@side"}, []string{"cc", "cc@side", "codex", "zed"}},
		{"auto candidates count", config.Models{AutoCandidates: []string{"acp:codex@two"}}, []string{"cc", "codex@two", "zed"}},
		{"a stale name hides nothing", config.Models{Fast: "acp:cc@gone"}, []string{"cc", "codex", "zed"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := idsOf(offeredAgents(all, tc.models)); !slices.Equal(got, tc.want) {
				t.Fatalf("offered = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestDefaultOrchestratorFallbackNeverPicksAnAccount(t *testing.T) {
	no := false
	agents := agentsOf("claude-code@work", "claude-code", "codex")
	agents[1].LoggedIn = &no
	o := &Orchestrator{opts: Options{Agents: agents}}
	if a, ok := o.readyAgent(); !ok || a.ID != "codex" {
		t.Fatalf("ready = %q %v, want codex", a.ID, ok)
	}
	o.opts.Agents = agentsOf("claude-code@work")
	if a, ok := o.readyAgent(); ok {
		t.Fatalf("picked %q", a.ID)
	}
}

func TestSkillsOfAnAccountUseItsBaseAndItsCodexHome(t *testing.T) {
	proj, home, acct := t.TempDir(), t.TempDir(), t.TempDir()
	t.Setenv("CODEX_HOME", filepath.Join(home, "harness-codex"))
	writeSkillFile(t, filepath.Join(proj, ".codex", "skills", "fix-ci", "SKILL.md"), "---\ndescription: Fix CI\n---\n")
	writeSkillFile(t, filepath.Join(home, "harness-codex", "skills", "mine", "SKILL.md"), "---\ndescription: Harness home\n---\n")
	writeSkillFile(t, filepath.Join(acct, "skills", "work", "SKILL.md"), "---\ndescription: Work home\n---\n")
	folders := []projectstore.Folder{{Path: proj}}
	names := func(cmds []acp.Command) []string {
		var out []string
		for _, c := range cmds {
			out = append(out, c.Name)
		}
		return out
	}
	if got := names(discoverAgentSkills("codex@work", map[string]string{"CODEX_HOME": acct}, folders, home)); !slices.Equal(got, []string{"fix-ci", "work"}) {
		t.Fatalf("account skills = %v", got)
	}
	if got := names(discoverAgentSkills("codex", map[string]string{"CODEX_HOME": acct}, folders, home)); !slices.Equal(got, []string{"fix-ci", "mine"}) {
		t.Fatalf("default skills = %v", got)
	}
}

// The hint offers another account only for an agent that can keep several;
// the sticky provider state (OnAgentLimit) is set for a plan limit only.
func TestLimitFailureWordingAndStickiness(t *testing.T) {
	withAccounts := plugins.Agent{ID: "cc", Label: "Claude Code", AccountEnv: "CLAUDE_CONFIG_DIR"}
	derived := plugins.Agent{ID: "cc@work", AccountOf: "cc", AccountID: "work", AccountLabel: "Work", Label: "Claude Code · Work"}
	oneLogin := plugins.Agent{ID: "cop", Label: "Copilot", AccountUnsupported: "shared keychain"}
	bare := acp.AgentError{Name: "APIError", Message: "Upstream provider rate limit reached", StatusCode: 429}
	plan := acp.AgentError{Message: "limit", Data: json.RawMessage(`{"errorKind":"rate_limit"}`)}
	for _, tc := range []struct {
		name         string
		ag           plugins.Agent
		ae           acp.AgentError
		wantMessage  string
		wantHint     string
		wantNoAcct   bool
		wantReported bool
	}{
		{"bare 429, base with accounts", withAccounts, bare, "Claude Code is being rate limited.", "Retry in a moment, or pick another account or model.", false, false},
		{"bare 429, an account", derived, bare, "Claude Code · Work is being rate limited.", "Retry in a moment, or pick another account or model.", false, false},
		{"bare 429, one login only", oneLogin, bare, "Copilot is being rate limited.", "Retry in a moment, or pick another model.", true, false},
		{"plan limit, base with accounts", withAccounts, plan, "Claude Code has reached its usage limit.", "Pick another account or model and retry, or wait until the limit resets.", false, true},
		{"plan limit, one login only", oneLogin, plan, "Copilot has reached its usage limit.", "Pick another model and retry, or wait until the limit resets.", true, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			u := usererr.As(agentErrorFailure(tc.ag, tc.ae, ""))
			if u == nil || u.Code != usererr.CodeAgentLimitReached || u.Message != tc.wantMessage || u.Hint != tc.wantHint || u.Action != usererr.ActionSwitchAccount {
				t.Fatalf("error = %+v", u)
			}
			if tc.wantNoAcct && strings.Contains(u.Hint, "account") {
				t.Fatalf("hint offers an account: %q", u.Hint)
			}
			var reached []bool
			o := &Orchestrator{opts: Options{OnAgentLimit: func(_ string, _ *time.Time, r bool) { reached = append(reached, r) }}}
			o.noteLimit(tc.ag.ID, u)
			if got := len(reached) == 1 && reached[0]; got != tc.wantReported || (!tc.wantReported && len(reached) != 0) {
				t.Fatalf("OnAgentLimit calls = %v, want reported=%v", reached, tc.wantReported)
			}
		})
	}
}

func TestOfferedAgentsLeavesOutExperimentalOnesUnlessNamed(t *testing.T) {
	all := agentsOf("cc", "gemini", "gemini@work", "codex")
	for i := range all {
		all[i].Experimental = strings.HasPrefix(all[i].ID, "gemini")
	}
	for _, tc := range []struct {
		name   string
		models config.Models
		want   []string
	}{
		{"names nothing", config.Models{Orchestrator: "claude-opus-5-5"}, []string{"cc", "codex"}},
		{"names the default", config.Models{Fast: "acp:gemini"}, []string{"cc", "gemini", "codex"}},
		{"names an account", config.Models{Fast: "acp:gemini@work"}, []string{"cc", "gemini@work", "codex"}},
		{"auto candidate", config.Models{AutoCandidates: []string{"acp:gemini"}}, []string{"cc", "gemini", "codex"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := idsOf(offeredAgents(all, tc.models)); !slices.Equal(got, tc.want) {
				t.Fatalf("offered = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestDefaultOrchestratorFallbackNeverPicksAnExperimentalAgent(t *testing.T) {
	agents := agentsOf("gemini", "zed")
	agents[0].Experimental = true
	o := &Orchestrator{opts: Options{Agents: agents}}
	if a, ok := o.readyAgent(); !ok || a.ID != "zed" {
		t.Fatalf("ready = %q %v, want zed", a.ID, ok)
	}
	o.opts.Agents = agents[:1]
	if a, ok := o.readyAgent(); ok {
		t.Fatalf("picked %q", a.ID)
	}
}
