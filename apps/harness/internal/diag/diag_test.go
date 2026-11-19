package diag

import (
	"encoding/json"
	"log/slog"
	"strings"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
)

var secrets = []string{
	"sk-ant-api03-SECRETVALUE0123456789", "octo-router-secret-xyz", "ghp_abcdefghijklmnop1234", "hunter2-password-value",
	"url-pass-secret", "query-key-secret",
}

func TestReportContainsNoSecrets(t *testing.T) {
	ring := NewLogRing(LogLines)
	logger := slog.New(ring.Wrap(slog.NewTextHandler(discard{}, nil)))
	logger.Info("calling upstream", "url", "http://user:"+secrets[4]+"@host:1/v1?api_key="+secrets[5])
	logger.Warn("agent failed", "err", "401 Authorization: Bearer "+secrets[2], "api_key", secrets[0], "x", "token="+secrets[3])
	logger.Info("env", "ANTHROPIC_API_KEY", secrets[0], "note", "OCTO_KEY="+secrets[1])
	for i := 0; i < 250; i++ {
		logger.Info("filler", "i", i)
	}
	ok := false
	rep := Build(Inputs{
		Version: "9.9", DataDir: "/data", BuiltinOK: ok, BuiltinWhy: "no key",
		BaseURL: "http://user:" + secrets[4] + "@127.0.0.1:8080/autoroute?key=" + secrets[5] + "#frag",
		Env: []string{"PATH=/bin:/usr/bin", "ANTHROPIC_API_KEY=" + secrets[0], "HARNESS_OCTO_KEY=" + secrets[1], "GITHUB_TOKEN=" + secrets[2],
			"COPILOT_GITHUB_TOKEN=" + secrets[2], "MY_PASSWORD=" + secrets[3], "XAI_API_KEY="},
		Agents: []plugins.Agent{
			{ID: "claude-code", Label: "Claude Code", Available: false, UnavailableReason: "not found", InstallHint: "npm i -g x", Hint: "run claude /login",
				Requires: []string{"definitely-not-a-command-xyz"}},
			{ID: "ok", Label: "Ok", Available: true, Launch: plugins.Launch{Command: "/bin/sh"}},
		},
		Log: ring,
	})
	b, err := json.Marshal(rep)
	if err != nil {
		t.Fatal(err)
	}
	for _, text := range []string{string(b), rep.Text()} {
		for _, s := range secrets {
			if strings.Contains(text, s) {
				t.Errorf("the report contains %q:\n%s", s, text)
			}
		}
	}
	if len(rep.LogTail) != LogLines {
		t.Errorf("log tail has %d lines, want %d", len(rep.LogTail), LogLines)
	}
	if rep.Router.BaseURL != "http://127.0.0.1:8080/autoroute" {
		t.Errorf("base url = %q", rep.Router.BaseURL)
	}
	if rep.PathForChildren != "/bin:/usr/bin" {
		t.Errorf("PATH = %q", rep.PathForChildren)
	}
	// Names of set variables are reported, values and empty variables are not.
	got := strings.Join(rep.EnvSet, ",")
	if !strings.Contains(got, "ANTHROPIC_API_KEY") || !strings.Contains(got, "HARNESS_OCTO_KEY") || strings.Contains(got, "XAI_API_KEY") || strings.Contains(got, "MY_PASSWORD") {
		t.Errorf("env_set = %v", rep.EnvSet)
	}
}

func TestReportListsForwardedShellVariablesByNameOnly(t *testing.T) {
	rep := Build(Inputs{
		Version: "1", DataDir: "/d",
		Env: []string{"PATH=/bin", "LANG=en_US.UTF-8", "LC_ALL=C", "BUN_INSTALL=/h/.bun-VALUE", "XDG_DATA_HOME=",
			"HTTPS_PROXY=http://u:proxy-pass-VALUE@p:1", "EDITOR=vim", "OPENAI_API_KEY=sk-VALUE", "NPM_TOKEN=npm-VALUE"},
	})
	if got := strings.Join(rep.ShellEnvSet, ","); got != "BUN_INSTALL,HTTPS_PROXY,LANG,LC_ALL" {
		t.Errorf("shell_env_set = %q", got)
	}
	b, err := json.Marshal(rep)
	if err != nil {
		t.Fatal(err)
	}
	for _, text := range []string{string(b), rep.Text()} {
		for _, v := range []string{"VALUE", "en_US", "sk-"} {
			if strings.Contains(text, v) {
				t.Errorf("report leaks %q:\n%s", v, text)
			}
		}
	}
	if !strings.Contains(rep.Text(), "login-shell variables child processes get (names only): BUN_INSTALL, HTTPS_PROXY, LANG, LC_ALL") {
		t.Errorf("text:\n%s", rep.Text())
	}
}

func TestAgentSectionSaysWhatIsMissing(t *testing.T) {
	rep := Build(Inputs{Env: []string{"PATH=/bin"}, Agents: []plugins.Agent{
		{ID: "a", Label: "A", Available: false, UnavailableReason: `"pi" is required and was not found on PATH`, InstallHint: "install pi",
			Requires: []string{"definitely-not-a-command-xyz"}},
	}})
	a := rep.Agents[0]
	if a.Command != "not found" || a.Requires[0].Found != "not found" || a.InstallHint != "install pi" || len(rep.Problems) == 0 {
		t.Fatalf("agent = %+v problems = %v", a, rep.Problems)
	}
	if !strings.Contains(rep.Text(), "not installed") || !strings.Contains(rep.Text(), "install pi") {
		t.Fatalf("text:\n%s", rep.Text())
	}
}

func TestProblemWithoutInstallHintHasNoDanglingSentence(t *testing.T) {
	rep := Build(Inputs{Env: []string{"PATH=/bin"}, Agents: []plugins.Agent{
		{ID: "droid", Label: "Droid", Available: false, UnavailableReason: `"droid" was not found on PATH`},
	}})
	var got string
	for _, p := range rep.Problems {
		if strings.HasPrefix(p, "droid:") {
			got = p
		}
	}
	if got == "" || strings.HasSuffix(got, " ") || strings.HasSuffix(got, ". ") {
		t.Fatalf("problem = %q (all: %v)", got, rep.Problems)
	}
}

type discard struct{}

func (discard) Write(p []byte) (int, error) { return len(p), nil }

func TestPathEntriesAreListedOnce(t *testing.T) {
	r := Build(Inputs{Env: []string{"PATH=/usr/bin:/bin:/usr/bin::/bin:/opt/x"}, BuiltinOK: true})
	if strings.Count(r.PathForChildren, "/usr/bin") != 1 || strings.Count(r.PathForChildren, "/bin") < 1 {
		t.Fatalf("path = %q", r.PathForChildren)
	}
	for _, e := range strings.Split(r.PathForChildren, ":") {
		if strings.Count(":"+r.PathForChildren+":", ":"+e+":") != 1 {
			t.Fatalf("entry %q repeated in %q", e, r.PathForChildren)
		}
	}
}

func TestRouterPendingIsNotABrokenBuiltinLoop(t *testing.T) {
	r := Build(Inputs{BuiltinOK: false, BuiltinWhy: "No API key", RouterPending: true, Env: []string{}})
	if len(r.Problems) != 0 || r.Router.Note != RouterPendingNote || !strings.Contains(r.BuiltinLoop.Reason, "not checked") {
		t.Fatalf("report = %+v", r)
	}
	r = Build(Inputs{BuiltinOK: false, BuiltinWhy: "No API key", Env: []string{}})
	if len(r.Problems) != 1 || r.Router.Note != "" {
		t.Fatalf("without the switch the problem stays: %+v", r)
	}
}

// Doctor reports an agent's CLI version (checked now) and says when it is too
// old, with the update line; an agent whose program is missing is not checked.
func TestAgentVersionIsReported(t *testing.T) {
	ok := plugins.Agent{ID: "antigravity", Label: "Antigravity", Available: true, MinVersion: "1.5.0", VersionCommand: "/bin/agy",
		InstallHint: "Install: `curl -fsSL https://antigravity.google/cli/install.sh | bash`"}
	old := ok
	old.ID = "old"
	missing := ok
	missing.ID, missing.Available = "missing", false
	versions := map[string]plugins.VersionReport{
		"antigravity": {Ran: true, Version: "1.5.9", Reason: "version 1.5.9 (needs 1.5.0 or newer)"},
		"old":         {Ran: true, Version: "1.4.12", TooOld: true, Reason: "version 1.4.12 is older than 1.5.0, the lowest that works with Octo"},
	}
	r := Build(Inputs{Agents: []plugins.Agent{ok, old, missing}, BuiltinOK: true, Env: []string{"PATH=/usr/bin"},
		CheckVersion: func(a plugins.Agent) plugins.VersionReport {
			if a.ID == "missing" {
				t.Fatal("checked an agent whose program is missing")
			}
			return versions[a.ID]
		}})
	if v := r.Agents[0].Version; v == nil || v.Version != "1.5.9" || v.TooOld || v.Min != "1.5.0" {
		t.Fatalf("ok: %+v", v)
	}
	if v := r.Agents[1].Version; v == nil || !v.TooOld || r.Agents[1].Available {
		t.Fatalf("old: %+v available=%v", v, r.Agents[1].Available)
	}
	if v := r.Agents[2].Version; v == nil || v.Ran || !strings.Contains(v.Reason, "not found") {
		t.Fatalf("missing: %+v", v)
	}
	text := r.Text()
	for _, want := range []string{"version: version 1.5.9 (needs 1.5.0 or newer)", "old (Antigravity): too old: update it",
		"old: too old (version 1.4.12 is older than 1.5.0", "install.sh | bash"} {
		if !strings.Contains(text, want) {
			t.Errorf("doctor text lacks %q:\n%s", want, text)
		}
	}
	raw, _ := json.Marshal(r)
	if !strings.Contains(string(raw), `"too_old":true`) {
		t.Fatalf("json lacks the version: %s", raw)
	}
	if plain := Build(Inputs{Agents: []plugins.Agent{{ID: "x", Available: true}}, BuiltinOK: true}); plain.Agents[0].Version != nil {
		t.Fatal("an agent without a version check has no version entry")
	}
}
