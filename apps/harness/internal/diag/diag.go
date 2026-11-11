// Package diag builds the diagnostics report (`harness doctor`,
// GET /v1/diagnostics): what is needed to understand a problem report in one
// step, and nothing secret. The report names environment variables but never
// shows values, strips credentials from URLs and scrubs the log tail.
package diag

import (
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/acptrace"
	"github.com/ndolinschi/Octo/apps/harness/internal/childenv"
	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
)

// LogLines is how many log lines the report carries.
const LogLines = 200

// AgentReport is one ACP agent as the harness sees it.
type AgentReport struct {
	ID        string `json:"id"`
	Label     string `json:"label"`
	Available bool   `json:"available"`
	// Command is the resolved path of the agent's program, or "not found".
	Command           string              `json:"command"`
	UnavailableReason string              `json:"unavailable_reason,omitempty"`
	Requires          []Requirement       `json:"requires"`
	Probe             plugins.ProbeReport `json:"probe"`
	LoginHint         string              `json:"login_hint,omitempty"`
	InstallHint       string              `json:"install_hint,omitempty"`
	FlatRate          bool                `json:"flat_rate"`
}

// Requirement is one command an agent needs on PATH and whether it was found.
type Requirement struct {
	Command string `json:"command"`
	Found   string `json:"found"`
}

// RouterReport is the Octo router state.
type RouterReport struct {
	// BaseURL is the Messages API base URL with credentials and query removed.
	BaseURL      string   `json:"base_url"`
	Detected     bool     `json:"detected"`
	Capabilities []string `json:"capabilities"`
	// Note explains a router that is switched on but not running here.
	Note string `json:"note,omitempty"`
}

// RouterPendingNote is what doctor says when the router is switched on and no base URL is known.
const RouterPendingNote = "the router is started by the desktop app; doctor does not start it"

// Report is the whole diagnostics report.
type Report struct {
	GeneratedAt string `json:"generated_at"`
	Version     string `json:"version"`
	GoVersion   string `json:"go_version"`
	OS          string `json:"os"`
	Arch        string `json:"arch"`
	DataDir     string `json:"data_dir"`
	// DataDirWhy says why this directory was inspected (doctor only).
	DataDirWhy string `json:"data_dir_why,omitempty"`
	// PathForChildren is the PATH child processes (agents, bash) get.
	PathForChildren string `json:"path_for_children"`
	// EnvSet names the provider and router variables that are set in the
	// harness's environment (names only).
	EnvSet      []string      `json:"env_set"`
	BuiltinLoop BuiltinReport `json:"builtin_loop"`
	Router      RouterReport  `json:"router"`
	Agents      []AgentReport `json:"agents"`
	// ACPTrace says whether the wire trace is on and lists its files.
	ACPTrace TraceReport `json:"acp_trace"`
	LogTail  []string    `json:"log_tail"`
	Problems []string    `json:"problems"`
}

// BuiltinReport is whether the Messages-API loop can run.
type BuiltinReport struct {
	Available bool   `json:"available"`
	Reason    string `json:"reason,omitempty"`
}

// TraceReport is the state of the ACP wire trace.
type TraceReport struct {
	Enabled bool     `json:"enabled"`
	Dir     string   `json:"dir"`
	Files   []string `json:"files"`
}

// Inputs is what Build reports on.
type Inputs struct {
	Version    string
	DataDir    string
	Agents     []plugins.Agent
	BuiltinOK  bool
	BuiltinWhy string
	BaseURL    string
	RouterOn   bool
	RouterCaps []string
	Log        *LogRing
	// Probe, when set, runs each agent's login probe now (doctor); otherwise the
	// cached background result is reported.
	Probe func(plugins.Agent) plugins.ProbeReport
	Env   []string
	// DataDirWhy says why DataDir was chosen (doctor).
	DataDirWhy string
	// RouterPending: OCTO_ROUTER_ENABLED is set but no base URL is known, because the
	// desktop app starts the router and doctor does not. The built-in loop is then
	// not reported as broken.
	RouterPending bool
}

// secretNamed marks environment names whose presence is worth reporting.
var interesting = regexp.MustCompile(`^(ANTHROPIC_|OPENAI_|XAI_|GROK_|GEMINI_|OPENROUTER_|COPILOT_|OCTO_|HARNESS_)`)

// Build assembles the report.
func Build(in Inputs) Report {
	env := in.Env
	if env == nil {
		env = os.Environ()
	}
	r := Report{
		GeneratedAt: time.Now().UTC().Format(time.RFC3339), Version: in.Version, GoVersion: runtime.Version(),
		OS: runtime.GOOS, Arch: runtime.GOARCH, DataDir: in.DataDir, DataDirWhy: in.DataDirWhy, EnvSet: []string{}, Problems: []string{},
		BuiltinLoop: BuiltinReport{Available: in.BuiltinOK, Reason: in.BuiltinWhy},
		Router:      RouterReport{BaseURL: StripURL(in.BaseURL), Detected: in.RouterOn, Capabilities: append([]string{}, in.RouterCaps...)},
		Agents:      []AgentReport{}, LogTail: []string{},
	}
	for _, kv := range childenv.Build(env, nil) {
		if v, ok := strings.CutPrefix(kv, "PATH="); ok {
			r.PathForChildren = dedupePath(v)
		}
	}
	for _, kv := range env {
		if name, val, ok := strings.Cut(kv, "="); ok && val != "" && interesting.MatchString(strings.ToUpper(name)) {
			r.EnvSet = append(r.EnvSet, name)
		}
	}
	sort.Strings(r.EnvSet)
	for _, a := range in.Agents {
		ar := AgentReport{
			ID: a.ID, Label: a.Label, Available: a.Available, UnavailableReason: a.UnavailableReason,
			LoginHint: a.Hint, InstallHint: a.InstallHint, FlatRate: a.FlatRate, Requires: []Requirement{}, Command: "not found",
		}
		if a.Available {
			ar.Command = a.Command
		}
		for _, req := range a.Requires {
			found := "not found"
			if p, ok := plugins.Which(req); ok {
				found = p
			}
			ar.Requires = append(ar.Requires, Requirement{Command: req, Found: found})
		}
		if in.Probe != nil {
			ar.Probe = in.Probe(a)
		} else {
			ar.Probe = a.LastProbe()
		}
		r.Agents = append(r.Agents, ar)
		switch {
		case !a.Available:
			r.Problems = append(r.Problems, fmt.Sprintf("%s: not available (%s). %s", a.ID, a.UnavailableReason, a.InstallHint))
		case ar.Probe.LoggedIn != nil && !*ar.Probe.LoggedIn:
			r.Problems = append(r.Problems, fmt.Sprintf("%s: not logged in. %s", a.ID, a.Hint))
		}
	}
	switch {
	case !in.BuiltinOK && in.RouterPending:
		r.Router.Note = RouterPendingNote
		r.BuiltinLoop = BuiltinReport{Available: false, Reason: "not checked: " + RouterPendingNote}
	case !in.BuiltinOK:
		r.Problems = append(r.Problems, "the built-in agent loop is unavailable: "+in.BuiltinWhy)
	case in.RouterPending:
		r.Router.Note = RouterPendingNote
	}
	r.ACPTrace = TraceReport{Enabled: acptrace.Enabled(), Dir: acptrace.Dir(), Files: acptrace.Files()}
	if in.Log != nil {
		r.LogTail = in.Log.Lines(LogLines)
	}
	return r
}

// dedupePath drops repeated entries of a PATH, keeping the first of each.
func dedupePath(p string) string {
	seen := map[string]bool{}
	var out []string
	for _, e := range filepath.SplitList(p) {
		if e == "" || seen[e] {
			continue
		}
		seen[e] = true
		out = append(out, e)
	}
	return strings.Join(out, string(filepath.ListSeparator))
}

// StripURL removes credentials, query and fragment from a URL; text that is
// not a URL is replaced by "(unparsable)" rather than echoed.
func StripURL(raw string) string {
	if raw == "" {
		return ""
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return "(unparsable)"
	}
	u.User, u.RawQuery, u.Fragment = nil, "", ""
	return u.String()
}

// Text renders the report for a terminal or a pasted bug report.
func (r Report) Text() string {
	var b strings.Builder
	fmt.Fprintf(&b, "Octo harness diagnostics (%s)\n", r.GeneratedAt)
	fmt.Fprintf(&b, "version %s, %s, %s/%s\ndata dir: %s\n", r.Version, r.GoVersion, r.OS, r.Arch, r.DataDir)
	if r.DataDirWhy != "" {
		fmt.Fprintf(&b, "  (used because: %s)\n", r.DataDirWhy)
	}
	fmt.Fprintf(&b, "PATH for child processes: %s\n", r.PathForChildren)
	fmt.Fprintf(&b, "provider/router variables set: %s\n", strings.Join(r.EnvSet, ", "))
	fmt.Fprintf(&b, "built-in loop: available=%v %s\n", r.BuiltinLoop.Available, r.BuiltinLoop.Reason)
	fmt.Fprintf(&b, "router: base url %q, detected=%v, capabilities=%s\n", r.Router.BaseURL, r.Router.Detected, strings.Join(r.Router.Capabilities, ","))
	if r.Router.Note != "" {
		fmt.Fprintf(&b, "  note: %s\n", r.Router.Note)
	}
	fmt.Fprintf(&b, "\nAgents\n")
	for _, a := range r.Agents {
		state := "ready"
		switch {
		case !a.Available:
			state = "not installed / not available"
		case a.Probe.LoggedIn != nil && !*a.Probe.LoggedIn:
			state = "not logged in"
		case a.Probe.LoggedIn == nil:
			state = "available, login unknown"
		}
		fmt.Fprintf(&b, "- %s (%s): %s\n    command: %s\n    probe: %s\n", a.ID, a.Label, state, a.Command, a.Probe.Reason)
		for _, q := range a.Requires {
			fmt.Fprintf(&b, "    requires %s: %s\n", q.Command, q.Found)
		}
		if a.UnavailableReason != "" {
			fmt.Fprintf(&b, "    unavailable: %s\n", a.UnavailableReason)
		}
		if a.InstallHint != "" {
			fmt.Fprintf(&b, "    install: %s\n", a.InstallHint)
		}
		if a.LoginHint != "" {
			fmt.Fprintf(&b, "    login: %s\n", a.LoginHint)
		}
	}
	if len(r.Problems) > 0 {
		fmt.Fprintf(&b, "\nProblems\n")
		for _, p := range r.Problems {
			fmt.Fprintf(&b, "- %s\n", p)
		}
	}
	fmt.Fprintf(&b, "\nACP wire trace: enabled=%v dir=%s\n", r.ACPTrace.Enabled, r.ACPTrace.Dir)
	for _, f := range r.ACPTrace.Files {
		fmt.Fprintf(&b, "  %s\n", f)
	}
	if len(r.LogTail) > 0 {
		fmt.Fprintf(&b, "\nLast %d log lines\n%s\n", len(r.LogTail), strings.Join(r.LogTail, "\n"))
	}
	return b.String()
}
