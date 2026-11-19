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
	// Experimental: the launch command has not been run with Octo (manifest verified).
	Experimental bool `json:"experimental"`
	// Unsupported says why the agent cannot work with Octo (its CLI has no ACP mode); empty when it can.
	Unsupported string `json:"unsupported,omitempty"`
	// Version is the CLI's version check, for an agent whose manifest has one
	// (nil otherwise): the version read, the lowest that works, too_old.
	Version *plugins.VersionReport `json:"version,omitempty"`
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
	EnvSet []string `json:"env_set"`
	// ShellEnvSet names which of the variables the desktop app forwards from the
	// login shell (locale, XDG dirs, SSH_AUTH_SOCK, tool homes, proxy and CA
	// settings, TMPDIR) child processes get (names only, never values). A
	// missing one explains "works in my terminal" failures.
	ShellEnvSet []string      `json:"shell_env_set"`
	BuiltinLoop BuiltinReport `json:"builtin_loop"`
	Router      RouterReport  `json:"router"`
	// Cloudflared is the tunnel program remote access runs (nil when not looked for).
	Cloudflared *CloudflaredReport `json:"cloudflared,omitempty"`
	Agents      []AgentReport      `json:"agents"`
	// ACPTrace says whether the wire trace is on and lists its files.
	ACPTrace TraceReport `json:"acp_trace"`
	LogTail  []string    `json:"log_tail"`
	Problems []string    `json:"problems"`
	// PluginProblems lists every plugin error (also in Problems).
	PluginProblems []PluginProblem `json:"plugin_problems"`
	// ModelAPI is the model probe's result (nil when the built-in loop is off or nothing probed).
	ModelAPI *ModelAPIReport `json:"model_api,omitempty"`
	// ShowProbeOutput makes Text print the first lines of each probe's output
	// (`harness doctor --show-probe-output`). Never in JSON, never served.
	ShowProbeOutput bool `json:"-"`
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
	// CheckVersion, when set, runs each agent's version check now (doctor);
	// otherwise the cached background result is reported.
	CheckVersion func(plugins.Agent) plugins.VersionReport
	Env          []string
	// DataDirWhy says why DataDir was chosen (doctor).
	DataDirWhy string
	// ShowProbeOutput: see Report.ShowProbeOutput.
	ShowProbeOutput bool
	// RouterPending: OCTO_ROUTER_ENABLED is set but no base URL is known, because the
	// desktop app starts the router and doctor does not. The built-in loop is then
	// not reported as broken.
	RouterPending bool
	// Cloudflared: see Report.Cloudflared.
	Cloudflared *CloudflaredReport
	// Plugins are the loaded plugins; each one's errors (a manifest that does not parse, an agent without an id or a
	// command) is a problem of the report.
	Plugins []plugins.Plugin
	// ModelProbe, when set, asks the built-in loop's model API now (a short timeout): reachable, unreachable or
	// unauthorized, and what was seen.
	ModelProbe func() (state, detail string)
}

// PluginProblem is one error of a plugin: its name, its manifest file and the error.
type PluginProblem struct {
	Plugin   string `json:"plugin"`
	Manifest string `json:"manifest"`
	Error    string `json:"error"`
}

// ModelAPIReport is whether the built-in loop's model API answers.
type ModelAPIReport struct {
	State  string `json:"state"`
	Detail string `json:"detail"`
}

// CloudflaredReport is whether Cloudflare's tunnel program (remote access) is installed.
type CloudflaredReport struct {
	Found   bool   `json:"found"`
	Path    string `json:"path,omitempty"`
	Version string `json:"version,omitempty"`
	Install string `json:"install,omitempty"`
}

// secretNamed marks environment names whose presence is worth reporting.
var interesting = regexp.MustCompile(`^(ANTHROPIC_|OPENAI_|XAI_|GROK_|GEMINI_|OPENROUTER_|COPILOT_|OCTO_|HARNESS_)`)

// shellForwardedExact mirrors the desktop shell's allow-list (apps/desktop/src-tauri/sidecar/src/shellenv.rs,
// FORWARD_EXACT and FORWARD_PREFIXES) minus PATH, which has its own line.
var shellForwardedExact = map[string]bool{
	"LANG": true, "XDG_CONFIG_HOME": true, "XDG_DATA_HOME": true, "XDG_STATE_HOME": true, "XDG_CACHE_HOME": true,
	"SSH_AUTH_SOCK": true, "NVM_DIR": true, "BUN_INSTALL": true, "PNPM_HOME": true, "VOLTA_HOME": true,
	"HTTP_PROXY": true, "HTTPS_PROXY": true, "NO_PROXY": true, "http_proxy": true, "https_proxy": true, "no_proxy": true,
	"SSL_CERT_FILE": true, "NODE_EXTRA_CA_CERTS": true, "TMPDIR": true,
	"SHELL": true, "USER": true, "LOGNAME": true, "TERM": true,
}

func shellForwarded(name string) bool {
	return shellForwardedExact[name] || strings.HasPrefix(name, "LC_")
}

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
		Agents:      []AgentReport{}, LogTail: []string{}, ShowProbeOutput: in.ShowProbeOutput,
		Cloudflared: in.Cloudflared,
	}
	r.ShellEnvSet = []string{}
	for _, kv := range childenv.Build(env, nil) {
		name, v, _ := strings.Cut(kv, "=")
		if name == "PATH" {
			r.PathForChildren = dedupePath(v)
		} else if v != "" && shellForwarded(name) {
			r.ShellEnvSet = append(r.ShellEnvSet, name)
		}
	}
	sort.Strings(r.ShellEnvSet)
	for _, kv := range env {
		if name, val, ok := strings.Cut(kv, "="); ok && val != "" && interesting.MatchString(strings.ToUpper(name)) {
			r.EnvSet = append(r.EnvSet, name)
		}
	}
	sort.Strings(r.EnvSet)
	for _, a := range in.Agents {
		ar := AgentReport{
			ID: a.ID, Label: a.Label, Available: a.Available, UnavailableReason: a.UnavailableReason,
			LoginHint: a.Hint, InstallHint: a.InstallHint, FlatRate: a.FlatRate, Experimental: !a.Verified, Unsupported: a.Unsupported, Requires: []Requirement{}, Command: "not found",
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
		if a.HasVersionCheck() && a.Unsupported == "" {
			v := a.Version
			switch {
			case !a.Available && !a.VersionTooOld:
				v = plugins.VersionReport{Reason: "not checked: the agent's program was not found"}
			case in.CheckVersion != nil:
				v = in.CheckVersion(a)
			case !v.Ran && v.Reason == "":
				v.Reason = "not checked yet"
			}
			v.Min = a.MinVersion
			ar.Version = &v
			if v.TooOld {
				ar.Available = false
			}
		}
		r.Agents = append(r.Agents, ar)
		switch {
		case a.Unsupported != "":
			// Not a problem to fix: the agent is listed as not supported.
		case ar.Version != nil && ar.Version.TooOld:
			r.Problems = append(r.Problems, withHint(fmt.Sprintf("%s: too old (%s).", a.ID, ar.Version.Reason), "Update it: ", a.InstallHint))
		case !a.Available:
			r.Problems = append(r.Problems, withHint(fmt.Sprintf("%s: not available (%s).", a.ID, a.UnavailableReason), "", a.InstallHint))
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
	r.PluginProblems = []PluginProblem{}
	for _, p := range in.Plugins {
		manifest := "(built in)"
		if p.Dir != "" {
			manifest = filepath.Join(p.Dir, plugins.ManifestName)
		}
		for _, e := range p.Errors {
			r.PluginProblems = append(r.PluginProblems, PluginProblem{Plugin: p.Name, Manifest: manifest, Error: e})
			r.Problems = append(r.Problems, fmt.Sprintf("plugin %s (%s): %s", p.Name, manifest, e))
		}
	}
	if in.BuiltinOK && in.ModelProbe != nil {
		state, detail := in.ModelProbe()
		r.ModelAPI = &ModelAPIReport{State: state, Detail: detail}
		if state != "reachable" {
			r.Problems = append(r.Problems, fmt.Sprintf("the built-in agent loop's model API is %s: %s", state, detail))
		}
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
	fmt.Fprintf(&b, "login-shell variables child processes get (names only): %s\n", strings.Join(r.ShellEnvSet, ", "))
	fmt.Fprintf(&b, "provider/router variables set: %s\n", strings.Join(r.EnvSet, ", "))
	fmt.Fprintf(&b, "built-in loop: available=%v %s\n", r.BuiltinLoop.Available, r.BuiltinLoop.Reason)
	if m := r.ModelAPI; m != nil {
		fmt.Fprintf(&b, "  model API: %s (%s)\n", m.State, m.Detail)
	}
	fmt.Fprintf(&b, "router: base url %q, detected=%v, capabilities=%s\n", r.Router.BaseURL, r.Router.Detected, strings.Join(r.Router.Capabilities, ","))
	if r.Router.Note != "" {
		fmt.Fprintf(&b, "  note: %s\n", r.Router.Note)
	}
	if c := r.Cloudflared; c != nil {
		if c.Found {
			fmt.Fprintf(&b, "cloudflared: found %s (%s)\n", c.Path, c.Version)
		} else {
			fmt.Fprintf(&b, "cloudflared: not found (remote access needs it: %s)\n", c.Install)
		}
	}
	fmt.Fprintf(&b, "\nAgents\n")
	for _, a := range r.Agents {
		state := "ready"
		switch {
		case a.Unsupported != "":
			state = "not supported: " + a.Unsupported
		case a.Version != nil && a.Version.TooOld:
			state = "too old: update it"
		case !a.Available:
			state = "not installed / not available"
		case a.Probe.LoggedIn != nil && !*a.Probe.LoggedIn:
			state = "not logged in"
		case a.Probe.LoggedIn == nil:
			state = "available, login unknown"
		}
		fmt.Fprintf(&b, "- %s (%s): %s\n    command: %s\n    probe: %s\n", a.ID, a.Label, state, a.Command, a.Probe.Reason)
		if a.Experimental {
			fmt.Fprintf(&b, "    experimental: the launch command comes from the agent's documentation and has not been run with Octo\n")
		}
		if a.Probe.Rule != "" && a.Probe.Rule != plugins.RuleNone {
			status := "none (no exit)"
			if a.Probe.ExitStatus != nil {
				status = fmt.Sprint(*a.Probe.ExitStatus)
			}
			fmt.Fprintf(&b, "    probe decided by: %s; exit status: %s; took %d ms; working directory: %s\n    probe environment (names only): %s\n",
				a.Probe.Rule, status, a.Probe.DurationMS, a.Probe.Dir, strings.Join(a.Probe.EnvNames, ", "))
		}
		if r.ShowProbeOutput && a.Probe.Ran {
			fmt.Fprintf(&b, "    probe output (first %d lines):\n", len(a.Probe.Output))
			for _, l := range a.Probe.Output {
				fmt.Fprintf(&b, "      | %s\n", l)
			}
		}
		if v := a.Version; v != nil {
			fmt.Fprintf(&b, "    version: %s\n", v.Reason)
		}
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

// withHint appends " prefix+hint" to a sentence, or nothing when the agent has no hint (not a dangling ". ").
func withHint(sentence, prefix, hint string) string {
	if strings.TrimSpace(hint) == "" {
		return sentence
	}
	return sentence + " " + prefix + hint
}
