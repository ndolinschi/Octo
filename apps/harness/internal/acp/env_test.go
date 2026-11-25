package acp_test

import (
	"strings"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/acp"
	"github.com/ndolinschi/Octo/apps/harness/internal/fakeacp"
	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
)

func TestChildEnvironmentIsScrubbed(t *testing.T) {
	t.Setenv("ANTHROPIC_API_KEY", "mock")
	t.Setenv("ANTHROPIC_BASE_URL", "http://127.0.0.1:1")
	t.Setenv("OPENAI_API_KEY", "sk-leak")
	t.Setenv("XAI_API_KEY", "xai-declared")
	t.Setenv("HARNESS_OCTO_KEY", "octo-secret")
	t.Setenv("LC_OCTO_PLAIN_VAR", "kept")

	declared := plugins.Launch{Env: map[string]string{"XAI_API_KEY": "${XAI_API_KEY}"}}.ResolvedEnv()
	env := map[string]string{
		fakeacp.EnvReportEnv: "ANTHROPIC_API_KEY,ANTHROPIC_BASE_URL,OPENAI_API_KEY,XAI_API_KEY,HARNESS_OCTO_KEY,LC_OCTO_PLAIN_VAR",
	}
	for k, v := range declared {
		env[k] = v
	}
	text, err := runWith(t, env, nil, acp.RunOptions{})
	if err != nil {
		t.Fatal(err)
	}
	want := "Env: ANTHROPIC_API_KEY=unset, ANTHROPIC_BASE_URL=unset, OPENAI_API_KEY=unset, XAI_API_KEY=set, HARNESS_OCTO_KEY=unset, LC_OCTO_PLAIN_VAR=set."
	if !strings.Contains(text, want) {
		t.Fatalf("agent saw a different environment:\n%s\nwant it to contain %q", text, want)
	}
}
