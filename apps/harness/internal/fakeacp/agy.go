package fakeacp

import (
	"fmt"
	"os"
	"slices"
	"strconv"
	"strings"
)

// The "agy" profile makes the scripted agent behave the way Google's
// Antigravity CLI documents `agy acp` (antigravity.google/docs/ide/extensions/acp,
// the CLI changelog 1.5.0-1.5.9, read 2026-11-15). It is a test double written
// from those documents, not from a run of the real CLI:
//
//   - command line: `agy --version` prints the version; `agy acp` serves ACP,
//     and a version older than 1.5.0 rejects `acp` as an unknown command
//     (the subcommand was added in 1.5.0);
//   - a banner line on stdout before the first JSON-RPC message;
//   - initialize: loadSession, promptCapabilities image and embeddedContext,
//     mcpCapabilities.http (HTTP servers need --process-per-session, so Octo's
//     manifest forces stdio), the five documented auth methods;
//   - session/new without a saved login: -32000 "Authentication required";
//     the saved login is the file named by EnvLoginFile, gemini-api-key works
//     only with GEMINI_API_KEY in the environment;
//   - session modes default, accept-edits, plan and auto, starting in auto (the
//     CLI's default Agent Mode since 1.5.8); models and the thinking level as
//     session config options;
//   - permission requests offer Allow (allow_once) and Deny (reject_once).
const (
	// EnvProfile selects a profile; "agy" is the only one.
	EnvProfile = "OCTO_FAKEACP_PROFILE"
	// EnvAgyVersion is the version the agy profile reports (default 1.5.9).
	EnvAgyVersion = "OCTO_FAKEACP_AGY_VERSION"
	// ProfileAgy is the Antigravity profile.
	ProfileAgy = "agy"
	// AgyBanner is the line the agy profile prints on stdout before speaking ACP.
	AgyBanner = "Antigravity CLI — checking for updates…"
)

// Agy auth method ids, as documented.
const (
	AgyAuthGoogle     = "oauth-personal"
	AgyAuthEnterprise = "oauth-business"
	AgyAuthAPIKey     = "gemini-api-key"
	AgyAuthPlatform   = "agent-platform"
	AgyAuthTerminal   = "terminal-login"
)

// AgyModels are the model ids the agy profile offers when EnvModels is unset
// (made-up ids for tests; the real ones depend on the account).
var AgyModels = []string{"gemini-flash", "gemini-pro"}

func agyVersion() string {
	if v := os.Getenv(EnvAgyVersion); v != "" {
		return v
	}
	return "1.5.9"
}

// agyCLI handles what the agy profile does before it speaks ACP: --version,
// --help, a missing or unknown subcommand, and a version without `acp`. done
// says the process should exit with code.
func agyCLI(args []string) (code int, done bool) {
	v := agyVersion()
	if slices.Contains(args, "--version") || slices.Contains(args, "-v") {
		fmt.Println("agy " + v)
		return 0, true
	}
	if len(args) == 0 || args[0] != "acp" || !agyHasACP(v) {
		sub := "(none)"
		if len(args) > 0 {
			sub = args[0]
		}
		fmt.Fprintf(os.Stderr, "Error: unknown command %q for \"agy\"\nRun 'agy --help' for usage.\n", sub)
		return 1, true
	}
	if slices.Contains(args[1:], "--help") {
		fmt.Println("Usage: agy acp [flags]\n\nStarts an Agent Client Protocol server on stdin and stdout.")
		return 0, true
	}
	if slices.Contains(args[1:], "--login") {
		fmt.Println("Signed in.")
		if f := os.Getenv(EnvLoginFile); f != "" {
			_ = os.WriteFile(f, []byte("signed in\n"), 0o600)
		}
		return 0, true
	}
	fmt.Println(AgyBanner)
	fmt.Println("\x1b[0m")
	return 0, false
}

// agyHasACP reports a version of 1.5.0 or newer.
func agyHasACP(v string) bool {
	parts := strings.SplitN(v, ".", 3)
	nums := [3]int{}
	for i := range parts {
		n, err := strconv.Atoi(strings.TrimFunc(parts[i], func(r rune) bool { return r < '0' || r > '9' }))
		if err != nil {
			return false
		}
		nums[i] = n
	}
	return nums[0] > 1 || (nums[0] == 1 && nums[1] >= 5)
}

// applyAgyProfile sets the options of the agy profile.
func (o *options) applyAgyProfile() {
	o.profile = ProfileAgy
	o.auth = authAgy
	o.loadSession, o.promptImage, o.embeddedContext, o.mcpHTTP = true, true, true, true
	o.modeList = []map[string]string{
		{"id": "default", "name": "Default", "description": "Asks before edits and commands"},
		{"id": "accept-edits", "name": "Accept edits"},
		{"id": "plan", "name": "Plan"},
		{"id": "auto", "name": "Auto", "description": "Approves workspace edits; sandboxed commands"},
	}
	o.startMode = "auto"
	if len(o.models) == 0 {
		o.models = slices.Clone(AgyModels)
	}
	if o.via == "" {
		o.via = "agy"
	}
	if len(o.commands) == 0 {
		o.commands = parseCommandList("usage|Show your quota and usage;skills|List the skills of this agent")
	}
	o.permOptions = []map[string]string{
		{"optionId": "allow", "name": "Allow", "kind": "allow_once"},
		{"optionId": "deny", "name": "Deny", "kind": "reject_once"},
	}
	if f := o.loginFile; f != "" {
		if _, err := os.Stat(f); err == nil {
			o.savedLogin = true
		}
	}
}

// authAgy is the auth mode of the agy profile.
const authAgy = "agy"

func agyAuthMethods() []any {
	return []any{
		map[string]any{"id": AgyAuthGoogle, "name": "Log in with Google"},
		map[string]any{"id": AgyAuthEnterprise, "name": "Log in with Gemini Enterprise"},
		map[string]any{"id": AgyAuthAPIKey, "name": "Gemini API key", "description": "Uses GEMINI_API_KEY from the agent's environment"},
		map[string]any{"id": AgyAuthPlatform, "name": "Gemini Enterprise Agent Platform"},
		map[string]any{"id": AgyAuthTerminal, "name": "Log in from the terminal", "type": "terminal"},
	}
}

// authenticateAgy serves authenticate in the agy profile: only the API key
// method can succeed here (with GEMINI_API_KEY set); the browser methods are
// what the harness must never start, so they fail and are logged.
func (a *agent) authenticateAgy(m message, id string) {
	if a.opts.authLog != "" {
		if f, err := os.OpenFile(a.opts.authLog, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644); err == nil {
			_, _ = f.WriteString(id + "\n")
			_ = f.Close()
		}
	}
	if id != AgyAuthAPIKey || os.Getenv("GEMINI_API_KEY") == "" {
		a.respondError(m.ID, -32000, "Authentication required")
		return
	}
	a.mu.Lock()
	a.authed = true
	a.mu.Unlock()
	a.respond(m.ID, map[string]any{})
}

// agyConfigOptions are the session config options of the agy profile: the
// model and the thinking level.
func (a *agent) agyConfigOptions(cur string) []any {
	models := make([]map[string]string, len(a.opts.models))
	for i, m := range a.opts.models {
		models[i] = map[string]string{"value": m, "name": agyLabel(m)}
	}
	return []any{
		map[string]any{"id": "model", "name": "Model", "category": "model", "type": "select", "currentValue": cur, "options": models},
		map[string]any{"id": "thinking", "name": "Thinking", "category": "thought_level", "type": "select", "currentValue": "medium",
			"options": []map[string]string{{"value": "low", "name": "Low"}, {"value": "medium", "name": "Medium"}, {"value": "high", "name": "High"},
				{"value": "extra", "name": "Extra"}, {"value": "max", "name": "Max"}}},
	}
}

func agyLabel(id string) string {
	words := strings.Split(id, "-")
	for i, w := range words {
		if w != "" {
			words[i] = strings.ToUpper(w[:1]) + w[1:]
		}
	}
	return strings.Join(words, " ")
}

// promptCaps is initialize's promptCapabilities.
func (o options) promptCaps() map[string]any {
	caps := map[string]any{}
	if o.promptImage {
		caps["image"] = true
	}
	if o.embeddedContext {
		caps["embeddedContext"] = true
	}
	return caps
}

// knownMode reports a mode set_mode accepts.
func (o options) knownMode(id string) bool {
	for _, m := range o.modes() {
		if m["id"] == id {
			return true
		}
	}
	return false
}

// modes are the session modes advertised (EnvModes or the profile's).
func (o options) modes() []map[string]string {
	if len(o.modeList) > 0 {
		return o.modeList
	}
	if !o.modesOn {
		return nil
	}
	return []map[string]string{
		{"id": "default", "name": "Default"}, {"id": "ask", "name": "Ask", "description": "read-only"}, {"id": "plan", "name": "Plan"},
	}
}

func (o options) firstMode() string {
	if o.startMode != "" {
		return o.startMode
	}
	return "default"
}
