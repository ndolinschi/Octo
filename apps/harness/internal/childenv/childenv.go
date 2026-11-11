// Package childenv builds the environment of processes the harness starts on
// a plugin's behalf (ACP agents, language servers, login probes).
package childenv

import "strings"

// Names and prefixes removed from the inherited environment. Subscription
// agents must not see the harness's own provider keys or endpoints: they can
// push a CLI onto per-token billing or onto a mock server.
var (
	prefixes = []string{
		"ANTHROPIC_", "OPENAI_", "XAI_", "GROK_CODE_", "GEMINI_", "GOOGLE_GENAI_",
		"GOOGLE_API_KEY", "OPENROUTER_", "HARNESS_",
	}
	suffixes = []string{"_BASE_URL", "_API_BASE"}
	// exact names: Octo router and harness secrets and config paths.
	exact = map[string]bool{"OCTO_KEY": true, "OCTO_HISTORY_TOKEN_KEY": true, "OCTO_CONFIG": true}
)

// Scrub returns environ (KEY=VALUE entries) without provider credentials,
// endpoint overrides and the harness's own settings. The input is not changed.
func Scrub(environ []string) []string {
	out := make([]string, 0, len(environ))
	for _, kv := range environ {
		name, _, _ := strings.Cut(kv, "=")
		if !scrubbed(strings.ToUpper(name)) {
			out = append(out, kv)
		}
	}
	return out
}

func scrubbed(name string) bool {
	if exact[name] {
		return true
	}
	for _, p := range prefixes {
		if strings.HasPrefix(name, p) {
			return true
		}
	}
	for _, s := range suffixes {
		if strings.HasSuffix(name, s) {
			return true
		}
	}
	return false
}

// Build is the scrubbed inherited environment followed by extra (the
// manifest's resolved env), so extra deliberately wins and can pass a key.
func Build(environ []string, extra map[string]string) []string {
	env := Scrub(environ)
	for k, v := range extra {
		env = append(env, k+"="+v)
	}
	return env
}
