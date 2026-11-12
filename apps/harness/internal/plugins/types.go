package plugins

import "regexp"

// Plugin is one loaded manifest. The JSON form is the GET /v1/plugins shape;
// commands, args and env stay server-side.
type Plugin struct {
	Name            string           `json:"name"`
	Version         string           `json:"version"`
	Description     string           `json:"description"`
	LanguageServers []LanguageServer `json:"language_servers"`
	Agents          []Agent          `json:"agents"`
	ToolServers     []ToolServer     `json:"tool_servers"`
	Errors          []string         `json:"errors"`
	// Builtin marks a plugin embedded in the harness binary.
	Builtin bool `json:"builtin,omitempty"`

	Dir string `json:"-"`
}

// Launch says how to start a plugin's program.
type Launch struct {
	Command string            `json:"-"` // resolved path, or the manifest value when unresolved
	Args    []string          `json:"-"`
	Env     map[string]string `json:"-"`
	Dir     string            `json:"-"` // plugin directory
}

type LanguageServer struct {
	ID        string   `json:"id"`
	Label     string   `json:"label"`
	Languages []string `json:"languages"`
	Available bool     `json:"available"`
	Launch
}

// Agent is one ACP agent. ModelArg, ProbeCommand and ProbeArgs stay
// server-side; LoggedIn is filled from the background probe when the registry
// serves the agent and is nil when there is no probe or no result yet.
type Agent struct {
	ID        string `json:"id"`
	Label     string `json:"label"`
	Available bool   `json:"available"`
	// UnavailableReason says what is missing when Available is false.
	UnavailableReason string   `json:"unavailable_reason,omitempty"`
	LoggedIn          *bool    `json:"logged_in"`
	Models            []string `json:"models"`
	DefaultModel      string   `json:"default_model,omitempty"`
	// ModelLabels are the manifest's display names for some of Models; ModelsNote
	// is its one-line remark on where the list comes from.
	ModelLabels map[string]string `json:"model_labels,omitempty"`
	ModelsNote  string            `json:"models_note,omitempty"`
	Hint        string            `json:"hint,omitempty"`
	// InstallHint says how to install the agent (manifest `install`).
	InstallHint string `json:"install_hint,omitempty"`
	// FlatRate: the agent runs on a flat-rate subscription; set by the manifest's
	// flatRate (false when absent). Strengths are the bands it suits (optional).
	FlatRate  bool     `json:"flat_rate"`
	Strengths []string `json:"strengths,omitempty"`
	// BillingEnv: variables that make a flat-rate agent bill per token when set
	// in its environment (manifest billingEnv). FlatRate is already false in
	// listings when the harness's own environment sets one.
	BillingEnv []string `json:"billing_env,omitempty"`
	// Verified: the launch command was run with Octo by the owner (manifest
	// verified); false lists the agent as experimental. VerifiedNote says how far.
	Verified     bool   `json:"verified"`
	VerifiedNote string `json:"verified_note,omitempty"`
	// Unsupported is why the agent cannot work with Octo (manifest unsupported);
	// Available is false for it and nothing ever starts or probes it.
	Unsupported string `json:"unsupported,omitempty"`
	// StartHint is the manifest's remark for a launch rejected by the CLI.
	StartHint string `json:"-"`
	Launch

	// Requires are the manifest's extra commands (server-side; diagnostics).
	Requires []string `json:"-"`

	// ModelArg is the start-up argument template; "{model}" is replaced.
	ModelArg []string `json:"-"`
	// ModelsCommand lists the agent's models by running a command (nil: none).
	ModelsCommand *ModelsCommand `json:"-"`
	ProbeCommand  string         `json:"-"` // resolved path; empty when there is no probe
	ProbeArgs     []string       `json:"-"`
	// ProbeNotLoggedIn, when set, turns a probe whose output matches it into "logged out".
	ProbeNotLoggedIn *regexp.Regexp `json:"-"`
	// ProbeNotLoggedInExit lists the probe exit statuses that mean "logged out".
	ProbeNotLoggedInExit []int `json:"-"`
	// Roles are the models this agent uses for delegations decided fast, balanced
	// or deep (manifest `roles`, overlaid by the user's own); PreferredModel is
	// the model used when `acp:<id>` names none. Both are filled by the providers
	// service when it serves the agent; empty means the agent's own default.
	// ProbeDone says the login probe has run at least once and is not running now
	// (LoggedIn nil then means "unchecked", not "not asked yet").
	ProbeDone bool `json:"-"`
	// LastReport is how the last background probe came out (filled by the
	// registry, like LoggedIn).
	LastReport     ProbeReport       `json:"-"`
	Roles          map[string]string `json:"-"`
	PreferredModel string            `json:"-"`
	// AuthMethods and AuthSkip steer which ACP auth methods are tried.
	AuthMethods []AuthMethodRef `json:"-"`
	AuthSkip    []string        `json:"-"`
}

type ToolServer struct {
	URL string `json:"url"`
}

// PerTokenIn reports whether env (the environment the agent is started with)
// carries one of the agent's billingEnv variables, which makes a flat-rate
// agent bill per token.
func (a Agent) PerTokenIn(env map[string]string) bool {
	for _, k := range a.BillingEnv {
		if env[k] != "" {
			return true
		}
	}
	return false
}

// FlatRateIn is FlatRate for an agent started with env.
func (a Agent) FlatRateIn(env map[string]string) bool { return a.FlatRate && !a.PerTokenIn(env) }
