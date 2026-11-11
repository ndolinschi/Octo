package childenv_test

import (
	"slices"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/childenv"
)

func TestScrub(t *testing.T) {
	in := []string{
		"PATH=/usr/bin", "HOME=/home/u", "GORACE=x", "OCTO_TEST_GROK=1", "OCTO_CODEX_HOME=/c", "CODEX_HOME=/c",
		"COPILOT_GITHUB_TOKEN=t", "FACTORY_API_KEY=f",
		"ANTHROPIC_API_KEY=mock", "ANTHROPIC_AUTH_TOKEN=a", "OPENAI_API_KEY=o", "OPENAI_ORG_ID=o",
		"XAI_API_KEY=x", "GROK_CODE_FOO=1", "GEMINI_API_KEY=g", "GOOGLE_GENAI_USE_VERTEXAI=1", "GOOGLE_API_KEY=k",
		"OPENROUTER_API_KEY=r", "MISTRAL_BASE_URL=u", "FOO_API_BASE=u", "http_proxy_BASE_URL=u", "anthropic_api_key=lower",
		"HARNESS_OCTO_KEY=s", "HARNESS_DATA_DIR=/d", "OCTO_KEY=k", "OCTO_HISTORY_TOKEN_KEY=k", "OCTO_CONFIG=/c",
		"EMPTY=", "NOEQUALS",
	}
	want := []string{
		"PATH=/usr/bin", "HOME=/home/u", "GORACE=x", "OCTO_TEST_GROK=1", "OCTO_CODEX_HOME=/c", "CODEX_HOME=/c",
		"COPILOT_GITHUB_TOKEN=t", "FACTORY_API_KEY=f", "EMPTY=", "NOEQUALS",
	}
	orig := slices.Clone(in)
	if got := childenv.Scrub(in); !slices.Equal(got, want) {
		t.Fatalf("Scrub =\n%v\nwant\n%v", got, want)
	}
	if !slices.Equal(in, orig) {
		t.Fatal("Scrub changed its input")
	}
}

func TestBuildExtraWinsAfterScrub(t *testing.T) {
	got := childenv.Build([]string{"A=1", "XAI_API_KEY=inherited"}, map[string]string{"XAI_API_KEY": "declared"})
	want := []string{"A=1", "XAI_API_KEY=declared"}
	if !slices.Equal(got, want) {
		t.Fatalf("Build = %v, want %v", got, want)
	}
}
