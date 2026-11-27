package plugins_test

import (
	"context"
	"encoding/json"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/childenv"
	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
)

func TestManifestAccountFields(t *testing.T) {
	for _, tc := range []struct{ name, agent, wantErr string }{
		{"no block", `{"id":"a","command":"sh"}`, ""},
		{"env", `{"id":"a","command":"sh","accounts":{"env":"A_HOME","extraEnv":{"F":"true"},"note":"n"}}`, ""},
		{"unsupported", `{"id":"a","command":"sh","accounts":{"unsupported":"one keyring"}}`, ""},
		{"empty block", `{"id":"a","command":"sh","accounts":{}}`, "accounts.env"},
		{"extra ref", `{"id":"a","command":"sh","accounts":{"env":"A_HOME","extraEnv":{"F":"${HOME}"}}}`, "not allowed"},
		{"extra sets env", `{"id":"a","command":"sh","accounts":{"env":"A_HOME","extraEnv":{"A_HOME":"x"}}}`, "must not set"},
		{"bad extra name", `{"id":"a","command":"sh","accounts":{"env":"A_HOME","extraEnv":{"A-B":"x"}}}`, "variable name"},
		{"env and unsupported", `{"id":"a","command":"sh","accounts":{"env":"H","unsupported":"x"}}`, "exclude"},
		{"login", `{"id":"a","command":"sh","auth":{"login":[{"id":"x","label":"X","args":["sh","-c","true"]}]}}`, ""},
		{"login without id", `{"id":"a","command":"sh","auth":{"login":[{"label":"X","args":["sh"]}]}}`, "id is required"},
		{"login without label", `{"id":"a","command":"sh","auth":{"login":[{"id":"x","args":["sh"]}]}}`, "label is required"},
		{"login without args", `{"id":"a","command":"sh","auth":{"login":[{"id":"x","label":"X"}]}}`, "args[0]"},
		{"duplicate login", `{"id":"a","command":"sh","auth":{"login":[{"id":"x","label":"X","args":["sh"]},{"id":"x","label":"Y","args":["sh"]}]}}`, "duplicate id"},
		{"limit patterns", `{"id":"a","command":"sh","limitPatterns":["(?i)usage limit"]}`, ""},
		{"bad limit pattern", `{"id":"a","command":"sh","limitPatterns":["("]}`, "limitPatterns"},
		{"empty limit pattern", `{"id":"a","command":"sh","limitPatterns":[" "]}`, "limitPatterns"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			data := t.TempDir()
			writePlugin(t, filepath.Join(data, "plugins"), "p", `{"name":"p","version":"1","agents":[`+tc.agent+`]}`)
			p := find(t, plugins.Load(context.Background(), data, nil, nil), "p")
			if tc.wantErr == "" {
				if len(p.Errors) != 0 || len(p.Agents) != 1 {
					t.Fatalf("plugin = %+v", p)
				}
				return
			}
			if len(p.Errors) != 1 || !strings.Contains(p.Errors[0], tc.wantErr) {
				t.Fatalf("errors = %v, want one containing %q", p.Errors, tc.wantErr)
			}
		})
	}
}

const accountsManifest = `{"name":"p","version":"1","agents":[
 {"id":"cc","label":"Claude Code","command":"sh","env":{"KEEP":"x"},"accounts":{"env":"CLAUDE_CONFIG_DIR","note":"files"},
  "auth":{"command":"claude auth login","login":[{"id":"claudeai","label":"Claude subscription","args":["sh","-c","echo login"]}]},
  "limitPatterns":["(?i)weekly limit"]},
 {"id":"codex","label":"Codex","command":"sh","env":{"CODEX_HOME":"${OCTO_CODEX_HOME}"},"accounts":{"env":"CODEX_HOME"}},
 {"id":"gem","label":"Gemini","command":"sh","accounts":{"env":"GEM_HOME_DIR","extraEnv":{"GEM_FILES":"true"}},"auth":{"command":"gem login","hint":"Run gem login."}},
 {"id":"cop","label":"Copilot","command":"sh","accounts":{"unsupported":"keychain not namespaced"}},
 {"id":"plain","label":"Plain","command":"sh"}]}`

func loadAccounts(t *testing.T) *plugins.Registry {
	t.Helper()
	data := t.TempDir()
	writePlugin(t, filepath.Join(data, "plugins"), "p", accountsManifest)
	r := plugins.Load(context.Background(), data, nil, nil)
	if p := find(t, r, "p"); len(p.Errors) > 0 {
		t.Fatalf("errors: %v", p.Errors)
	}
	return r
}

// swap gives r a mutable account list, as the accounts store does.
func swap(r *plugins.Registry) func([]plugins.Account) {
	var mu sync.Mutex
	var cur []plugins.Account
	r.SetAccounts(func() []plugins.Account { mu.Lock(); defer mu.Unlock(); return slices.Clone(cur) })
	return func(next []plugins.Account) { mu.Lock(); cur = next; mu.Unlock() }
}

func TestAccountSupportFields(t *testing.T) {
	t.Setenv("CODEX_HOME", "/harness/codex")
	t.Setenv("OCTO_CODEX_HOME", "/octo/codex")
	r := loadAccounts(t)
	set := swap(r)
	if a, _ := r.Agent("plain"); a.AccountEnv != "" || a.AccountUnsupported != plugins.NoAccountsReason {
		t.Fatalf("plain = %q %q", a.AccountEnv, a.AccountUnsupported)
	}
	if a, _ := r.Agent("cop"); a.AccountEnv != "" || a.AccountUnsupported != "keychain not namespaced" {
		t.Fatalf("cop = %q %q", a.AccountEnv, a.AccountUnsupported)
	}
	if a, _ := r.Agent("cc"); a.AccountUnsupported != "" || a.AccountNote != "files" || a.Base() != "cc" {
		t.Fatalf("cc = %+v", a)
	}
	set([]plugins.Account{
		{Agent: "cc", ID: "work", Label: "Work", ConfigDir: "/acc/cc/work", Owned: true},
		{Agent: "codex", ID: "second", Label: "Second", ConfigDir: "/acc/codex/it's"},
		{Agent: "gem", ID: "school", Label: "School", ConfigDir: "/acc/gem"},
	})
	w, _ := r.Agent("cc@work")
	if w.Base() != "cc" || !w.AccountOwned || w.AccountNote != "" || len(w.LimitPatterns) != 1 || len(w.Logins) != 1 {
		t.Fatalf("derived = %+v", w)
	}
	c, _ := r.Agent("codex@second")
	if got := childEnv(c); got != "/acc/codex/it's" {
		t.Fatalf("child CODEX_HOME = %q, want the account's over the harness's", got)
	}
	if def, _ := r.Agent("codex"); childEnv(def) != "/octo/codex" {
		t.Fatalf("default codex CODEX_HOME = %q", childEnv(def))
	}
	g, _ := r.Agent("gem@school")
	if env := g.ResolvedEnv(); env["GEM_HOME_DIR"] != "/acc/gem" || env["GEM_FILES"] != "true" {
		t.Fatalf("gem env = %v", env)
	}
	if g.LoginCmd() != "GEM_FILES=true GEM_HOME_DIR=/acc/gem gem login" {
		t.Fatalf("gem login = %q", g.LoginCmd())
	}
	if base, _ := r.Agent("gem"); base.ResolvedEnv()["GEM_FILES"] != "" {
		t.Fatalf("extraEnv reached the default account: %v", base.ResolvedEnv())
	}
}

func TestDefaultAccountLabel(t *testing.T) {
	r := loadAccounts(t)
	labels := map[string]string{"cc": "Personal", "plain": "Ignored"}
	r.SetDefaultLabels(func() map[string]string { return labels })
	if a, _ := r.Agent("cc"); a.Label != "Claude Code · Personal" || a.AccountDefaultLabel != "Personal" {
		t.Fatalf("cc = %q %q", a.Label, a.AccountDefaultLabel)
	}
	if a, _ := r.Agent("plain"); a.Label != "Plain" || a.AccountDefaultLabel != "" {
		t.Fatalf("an agent without accounts takes no default name: %q", a.Label)
	}
	swap(r)([]plugins.Account{{Agent: "cc", ID: "work", Label: "Work", ConfigDir: "/w"}})
	var labelsOut []string
	for _, a := range r.Agents() {
		labelsOut = append(labelsOut, a.Label)
	}
	if !slices.Contains(labelsOut, "Claude Code · Personal") || !slices.Contains(labelsOut, "Claude Code · Work") {
		t.Fatalf("labels = %v", labelsOut)
	}
}

// childEnv is CODEX_HOME as a child started with a's environment sees it (the last entry wins).
func childEnv(a plugins.Agent) string {
	got := ""
	for _, kv := range childenv.Build([]string{"CODEX_HOME=/harness/codex", "PATH=/bin"}, a.ResolvedEnv()) {
		if v, ok := strings.CutPrefix(kv, "CODEX_HOME="); ok {
			got = v
		}
	}
	return got
}

func TestForgetDropsStateOfRemovedIDs(t *testing.T) {
	r := loadAccounts(t)
	set := swap(r)
	set([]plugins.Account{{Agent: "cc", ID: "work", Label: "Work", ConfigDir: "/w"}})
	r.SeenLogin("cc@work", false)
	if !r.SeenLimit("cc@work", nil, true) {
		t.Fatal("SeenLimit must record")
	}
	if a, _ := r.Agent("cc@work"); a.Limit == nil || a.LoggedIn == nil || *a.LoggedIn {
		t.Fatalf("state = %+v %v", a.Limit, a.LoggedIn)
	}
	set(nil)
	r.Forget("cc@work")
	if _, ok := r.Agent("cc@work"); ok {
		t.Fatal("removed account still served")
	}
	set([]plugins.Account{{Agent: "cc", ID: "work", Label: "Work", ConfigDir: "/w2"}})
	if a, _ := r.Agent("cc@work"); a.Limit != nil || a.LoggedIn != nil {
		t.Fatalf("state of a removed id came back: %+v %v", a.Limit, a.LoggedIn)
	}
	if r.SeenLimit("nobody", nil, true) {
		t.Fatal("unknown id must be ignored")
	}
}

// Limit and "logged out" state recorded while an account is removed never
// survives for that id, whichever of the two wins the race.
func TestStateOfARemovedAccountNeverSurvivesARace(t *testing.T) {
	r := loadAccounts(t)
	set := swap(r)
	spec := []plugins.Account{{Agent: "cc", ID: "work", Label: "Work", ConfigDir: "/w"}}
	for i := 0; i < 300; i++ {
		set(spec)
		var wg sync.WaitGroup
		wg.Add(3)
		go func() { defer wg.Done(); r.SeenLimit("cc@work", nil, true) }()
		go func() { defer wg.Done(); r.SeenLogin("cc@work", false) }()
		go func() { defer wg.Done(); set(nil); r.Forget("cc@work") }()
		wg.Wait()
		if r.SeenLimit("cc@work", nil, true) {
			t.Fatal("a limit was recorded for a removed account")
		}
		set(spec)
		if a, ok := r.Agent("cc@work"); !ok || a.Limit != nil || (a.LoggedIn != nil && !*a.LoggedIn) {
			t.Fatalf("round %d: state of the removed account came back: limit=%v loggedIn=%v", i, a.Limit, a.LoggedIn)
		}
	}
}

func TestLoginSpec(t *testing.T) {
	r := loadAccounts(t)
	swap(r)([]plugins.Account{{Agent: "cc", ID: "work", Label: "Work", ConfigDir: "/w"}})
	a, _ := r.Agent("cc@work")
	cmd, args, env, ok := a.LoginSpec("")
	if !ok || !strings.HasSuffix(cmd, "/sh") || !slices.Equal(args, []string{"-c", "echo login"}) || env["CLAUDE_CONFIG_DIR"] != "/w" {
		t.Fatalf("LoginSpec = %q %v %v %v", cmd, args, env, ok)
	}
	if _, _, _, ok := a.LoginSpec("claudeai"); !ok {
		t.Fatal("named method not found")
	}
	if _, _, _, ok := a.LoginSpec("nope"); ok {
		t.Fatal("unknown method must fail")
	}
	if p, _ := r.Agent("plain"); func() bool { _, _, _, ok := p.LoginSpec(""); return ok }() {
		t.Fatal("an agent without auth.login has no login spec")
	}
}

func TestDerivedAccountIsProbedWithItsOwnEnv(t *testing.T) {
	data := t.TempDir()
	writePlugin(t, filepath.Join(data, "plugins"), "p", `{"name":"p","version":"1","agents":[
	 {"id":"cc","command":"sh","accounts":{"env":"PROBE_ACCOUNT_DIR"},
	  "auth":{"probe":["sh","-c","test -n \"$PROBE_ACCOUNT_DIR\""],"notLoggedInExit":[1]}}]}`)
	r := plugins.Load(context.Background(), data, nil, nil)
	dir := t.TempDir()
	r.SetAccounts(func() []plugins.Account {
		return []plugins.Account{{Agent: "cc", ID: "two", Label: "Two", ConfigDir: dir}}
	})
	ctx := context.Background()
	if a, _ := r.Recheck(ctx, "cc"); a.LoggedIn == nil || *a.LoggedIn {
		t.Fatalf("default account must probe without the account env: %v", a.LoggedIn)
	}
	if a, ok := r.Recheck(ctx, "cc@two"); !ok || a.LoggedIn == nil || !*a.LoggedIn {
		t.Fatalf("derived account must probe with its env: %v", a.LoggedIn)
	}
}

func TestSeenLimit(t *testing.T) {
	r := loadAccounts(t)
	soon := time.Now().Add(time.Hour).UTC().Truncate(time.Second)
	if !r.SeenLimit("cc", &soon, true) || r.SeenLimit("cc", &soon, true) {
		t.Fatal("SeenLimit must report a change once")
	}
	if a, _ := r.Agent("cc"); a.Limit == nil || a.Limit.ResetsAt == nil || !a.Limit.ResetsAt.Equal(soon) || a.Limit.ReachedAt.IsZero() {
		t.Fatalf("limit = %+v", a.Limit)
	}
	if b, _ := json.Marshal(func() plugins.Agent { a, _ := r.Agent("cc"); return a }()); !strings.Contains(string(b), `"limit":{"reached_at":`) {
		t.Fatalf("agent JSON = %s", b)
	}
	r.Recheck(context.Background(), "cc")
	if a, _ := r.Agent("cc"); a.Limit != nil {
		t.Fatal("Check again must clear the limit")
	}
	past := time.Now().Add(-time.Minute)
	r.SeenLimit("cc", &past, true)
	if a, _ := r.Agent("cc"); a.Limit != nil {
		t.Fatal("a limit whose reset time passed must not show")
	}
	r.SeenLimit("cc", nil, true)
	if !r.SeenLimit("cc", nil, false) {
		t.Fatal("a successful turn must clear the limit")
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
