package plugins_test

import (
	"context"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
)

// Limit and "logged out" state recorded while an account is removed never
// survives for that id, whichever of the two wins the race.
func TestStateOfARemovedAccountNeverSurvivesARace(t *testing.T) {
	r := loadAccounts(t)
	spec := []plugins.AccountSpec{{Agent: "cc", ID: "work", Name: "Work", Dir: "/w"}}
	for i := 0; i < 300; i++ {
		r.SetAccounts(spec, nil)
		var wg sync.WaitGroup
		wg.Add(3)
		go func() { defer wg.Done(); r.SeenLimit("cc@work", nil, true) }()
		go func() { defer wg.Done(); r.SeenLogin("cc@work", false) }()
		go func() { defer wg.Done(); r.SetAccounts(nil, nil) }()
		wg.Wait()
		if r.SeenLimit("cc@work", nil, true) {
			t.Fatal("a limit was recorded for a removed account")
		}
		r.SetAccounts(spec, nil)
		if a, ok := r.Agent("cc@work"); !ok || a.Limit != nil || (a.LoggedIn != nil && !*a.LoggedIn) {
			t.Fatalf("round %d: state of the removed account came back: limit=%v loggedIn=%v", i, a.Limit, a.LoggedIn)
		}
	}
}

// A derived account has its own login text: the base agent's would log in the
// default account, and a folder must not appear in a hint.
func TestAccountHintIsNotTheBaseAgentsAndNamesNoFolder(t *testing.T) {
	r := loadAccounts(t)
	base, _ := r.Agent("cc")
	r.SetAccounts([]plugins.AccountSpec{
		{Agent: "cc", ID: "work", Name: "Work", Dir: "/secret/acc/work"},
		{Agent: "codex", ID: "two", Name: "Two", Dir: "/secret/acc/two"},
	}, nil)
	w, _ := r.Agent("cc@work")
	if w.Hint == base.Hint || strings.Contains(w.Hint, "/secret") || strings.Contains(w.Hint, "claude auth login") {
		t.Fatalf("hint = %q (base %q)", w.Hint, base.Hint)
	}
	if !strings.HasPrefix(w.LoginCmd(), "CLAUDE_CONFIG_DIR='/secret/acc/work' ") {
		t.Fatalf("login command = %q", w.LoginCmd())
	}
	if c, _ := r.Agent("codex@two"); c.Hint == "" || strings.Contains(c.Hint, "/secret") {
		t.Fatalf("hint without a login command = %q", c.Hint)
	}
}

func TestExperimentalManifestFlag(t *testing.T) {
	for _, tc := range []struct {
		name, agent, wantErr string
		want                 bool
	}{
		{"absent", `{"id":"a","command":"sh"}`, "", false},
		{"true", `{"id":"a","command":"sh","experimental":true}`, "", true},
		{"false", `{"id":"a","command":"sh","experimental":false}`, "", false},
		{"with unsupported", `{"id":"a","command":"sh","experimental":true,"unsupported":"no ACP mode"}`, "experimental and unsupported", false},
		{"not a boolean", `{"id":"a","command":"sh","experimental":"yes"}`, "experimental", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			data := t.TempDir()
			writePlugin(t, filepath.Join(data, "plugins"), "p", `{"name":"p","version":"1","agents":[`+tc.agent+`]}`)
			reg := plugins.Load(context.Background(), data, nil, nil)
			p := find(t, reg, "p")
			if tc.wantErr != "" {
				if len(p.Errors) == 0 || !strings.Contains(strings.Join(p.Errors, ";"), tc.wantErr) {
					t.Fatalf("errors = %v, want one containing %q", p.Errors, tc.wantErr)
				}
				return
			}
			if len(p.Errors) != 0 || len(p.Agents) != 1 || p.Agents[0].Experimental != tc.want {
				t.Fatalf("plugin = %+v", p)
			}
		})
	}
}
