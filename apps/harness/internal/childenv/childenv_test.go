package childenv_test

import (
	"slices"
	"strings"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/childenv"
)

func TestScrubAllowList(t *testing.T) {
	tests := []struct {
		name string
		env  string
		op   string
		keep bool
	}{
		// kept: identity, locale, terminal, proxy, CA, toolchains
		{"PATH", "PATH=/usr/bin", "", true},
		{"HOME", "HOME=/home/u", "", true},
		{"LANG", "LANG=C.UTF-8", "", true},
		{"LC_ALL", "LC_ALL=C", "", true},
		{"XDG", "XDG_CONFIG_HOME=/c", "", true},
		{"TERM", "TERM=xterm", "", true},
		{"SSH_AUTH_SOCK", "SSH_AUTH_SOCK=/s", "", true},
		{"https_proxy lower", "https_proxy=http://p", "", true},
		{"HTTP_PROXY", "HTTP_PROXY=http://p", "", true},
		{"NO_PROXY", "NO_PROXY=localhost", "", true},
		{"SSL_CERT_FILE", "SSL_CERT_FILE=/ca", "", true},
		{"NODE_EXTRA_CA_CERTS", "NODE_EXTRA_CA_CERTS=/ca", "", true},
		{"BUN_INSTALL", "BUN_INSTALL=/h/.bun", "", true},
		{"VOLTA_HOME", "VOLTA_HOME=/h/.volta", "", true},
		{"NVM_DIR", "NVM_DIR=/h/.nvm", "", true},
		{"PNPM_HOME", "PNPM_HOME=/h/pnpm", "", true},
		{"TMPDIR", "TMPDIR=/t", "", true},
		{"GOPATH", "GOPATH=/go", "", true},
		{"GOFLAGS", "GOFLAGS=-mod=mod", "", true},
		{"CARGO_HOME", "CARGO_HOME=/c", "", true},
		{"npm_config_cache", "npm_config_cache=/n", "", true},
		{"CODEX_HOME", "CODEX_HOME=/c", "", true},
		{"EMPTY value", "TZ=", "", true},
		// dropped: the old deny cases
		{"ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY=mock", "", false},
		{"ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN=a", "", false},
		{"ANTHROPIC lower", "anthropic_api_key=lower", "", false},
		{"OPENAI_ORG_ID", "OPENAI_ORG_ID=o", "", false},
		{"XAI_API_KEY", "XAI_API_KEY=x", "", false},
		{"GROK_CODE_FOO", "GROK_CODE_FOO=1", "", false},
		{"GEMINI_API_KEY", "GEMINI_API_KEY=g", "", false},
		{"GOOGLE_GENAI", "GOOGLE_GENAI_USE_VERTEXAI=1", "", false},
		{"GOOGLE_API_KEY", "GOOGLE_API_KEY=k", "", false},
		{"OPENROUTER_API_KEY", "OPENROUTER_API_KEY=r", "", false},
		{"MISTRAL_BASE_URL", "MISTRAL_BASE_URL=u", "", false},
		{"FOO_API_BASE", "FOO_API_BASE=u", "", false},
		{"proxy-looking base url", "http_proxy_BASE_URL=u", "", false},
		{"HARNESS_OCTO_KEY", "HARNESS_OCTO_KEY=s", "", false},
		{"HARNESS_DATA_DIR", "HARNESS_DATA_DIR=/d", "", false},
		{"OCTO_KEY", "OCTO_KEY=k", "", false},
		{"OCTO_HISTORY_TOKEN_KEY", "OCTO_HISTORY_TOKEN_KEY=k", "", false},
		{"OCTO_CONFIG", "OCTO_CONFIG=/c", "", false},
		{"NOEQUALS", "NOEQUALS", "", false},
		// build and cloud tool names (no credentials)
		{"GIT_AUTHOR_NAME", "GIT_AUTHOR_NAME=v", "", true},
		{"GIT_AUTHOR_EMAIL", "GIT_AUTHOR_EMAIL=v", "", true},
		{"GIT_COMMITTER_NAME", "GIT_COMMITTER_NAME=v", "", true},
		{"GIT_COMMITTER_EMAIL", "GIT_COMMITTER_EMAIL=v", "", true},
		{"GIT_EDITOR", "GIT_EDITOR=v", "", true},
		{"GIT_PAGER", "GIT_PAGER=v", "", true},
		{"GIT_TERMINAL_PROMPT", "GIT_TERMINAL_PROMPT=v", "", true},
		{"GIT_CONFIG_GLOBAL", "GIT_CONFIG_GLOBAL=v", "", true},
		{"GIT_SSH_COMMAND", "GIT_SSH_COMMAND=v", "", true},
		{"PKG_CONFIG_PATH", "PKG_CONFIG_PATH=v", "", true},
		{"LD_LIBRARY_PATH", "LD_LIBRARY_PATH=v", "", true},
		{"DYLD_LIBRARY_PATH", "DYLD_LIBRARY_PATH=v", "", true},
		{"LIBRARY_PATH", "LIBRARY_PATH=v", "", true},
		{"CPATH", "CPATH=v", "", true},
		{"DOCKER_HOST", "DOCKER_HOST=v", "", true},
		{"DOCKER_CONTEXT", "DOCKER_CONTEXT=v", "", true},
		{"KUBECONFIG", "KUBECONFIG=v", "", true},
		{"RUSTUP_TOOLCHAIN", "RUSTUP_TOOLCHAIN=v", "", true},
		{"RUSTFLAGS", "RUSTFLAGS=v", "", true},
		{"AWS_PROFILE", "AWS_PROFILE=v", "", true},
		{"AWS_REGION", "AWS_REGION=v", "", true},
		{"AWS_DEFAULT_REGION", "AWS_DEFAULT_REGION=v", "", true},
		{"AWS_CONFIG_FILE", "AWS_CONFIG_FILE=v", "", true},
		{"AWS_SHARED_CREDENTIALS_FILE", "AWS_SHARED_CREDENTIALS_FILE=v", "", true},
		// dropped: names the old deny-list let through, and unknown names
		{"MISTRAL_API_KEY", "MISTRAL_API_KEY=m", "", false},
		{"DEEPSEEK_API_KEY", "DEEPSEEK_API_KEY=d", "", false},
		{"GITHUB_TOKEN", "GITHUB_TOKEN=t", "", false},
		{"COPILOT_GITHUB_TOKEN", "COPILOT_GITHUB_TOKEN=t", "", false},
		{"FACTORY_API_KEY", "FACTORY_API_KEY=f", "", false},
		{"AWS_ACCESS_KEY_ID", "AWS_ACCESS_KEY_ID=a", "", false},
		{"AWS_SECRET_ACCESS_KEY", "AWS_SECRET_ACCESS_KEY=s", "", false},
		{"AWS_SESSION_TOKEN", "AWS_SESSION_TOKEN=t", "", false},
		{"GIT_ASKPASS", "GIT_ASKPASS=/x", "", false},
		{"GIT_TOKEN", "GIT_TOKEN=t", "", false},
		{"DOCKER_PASSWORD", "DOCKER_PASSWORD=p", "", false},
		{"KUBE_TOKEN", "KUBE_TOKEN=t", "", false},
		{"HF_TOKEN", "HF_TOKEN=h", "", false},
		{"npm authToken", "npm_config_//registry.npmjs.org/:_authToken=x", "", false},
		{"npm _auth", "npm_config__auth=x", "", false},
		{"UNKNOWN_VAR", "UNKNOWN_VAR=1", "", false},
		{"GORACE", "GORACE=x", "", false},
		{"OCTO_CODEX_HOME", "OCTO_CODEX_HOME=/c", "", false},
		// the secret rules beat the built-in rules
		{"PASSWORD under XDG", "XDG_DB_PASSWORD=p", "", false},
		{"TOKEN under LC", "LC_TOKEN=p", "", false},
		{"KEY under GOPATH-like", "GOPATH_KEY=p", "", false},
		// operator allow-list
		{"operator exact", "GITHUB_TOKEN=t", "GITHUB_TOKEN", true},
		{"operator exact lower spec", "GITHUB_TOKEN=t", " github_token ", true},
		{"operator prefix", "AWS_REGION=eu", "AWS_*", true},
		{"operator prefix beats secret words", "AWS_SECRET_ACCESS_KEY=s", "AWS_*", true},
		{"operator list", "HF_TOKEN=h", "GITHUB_TOKEN, HF_TOKEN", true},
		{"operator other name stays out", "MISTRAL_API_KEY=m", "GITHUB_TOKEN,AWS_*", false},
		{"operator cannot pass harness prefix", "HARNESS_OCTO_KEY=s", "HARNESS_*", false},
		{"operator cannot pass provider key", "ANTHROPIC_API_KEY=a", "ANTHROPIC_API_KEY", false},
		{"operator cannot pass router secret", "OCTO_KEY=k", "OCTO_KEY", false},
		{"operator star is ignored", "UNKNOWN_VAR=1", "*", false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			in := []string{tc.env}
			got := childenv.ScrubWith(in, childenv.ParseAllow(tc.op))
			if kept := len(got) == 1; kept != tc.keep {
				t.Fatalf("%q with allow %q: kept=%v, want %v (%v)", tc.env, tc.op, kept, tc.keep, got)
			}
		})
	}
}

func TestScrubKeepsOrderAndInput(t *testing.T) {
	in := []string{"B_UNKNOWN=1", "PATH=/b", "ANTHROPIC_API_KEY=k", "HOME=/h", "LANG=C"}
	orig := slices.Clone(in)
	got := childenv.ScrubWith(in, childenv.Allow{})
	if want := []string{"PATH=/b", "HOME=/h", "LANG=C"}; !slices.Equal(got, want) {
		t.Fatalf("Scrub = %v, want %v", got, want)
	}
	if !slices.Equal(in, orig) {
		t.Fatal("Scrub changed its input")
	}
}

func TestBuildExtraWinsAfterScrub(t *testing.T) {
	got := childenv.Build([]string{"PATH=/1", "XAI_API_KEY=inherited"}, map[string]string{"XAI_API_KEY": "declared"})
	want := []string{"PATH=/1", "XAI_API_KEY=declared"}
	if !slices.Equal(got, want) {
		t.Fatalf("Build = %v, want %v", got, want)
	}
}

func TestBuildExtraPassesUnlistedKey(t *testing.T) {
	got := childenv.Build([]string{"COPILOT_GITHUB_TOKEN=inherited"}, map[string]string{"COPILOT_GITHUB_TOKEN": "declared"})
	if want := []string{"COPILOT_GITHUB_TOKEN=declared"}; !slices.Equal(got, want) {
		t.Fatalf("Build = %v, want %v", got, want)
	}
}

func TestSetAllowSwapsTheOperatorListSafelyUnderConcurrency(t *testing.T) {
	t.Cleanup(func() { childenv.SetAllow("") })
	environ := []string{"PATH=/bin", "MY_TOOL_HOME=/x", "OCTO_ROUTER_UPSTREAM_KEY=secret", "OCTO_ROUTER_ENABLED=1"}
	childenv.SetAllow("MY_TOOL_*, OCTO_ROUTER_*")
	got := childenv.Scrub(environ)
	if !slices.Contains(got, "MY_TOOL_HOME=/x") {
		t.Fatalf("operator entry not passed: %v", got)
	}
	// The router's settings never reach a child, not even by allow-list.
	for _, kv := range got {
		if kv == "OCTO_ROUTER_UPSTREAM_KEY=secret" || kv == "OCTO_ROUTER_ENABLED=1" {
			t.Fatalf("router setting leaked: %v", got)
		}
	}
	childenv.SetAllow("")
	if got := childenv.Scrub(environ); slices.Contains(got, "MY_TOOL_HOME=/x") {
		t.Fatalf("allow-list not cleared: %v", got)
	}

	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := 0; i < 500; i++ {
			childenv.SetAllow("MY_TOOL_*")
			childenv.SetAllow("")
		}
	}()
	for i := 0; i < 500; i++ {
		_ = childenv.Build(environ, nil)
	}
	<-done
}

// The bridge API token never reaches a child, not even when the operator
// allow-list names it or matches it by prefix.
func TestAPITokenNeverReachesAChild(t *testing.T) {
	env := []string{"PATH=/usr/bin", "HARNESS_API_TOKEN=bridge-token-0123456789", "HARNESS_NO_API_TOKEN=1"}
	for _, op := range []string{"", "HARNESS_API_TOKEN", "HARNESS_*", "*", "harness_api_token"} {
		got := childenv.ScrubWith(env, childenv.ParseAllow(op))
		for _, kv := range got {
			if strings.Contains(kv, "bridge-token") || strings.HasPrefix(kv, "HARNESS_") {
				t.Errorf("operator allow %q lets %q through", op, kv)
			}
		}
		if !slices.Contains(got, "PATH=/usr/bin") {
			t.Errorf("operator allow %q lost PATH: %v", op, got)
		}
	}
	got := childenv.Build(env, nil)
	for _, kv := range got {
		if strings.Contains(kv, "bridge-token") {
			t.Errorf("Build passed %q", kv)
		}
	}
}
