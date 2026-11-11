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

type discard struct{}

func (discard) Write(p []byte) (int, error) { return len(p), nil }
