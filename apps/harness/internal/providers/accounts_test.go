package providers_test

import (
	"encoding/json"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
)

func account(base, slug, name string, mod func(*plugins.Agent)) plugins.Agent {
	return agent(base+"@"+slug, func(a *plugins.Agent) {
		a.AccountOf, a.AccountID, a.AccountLabel, a.AccountDir, a.AccountOwned = base, slug, name, "/acc/"+slug, true
		a.Label = strings.ToUpper(base[:1]) + base[1:] + " · " + name
		if mod != nil {
			mod(a)
		}
	})
}

func TestAccountsAreListedRightAfterTheirBase(t *testing.T) {
	for _, tc := range []struct {
		name string
		in   []plugins.Agent
		want []string
	}{
		{"no accounts", []plugins.Agent{agent("zed", nil), agent("codex", nil), agent("claude-code", nil)},
			[]string{"api", "claude-code", "zed", "codex"}},
		{"accounts of a listed-first agent move with it", []plugins.Agent{
			agent("zed", nil), agent("claude-code", nil), account("claude-code", "work", "Work", nil), agent("codex", nil), account("codex", "two", "Two", nil)},
			[]string{"api", "claude-code", "claude-code@work", "zed", "codex", "codex@two"}},
		{"listed after its base wherever it is", []plugins.Agent{
			agent("codex", nil), agent("grok", nil), account("codex", "b", "B", func(a *plugins.Agent) { a.ID = "codex@b" })},
			[]string{"api", "grok", "codex", "codex@b"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := newRig(t, tc.in...)
			var got []string
			for _, p := range r.svc.Snapshot().Providers {
				got = append(got, p.ID)
			}
			if !slices.Equal(got, tc.want) {
				t.Fatalf("order = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestSuggestNeverPicksAnotherAccount(t *testing.T) {
	for _, tc := range []struct {
		name string
		in   []plugins.Agent
		want string
	}{
		{"default ready", []plugins.Agent{agent("claude-code", nil), account("claude-code", "work", "Work", nil)}, "acp:claude-code"},
		{"default logged out", []plugins.Agent{
			agent("claude-code", func(a *plugins.Agent) { a.LoggedIn = no() }), account("claude-code", "work", "Work", nil), agent("codex", nil)}, "acp:codex"},
		{"only an account is ready", []plugins.Agent{
			agent("claude-code", func(a *plugins.Agent) { a.LoggedIn = no() }), account("claude-code", "work", "Work", nil)}, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := newRig(t, tc.in...).svc.Snapshot().Suggested.Orchestrator; got != tc.want {
				t.Fatalf("suggested = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestAccountFieldsOfAnAgentProvider(t *testing.T) {
	reset := time.Date(2026, 11, 26, 15, 0, 0, 0, time.UTC)
	r := newRig(t,
		agent("claude-code", func(a *plugins.Agent) {
			a.AccountEnv, a.AccountDefaultLabel, a.AccountNote = "CLAUDE_CONFIG_DIR", "Personal", "files"
			a.Logins = []plugins.LoginMethod{{ID: "claudeai", Label: "Claude subscription", Args: []string{"claude", "auth", "login"}}}
			a.LoginCommand = "claude auth login"
		}),
		account("claude-code", "work", "Work", func(a *plugins.Agent) {
			a.LoginCommand = "CLAUDE_CONFIG_DIR='/acc/work' claude auth login"
			a.Limit = &plugins.LimitState{ReachedAt: reset.Add(-time.Hour), ResetsAt: &reset}
		}),
		agent("zed", nil),
	)
	snap := r.svc.Snapshot()
	b, err := json.Marshal(byID(t, snap, "claude-code"))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`"account_env":"CLAUDE_CONFIG_DIR"`, `"account_default_label":"Personal"`,
		`"account_note":"files"`, `"login_methods":[{"id":"claudeai","label":"Claude subscription"}]`,
		`"login_command":"claude auth login"`} {
		if !strings.Contains(string(b), want) {
			t.Errorf("base JSON lacks %s: %s", want, b)
		}
	}
	w := byID(t, snap, "claude-code@work")
	if w.AccountOf != "claude-code" || w.AccountID != "work" || !w.AccountOwned || w.Limit == nil || !w.Limit.ResetsAt.Equal(reset) ||
		w.State != "ready" || !strings.HasPrefix(w.LoginCommand, "CLAUDE_CONFIG_DIR=") {
		t.Fatalf("account = %+v", w)
	}
	z, _ := json.Marshal(byID(t, snap, "zed"))
	if strings.Contains(string(z), `"account_`) || strings.Contains(string(z), `"limit"`) {
		t.Fatalf("plain agent JSON = %s", z)
	}
	api, _ := json.Marshal(byID(t, snap, "api"))
	if strings.Contains(string(api), "account_") {
		t.Fatalf("api provider must not carry account fields: %s", api)
	}
}
