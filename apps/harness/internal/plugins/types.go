package plugins

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
	Hint              string   `json:"hint,omitempty"`
	// InstallHint says how to install the agent (manifest `install`).
	InstallHint string `json:"install_hint,omitempty"`
	// FlatRate: the agent runs on a flat-rate subscription; set by the manifest's
	// flatRate (false when absent). Strengths are the bands it suits (optional).
	FlatRate  bool     `json:"flat_rate"`
	Strengths []string `json:"strengths,omitempty"`
	Launch

	// Requires are the manifest's extra commands (server-side; diagnostics).
	Requires []string `json:"-"`

	// ModelArg is the start-up argument template; "{model}" is replaced.
	ModelArg     []string `json:"-"`
	ProbeCommand string   `json:"-"` // resolved path; empty when there is no probe
	ProbeArgs    []string `json:"-"`
	// AuthMethods and AuthSkip steer which ACP auth methods are tried.
	AuthMethods []AuthMethodRef `json:"-"`
	AuthSkip    []string        `json:"-"`
}

type ToolServer struct {
	URL string `json:"url"`
}
