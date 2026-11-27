package plugins_test

import (
	"context"
	"encoding/json"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/childenv"
	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
)

func TestAccountIDs(t *testing.T) {
	for _, tc := range []struct{ id, base, slug string }{
		{"claude-code", "claude-code", ""},
		{"claude-code@work", "claude-code", "work"},
		{"codex@second", "codex", "second"},
		{"", "", ""},
	} {
		base, slug := plugins.SplitID(tc.id)
		if base != tc.base || slug != tc.slug {
			t.Errorf("SplitID(%q) = %q, %q; want %q, %q", tc.id, base, slug, tc.base, tc.slug)
		}
		if tc.slug != "" && plugins.DerivedID(tc.base, tc.slug) != tc.id {
			t.Errorf("DerivedID(%q, %q) != %q", tc.base, tc.slug, tc.id)
		}
	}
	for s, want := range map[string]bool{
		"work": true, "a": true, "a-b": true, "x2": true, strings.Repeat("a", 32): true,
		"": false, "-a": false, "a-": false, "Work": false, "a_b": false, "a b": false, strings.Repeat("a", 33): false, "a@b": false,
	} {
		if got := plugins.ValidSlug(s); got != want {
			t.Errorf("ValidSlug(%q) = %v, want %v", s, got, want)
		}
	}
}

func TestManifestAccountFields(t *testing.T) {
	for _, tc := range []struct{ name, agent, wantErr string }{
		{"no block", `{"id":"a","command":"sh"}`, ""},
		{"env with dir", `{"id":"a","command":"sh","accounts":{"env":{"A_HOME":"{dir}","F":"true"},"note":"n"}}`, ""},
		{"unsupported", `{"id":"a","command":"sh","accounts":{"unsupported":"one keyring"}}`, ""},
		{"empty block", `{"id":"a","command":"sh","accounts":{}}`, "accounts: env"},
		{"no dir", `{"id":"a","command":"sh","accounts":{"env":{"A_HOME":"/x"}}}`, "{dir}"},
		{"env ref", `{"id":"a","command":"sh","accounts":{"env":{"A_HOME":"${HOME}/{dir}"}}}`, "not allowed"},
		{"bad env name", `{"id":"a","command":"sh","accounts":{"env":{"A-B":"{dir}"}}}`, "variable name"},
		{"env and unsupported", `{"id":"a","command":"sh","accounts":{"env":{"H":"{dir}"},"unsupported":"x"}}`, "exclude"},
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
 {"id":"cc","label":"Claude Code","command":"sh","env":{"KEEP":"x"},"accounts":{"env":{"CLAUDE_CONFIG_DIR":"{dir}"},"note":"files"},
  "auth":{"command":"claude auth login","login":[{"id":"claudeai","label":"Claude subscription","args":["sh","-c","echo login"]}]},
  "limitPatterns":["(?i)weekly limit"]},
 {"id":"codex","label":"Codex","command":"sh","env":{"CODEX_HOME":"${OCTO_CODEX_HOME}"},"accounts":{"env":{"CODEX_HOME":"{dir}"}}},
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

func ids(agents []plugins.Agent) []string {
	out := make([]string, len(agents))
	for i, a := range agents {
		out[i] = a.ID
	}
	return out
}

func TestSetAccounts(t *testing.T) {
	t.Setenv("CODEX_HOME", "/harness/codex")
	t.Setenv("OCTO_CODEX_HOME", "/octo/codex")
	r := loadAccounts(t)
	if a, _ := r.Agent("cc"); a.Label != "Claude Code" || a.BaseID != "cc" || a.Account == nil || a.Account.Name != "Default" || !a.Account.Default {
		t.Fatalf("base before accounts = %+v / %+v", a.Label, a.Account)
	}
	if a, _ := r.Agent("plain"); a.Account != nil || a.Accounts == nil || a.Accounts.Supported || a.Accounts.Reason != plugins.NoAccountsReason {
		t.Fatalf("plain = %+v %+v", a.Account, a.Accounts)
	}
	errs := r.SetAccounts([]plugins.AccountSpec{
		{Agent: "cc", ID: "work", Name: "Work", Dir: "/acc/cc/work", Owned: true},
		{Agent: "codex", ID: "second", Name: "Second", Dir: "/acc/codex/it's"},
		{Agent: "gone", ID: "x", Name: "X", Dir: "/x"},
		{Agent: "cop", ID: "x", Name: "X", Dir: "/x"},
		{Agent: "plain", ID: "x", Name: "X", Dir: "/x"},
		{Agent: "cc", ID: "default", Name: "D", Dir: "/x"},
		{Agent: "cc", ID: "rel", Name: "R", Dir: "rel/dir"},
		{Agent: "cc", ID: "work", Name: "Twice", Dir: "/y"},
	}, map[string]string{"cc": "Personal"})
	if len(errs) != 6 {
		t.Fatalf("errors = %v, want 6", errs)
	}
	if got, want := ids(r.Agents()), []string{"cc", "cc@work", "codex", "codex@second", "cop", "plain"}; !slices.Equal(got, want) {
		t.Fatalf("agents = %v, want %v", got, want)
	}
	if got := ids(find(t, r, "p").Agents); !slices.Equal(got, []string{"cc", "cc@work", "codex", "codex@second", "cop", "plain"}) {
		t.Fatalf("plugin agents = %v", got)
	}
	base, _ := r.Agent("cc")
	if base.Label != "Claude Code · Personal" || base.Account.Name != "Personal" || base.ResolvedEnv()["CLAUDE_CONFIG_DIR"] != "" {
		t.Fatalf("base = %q %+v %v", base.Label, base.Account, base.ResolvedEnv())
	}
	w, ok := r.Agent("cc@work")
	if !ok || w.BaseID != "cc" || w.Label != "Claude Code · Work" || w.Accounts != nil ||
		w.Account == nil || w.Account.ID != "work" || w.Account.Default || !w.Account.Owned || w.Account.Dir != "/acc/cc/work" {
		t.Fatalf("derived = %+v", w)
	}
	if env := w.ResolvedEnv(); env["CLAUDE_CONFIG_DIR"] != "/acc/cc/work" || env["KEEP"] != "x" {
		t.Fatalf("derived env = %v", env)
	}
	if w.LoginCommand != "CLAUDE_CONFIG_DIR='/acc/cc/work' claude auth login" || w.LoginCmd() != w.LoginCommand {
		t.Fatalf("login command = %q", w.LoginCommand)
	}
	if len(w.LimitPatterns) != 1 || len(w.Logins) != 1 {
		t.Fatalf("derived must keep limit patterns and logins: %+v", w)
	}
	c, _ := r.Agent("codex@second")
	if c.ResolvedEnv()["CODEX_HOME"] != "/acc/codex/it's" {
		t.Fatalf("codex env = %v", c.ResolvedEnv())
	}
	if got := childEnv(c); got != "/acc/codex/it's" {
		t.Fatalf("child CODEX_HOME = %q, want the account's over the harness's", got)
	}
	if c.LoginCommand != "" {
		t.Fatalf("codex has no login command, got %q", c.LoginCommand)
	}
	if def, _ := r.Agent("codex"); childEnv(def) != "/octo/codex" {
		t.Fatalf("default codex CODEX_HOME = %q", childEnv(def))
	}
	if s, ok := r.Support("cop"); !ok || s.Supported || s.Reason != "keychain not namespaced" {
		t.Fatalf("Support(cop) = %+v %v", s, ok)
	}
	if s, ok := r.Support("cc"); !ok || !s.Supported || s.Note != "files" {
		t.Fatalf("Support(cc) = %+v %v", s, ok)
	}
	if _, ok := r.Support("cc@work"); ok {
		t.Fatal("a derived id has no support entry")
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

func TestSetAccountsDropsStateOfRemovedIDs(t *testing.T) {
	r := loadAccounts(t)
	r.SetAccounts([]plugins.AccountSpec{{Agent: "cc", ID: "work", Name: "Work", Dir: "/w"}}, nil)
	r.SeenLogin("cc@work", false)
	if !r.SeenLimit("cc@work", nil, true) {
		t.Fatal("SeenLimit must record")
	}
	if a, _ := r.Agent("cc@work"); a.Limit == nil || a.LoggedIn == nil || *a.LoggedIn {
		t.Fatalf("state = %+v %v", a.Limit, a.LoggedIn)
	}
	r.SetAccounts(nil, nil)
	if _, ok := r.Agent("cc@work"); ok {
		t.Fatal("removed account still served")
	}
	if a, _ := r.Agent("cc"); a.Label != "Claude Code" {
		t.Fatalf("label without accounts = %q", a.Label)
	}
	r.SetAccounts([]plugins.AccountSpec{{Agent: "cc", ID: "work", Name: "Work", Dir: "/w2"}}, nil)
	if a, _ := r.Agent("cc@work"); a.Limit != nil || a.LoggedIn != nil {
		t.Fatalf("state of a removed id came back: %+v %v", a.Limit, a.LoggedIn)
	}
	if r.SeenLimit("nobody", nil, true) {
		t.Fatal("unknown id must be ignored")
	}
}

func TestLoginSpec(t *testing.T) {
	r := loadAccounts(t)
	r.SetAccounts([]plugins.AccountSpec{{Agent: "cc", ID: "work", Name: "Work", Dir: "/w"}}, nil)
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
	 {"id":"cc","command":"sh","accounts":{"env":{"PROBE_ACCOUNT_DIR":"{dir}"}},
	  "auth":{"probe":["sh","-c","test -n \"$PROBE_ACCOUNT_DIR\""],"notLoggedInExit":[1]}}]}`)
	r := plugins.Load(context.Background(), data, nil, nil)
	r.SetAccounts([]plugins.AccountSpec{{Agent: "cc", ID: "two", Name: "Two", Dir: t.TempDir()}}, nil)
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
