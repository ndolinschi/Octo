package plugins_test

import (
	"context"
	"runtime"
	"strings"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
	subscriptionagents "github.com/ndolinschi/Octo/apps/harness/plugins-examples/subscription-agents"
)

func TestAccountsAreAgentsOfTheirOwn(t *testing.T) {
	data := t.TempDir()
	writePlugin(t, data+"/plugins", "a", `{"name":"a","version":"1","agents":[
	  {"id":"cc","label":"Claude Code","command":"sh","env":{"KEEP":"1"},"models":["opus"],
	   "accounts":{"env":"CLAUDE_CONFIG_DIR","default":"~/.claude"},
	   "auth":{"probe":["sh","-c","true"],"command":"claude auth login"}},
	  {"id":"plain","command":"sh"}]}`)
	r := plugins.Load(context.Background(), data, nil, nil)
	if p := find(t, r, "a"); len(p.Errors) != 0 {
		t.Fatalf("errors: %v", p.Errors)
	}
	accts := []plugins.Account{
		{ID: "work", Agent: "cc", Label: "Work", ConfigDir: "/tmp/cc work"},
		{ID: "x", Agent: "plain", Label: "X", ConfigDir: "/tmp/x"},   // agent without accounts: left out
		{ID: "y", Agent: "missing", Label: "Y", ConfigDir: "/tmp/y"}, // unknown agent: left out
	}
	r.SetAccounts(func() []plugins.Account { return accts })

	var ids []string
	for _, a := range r.Agents() {
		ids = append(ids, a.ID)
	}
	if got := strings.Join(ids, ","); got != "cc,cc@work,plain" {
		t.Fatalf("agents = %s", got)
	}
	a, ok := r.Agent("cc@work")
	if !ok {
		t.Fatal("cc@work not found")
	}
	if a.Label != "Claude Code · Work" || a.AccountOf != "cc" || a.AccountID != "work" || a.AccountDir != "/tmp/cc work" ||
		a.AccountEnv != "" || !a.Available || len(a.Models) != 1 {
		t.Fatalf("account agent = %+v", a)
	}
	env := a.ResolvedEnv()
	if env["CLAUDE_CONFIG_DIR"] != "/tmp/cc work" || env["KEEP"] != "1" {
		t.Fatalf("env = %v", env)
	}
	if runtime.GOOS != "windows" && a.LoginCmd() != "CLAUDE_CONFIG_DIR='/tmp/cc work' claude auth login" {
		t.Fatalf("login = %q", a.LoginCmd())
	}
	// The base agent keeps its own environment.
	b, _ := r.Agent("cc")
	if _, set := b.ResolvedEnv()["CLAUDE_CONFIG_DIR"]; set || b.AccountEnv != "CLAUDE_CONFIG_DIR" || b.AccountDefault != "~/.claude" {
		t.Fatalf("base = %+v", b)
	}
	for _, id := range []string{"plain@x", "missing@y", "cc@nope", "cc@", "@work"} {
		if _, ok := r.Agent(id); ok {
			t.Errorf("%s found", id)
		}
	}
	// The plugin listing shows the account under its plugin.
	if p := find(t, r, "a"); len(p.Agents) != 3 || p.Agents[1].ID != "cc@work" {
		t.Fatalf("plugin agents = %+v", p.Agents)
	}
	// An ACP setting naming the account is valid.
	if err := plugins.ValidateACPRef("acp:cc@work/opus", r.Agents()); err != nil {
		t.Fatal(err)
	}
}

func TestAccountsManifestValidation(t *testing.T) {
	data := t.TempDir()
	writePlugin(t, data+"/plugins", "bad", `{"name":"bad","version":"1","agents":[
	  {"id":"cc","command":"sh","accounts":{"env":"NOT A NAME"}}]}`)
	r := plugins.Load(context.Background(), data, nil, nil)
	p := find(t, r, "bad")
	if len(p.Errors) != 1 || !strings.Contains(p.Errors[0], "accounts.env") {
		t.Fatalf("errors = %v", p.Errors)
	}
}

func TestSplitAccountID(t *testing.T) {
	for in, want := range map[string][2]string{"cc@work": {"cc", "work"}, "cc": {"", ""}, "@w": {"", ""}, "cc@": {"", ""}} {
		a, b, _ := plugins.SplitAccountID(in)
		if a != want[0] || b != want[1] {
			t.Errorf("%q = %q %q", in, a, b)
		}
	}
	if plugins.AccountAgentID("cc", "w") != "cc@w" {
		t.Fatal("join")
	}
}

func TestAccountLoginCommandQuoting(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX quoting")
	}
	for dir, want := range map[string]string{
		"/home/u/.claude-work": "V=/home/u/.claude-work x",
		"/a b":                 "V='/a b' x",
		"/it's":                `V='/it'\''s' x`,
	} {
		if got := plugins.AccountLoginCommand("V", dir, "x"); got != want {
			t.Errorf("%q = %q, want %q", dir, got, want)
		}
	}
}

func TestBuiltinAccounts(t *testing.T) {
	r := plugins.Load(context.Background(), t.TempDir(), nil, nil, plugins.WithBuiltin(subscriptionagents.Manifest))
	want := map[string]string{"claude-code": "CLAUDE_CONFIG_DIR", "codex": "CODEX_HOME", "omp": "PI_CODING_AGENT_DIR"}
	for _, a := range r.Agents() {
		if a.AccountEnv != want[a.ID] {
			t.Errorf("%s: account env %q, want %q", a.ID, a.AccountEnv, want[a.ID])
		}
	}
}
