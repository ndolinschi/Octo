// Package settings is the settings screen's backend: a fixed list of settings
// stored as KEY=VALUE lines in {data-dir}/harness.env (the file the harness
// reads at start, see config.LoadEnvFile). It reads the file, reports each
// setting with where its value comes from, validates and writes changes
// atomically, applies those that can take effect at once and says which others
// need a restart.
//
// Secret values are write-only: they are never returned, logged, put in an
// error or in an event. Setting ids are the variable names, so the file stays
// readable by hand and by the desktop shell.
package settings

import (
	"fmt"
	"os"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"unicode/utf8"

	"github.com/ndolinschi/Octo/apps/harness/internal/childenv"
	"github.com/ndolinschi/Octo/apps/harness/internal/config"
	"github.com/ndolinschi/Octo/apps/harness/internal/features"
)

// Kinds, groups, sources and apply modes of the wire format.
const (
	KindSecret = "secret"
	KindText   = "text"
	KindBool   = "bool"
	KindModel  = "model"
	KindList   = "list"

	GroupKeys     = "keys"
	GroupModels   = "models"
	GroupRouter   = "router"
	GroupAdvanced = "advanced"

	SourceFile        = "file"
	SourceEnvironment = "environment"
	SourceFlag        = "flag"
	SourceDefault     = "default"

	AppliesNow     = "now"
	AppliesRestart = "restart"
)

// The setting ids (= variable names in harness.env).
const (
	IDAnthropicKey      = "ANTHROPIC_API_KEY"
	IDRouterUpstream    = "OCTO_ROUTER_UPSTREAM_KEY"
	IDModelOrch         = "HARNESS_MODEL_ORCHESTRATOR"
	IDModelFast         = "HARNESS_MODEL_FAST"
	IDModelBalanced     = "HARNESS_MODEL_BALANCED"
	IDModelDeep         = "HARNESS_MODEL_DEEP"
	IDModelCompletion   = "HARNESS_MODEL_COMPLETION"
	IDOllamaBaseURL     = "HARNESS_OLLAMA_BASE_URL"
	IDRouterEnabled     = "OCTO_ROUTER_ENABLED"
	IDRouterBaseURL     = "OCTO_ROUTER_BASE_URL"
	IDChildEnvAllow     = childenv.AllowEnvVar // HARNESS_CHILD_ENV_ALLOW
	IDACPTrace          = "HARNESS_ACP_TRACE"
	IDFeatureAutoMemory = "HARNESS_FEATURE_AUTO_MEMORY"
	IDEscalateOnFailure = "HARNESS_DELEGATION_ESCALATE_ON_FAILURE"
)

const (
	maxSecretLen = 512
	maxTextLen   = 2048
	maxModelLen  = 200
	maxListItems = 100
	maxItemLen   = 100
)

// Setting is one entry of GET /v1/settings. Value is absent for secrets (and
// for a text or list setting that is not set); Set says whether a value exists.
type Setting struct {
	ID    string `json:"id"`
	Kind  string `json:"kind"`
	Label string `json:"label"`
	Group string `json:"group"`
	Value any    `json:"value,omitempty"`
	Set   bool   `json:"set"`
	Hint  string `json:"hint,omitempty"`
	// Note says why a setting cannot be edited when the reason is not obvious.
	Note     string `json:"note,omitempty"`
	Source   string `json:"source"`
	Applies  string `json:"applies"`
	Editable bool   `json:"editable"`
}

// View is the body of GET and PUT /v1/settings.
type View struct {
	Settings        []Setting `json:"settings"`
	RestartRequired []string  `json:"restart_required"`
}

// Update is the body of PUT /v1/settings. Values stay raw until validated
// against the kind of their setting.
type Update struct {
	Set   map[string]any `json:"set,omitempty"`
	Unset []string       `json:"unset,omitempty"`
}

// Error is a request the manager refuses; the message never contains a value.
type Error struct {
	Code    string
	Message string
}

func (e *Error) Error() string { return e.Message }

func invalid(code, format string, a ...any) *Error {
	return &Error{Code: code, Message: fmt.Sprintf(format, a...)}
}

type def struct {
	id      string
	kind    string
	label   string
	group   string
	applies string
	hint    string
	// builtin is the value used when nothing is set ("" = none).
	builtin func() string
}

var defs = []def{
	{id: IDAnthropicKey, kind: KindSecret, label: "Anthropic API key", group: GroupKeys, applies: AppliesRestart},
	{id: IDRouterUpstream, kind: KindSecret, label: "Router upstream key (for example OpenRouter)", group: GroupRouter, applies: AppliesRestart},
	{id: IDModelOrch, kind: KindModel, label: "Default orchestrator", group: GroupModels, applies: AppliesNow,
		hint: "A model id or acp:<agent-id>[/<model>]. Used by projects created from now on.", builtin: func() string { return config.BuiltinModels().Orchestrator }},
	{id: IDModelFast, kind: KindModel, label: "Fast tier model", group: GroupModels, applies: AppliesNow,
		builtin: func() string { return config.BuiltinModels().Fast }},
	{id: IDModelBalanced, kind: KindModel, label: "Balanced tier model", group: GroupModels, applies: AppliesNow,
		builtin: func() string { return config.BuiltinModels().Balanced }},
	{id: IDModelDeep, kind: KindModel, label: "Deep tier model", group: GroupModels, applies: AppliesNow,
		builtin: func() string { return config.BuiltinModels().Deep }},
	{id: IDModelCompletion, kind: KindModel, label: "Inline completion model (Ollama small tier)", group: GroupModels, applies: AppliesNow,
		hint: "Ollama model tag used when inline completion runs through the dedicated small tier.", builtin: func() string { return config.DefaultOllamaSmallModel }},
	{id: IDOllamaBaseURL, kind: KindText, label: "Ollama server URL", group: GroupModels, applies: AppliesNow,
		hint: "Base URL of the Ollama server for the small inline-completion tier (default http://127.0.0.1:11434)."},
	{id: IDRouterEnabled, kind: KindBool, label: "Use the Octo router", group: GroupRouter, applies: AppliesRestart,
		hint: "Read by the desktop app, which starts the router; the harness only stores it."},
	{id: IDRouterBaseURL, kind: KindText, label: "External router URL", group: GroupRouter, applies: AppliesRestart,
		hint: "Leave empty to use the router bundled with the app."},
	{id: IDChildEnvAllow, kind: KindList, label: "Environment variables passed to agents and tools", group: GroupAdvanced, applies: AppliesNow,
		hint: "Names or PREFIX_* patterns, on top of the built-in allow-list. Secrets of the harness itself are never passed."},
	{id: IDACPTrace, kind: KindBool, label: "Record an ACP wire trace", group: GroupAdvanced, applies: AppliesNow,
		hint: "One file per agent session under the data folder's traces directory, secrets removed, size-capped. Turn on to diagnose a failing agent, then send the file with the diagnostics report."},
	{id: IDFeatureAutoMemory, kind: KindBool, label: "Auto-memory prompt & digest", group: GroupAdvanced, applies: AppliesNow,
		hint: "Prompt before saving remembered items when project auto-memory is off and digest completed turns when allowed.", builtin: func() string { return "true" }},
	{id: IDEscalateOnFailure, kind: KindBool, label: "Retry a failed delegation once on a stronger candidate", group: GroupRouter, applies: AppliesNow,
		hint: "Policy delegation.escalate_on_failure: on = once, off = off. Only for sub-agents the router chose (tier auto); never for a stopped run, never twice, within the project budget."},
}

// IDs returns every setting id, in display order.
func IDs() []string {
	out := make([]string, len(defs))
	for i, d := range defs {
		out[i] = d.id
	}
	return out
}

func find(id string) (def, bool) {
	for _, d := range defs {
		if d.id == id {
			return d, true
		}
	}
	return def{}, false
}

// Applier receives the settings that take effect at once.
type Applier struct {
	// Models swaps the default orchestrator and tier models.
	Models func(orchestrator, fast, balanced, deep string)
	// Ollama swaps the base URL and small-tier model used for inline completion.
	Ollama func(baseURL, model string)
	// ChildEnvAllow swaps the operator allow-list for child processes.
	ChildEnvAllow func(spec string)
	// ACPTrace switches the ACP wire trace for sessions that start afterwards.
	ACPTrace func(on bool)
	// Features switches a live feature flag in the running process.
	Features func(id string, on bool)
	// APIKey swaps the Messages API key of the running process ("" when the
	// setting was removed). With it ANTHROPIC_API_KEY applies at once (the
	// built-in loop becomes ready without a restart); without it the key needs
	// a restart.
	APIKey func(key string)
}

// Options configures a Manager.
type Options struct {
	DataDir string
	// FromFile names the variables config.LoadEnvFile copied from harness.env
	// into the process environment at start (its return value). Any other
	// variable present in the environment came from outside and wins.
	FromFile []string
	// Lookup reads the process environment (default os.LookupEnv).
	Lookup func(string) (string, bool)
	// ValidateModels checks acp: references of the model values being set
	// (project.Service.ValidateModels); nil skips that check.
	ValidateModels func(*config.Models) error
	Apply          Applier
	// Notify is told the ids a PUT changed, after the change is applied.
	Notify func(ids []string)
}

// Manager serves GET and PUT /v1/settings.
type Manager struct {
	opts     Options
	fromFile map[string]bool
	// baseline is, per restart-applied setting, the value the process started
	// with (absent = unset): a setting needs a restart while the file differs.
	baseline map[string]string

	mu sync.Mutex // serializes file reads and writes
}

// New snapshots the process environment (call it after LoadEnvFile).
func New(opts Options) *Manager {
	if opts.Lookup == nil {
		opts.Lookup = os.LookupEnv
	}
	m := &Manager{opts: opts, fromFile: map[string]bool{}, baseline: map[string]string{}}
	for _, k := range opts.FromFile {
		m.fromFile[k] = true
	}
	for _, d := range defs {
		if d.applies != AppliesRestart {
			continue
		}
		if v, ok := opts.Lookup(d.id); ok && v != "" {
			m.baseline[d.id] = v
		}
	}
	return m
}

// appliesOf is when a change of d takes effect in this process: the API key
// applies at once when the process can swap it (Applier.APIKey), else on restart.
func (m *Manager) appliesOf(d def) string {
	if d.id == IDAnthropicKey && m.opts.Apply.APIKey != nil {
		return AppliesNow
	}
	return d.applies
}

// locked reports whether the value comes from outside the file, which then
// cannot override it.
func (m *Manager) locked(id string) (val string, isLocked bool) {
	v, ok := m.opts.Lookup(id)
	if ok && !m.fromFile[id] {
		return v, true
	}
	return "", false
}

// Get returns every setting with its current state.
func (m *Manager) Get() (View, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.view()
}

func (m *Manager) view() (View, error) {
	file, err := config.ReadEnvValues(m.opts.DataDir)
	if err != nil {
		return View{}, fmt.Errorf("read settings file: %w", err)
	}
	v := View{Settings: make([]Setting, 0, len(defs)), RestartRequired: []string{}}
	for _, d := range defs {
		s := Setting{ID: d.id, Kind: d.kind, Label: d.label, Group: d.group, Applies: m.appliesOf(d), Hint: d.hint, Editable: true}
		raw, have := "", false
		switch envVal, isLocked := m.locked(d.id); {
		case isLocked:
			s.Source, s.Editable = SourceEnvironment, false
			raw, have = envVal, envVal != ""
		case file[d.id] != "":
			s.Source = SourceFile
			raw, have = file[d.id], true
		default:
			s.Source = SourceDefault
		}
		s.Set = have
		if !s.Editable && d.id == IDAnthropicKey && routerOn(file[IDRouterEnabled]) {
			s.Note = RouterNote
		}
		if d.kind == KindSecret {
			if have {
				s.Hint = secretHint(raw)
			}
		} else {
			val, ok := fromRaw(d, raw, have)
			if !ok { // the file holds something this kind cannot read
				s.Set, s.Source = false, SourceDefault
				s.Hint = "The settings file holds an invalid value for this setting; it is ignored."
				val, _ = fromRaw(d, "", false)
			}
			s.Value = val
		}
		if m.appliesOf(d) == AppliesRestart && s.Editable && file[d.id] != m.baseline[d.id] {
			v.RestartRequired = append(v.RestartRequired, d.id)
		}
		v.Settings = append(v.Settings, s)
	}
	return v, nil
}

// RouterNote explains a locked ANTHROPIC_API_KEY while the bundled router is on.
const RouterNote = "set by the app while the bundled router is on"

func routerOn(raw string) bool {
	b, err := strconv.ParseBool(raw)
	return err == nil && b
}

// secretHint is "…" and the last four characters, shown only for a secret long
// enough that four characters give nothing away.
func secretHint(v string) string {
	if utf8.RuneCountInString(v) < 16 {
		return ""
	}
	r := []rune(v)
	return "…" + string(r[len(r)-4:])
}

// fromRaw turns a stored string into the wire value of the kind: a bool, a
// list, or the string itself. Unset gives the built-in value (models), false
// (bool), nothing for text and an empty list. ok is false when raw cannot be
// read as the kind.
func fromRaw(d def, raw string, have bool) (any, bool) {
	switch d.kind {
	case KindBool:
		if !have {
			if d.builtin != nil {
				b, err := strconv.ParseBool(d.builtin())
				return b, err == nil
			}
			return false, true
		}
		b, err := strconv.ParseBool(raw)
		return b, err == nil
	case KindList:
		return splitList(raw), true
	case KindModel:
		if !have && d.builtin != nil {
			return d.builtin(), true
		}
		return raw, true
	default:
		if !have {
			return nil, true
		}
		return raw, true
	}
}

func splitList(raw string) []string {
	out := []string{}
	for _, item := range strings.Split(raw, ",") {
		if item = strings.TrimSpace(item); item != "" {
			out = append(out, item)
		}
	}
	return out
}

var (
	modelRe    = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$`)
	listItemRe = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*\*?$`)
)

// plan is a validated Update, ready to write.
type plan struct {
	set   map[string]string // id -> stored form
	unset []string
}

func (m *Manager) validate(u Update) (plan, error) {
	if len(u.Set) == 0 && len(u.Unset) == 0 {
		return plan{}, invalid("invalid_request", "nothing to change: send set and/or unset")
	}
	p := plan{set: map[string]string{}}
	check := func(id string) (def, error) {
		d, ok := find(id)
		if !ok {
			return def{}, invalid("unknown_setting", "unknown setting %q", clip(id))
		}
		if _, isLocked := m.locked(id); isLocked {
			return def{}, invalid("setting_locked", "%s is set in the process environment and cannot be changed here", id)
		}
		return d, nil
	}
	for _, id := range u.Unset {
		if _, err := check(id); err != nil {
			return plan{}, err
		}
		if _, both := u.Set[id]; both {
			return plan{}, invalid("invalid_request", "%s is in both set and unset", id)
		}
		if !slices.Contains(p.unset, id) {
			p.unset = append(p.unset, id)
		}
	}
	models, anyModel := config.Models{}, false
	for id, val := range u.Set {
		d, err := check(id)
		if err != nil {
			return plan{}, err
		}
		stored, err := storeForm(d, val)
		if err != nil {
			return plan{}, err
		}
		if stored == "" { // an empty text or list means "not set"
			p.unset = append(p.unset, id)
			continue
		}
		p.set[id] = stored
		anyModel = anyModel || id == IDModelOrch || id == IDModelFast || id == IDModelBalanced || id == IDModelDeep || id == IDModelCompletion
		switch id {
		case IDModelOrch:
			models.Orchestrator = stored
		case IDModelFast:
			models.Fast = stored
		case IDModelBalanced:
			models.Balanced = stored
		case IDModelDeep:
			models.Deep = stored
		case IDModelCompletion:
			models.Small = stored
		}
	}
	if m.opts.ValidateModels != nil && anyModel {
		if err := m.opts.ValidateModels(&models); err != nil {
			return plan{}, invalid("invalid_value", "%s", err.Error())
		}
	}
	slices.Sort(p.unset)
	return p, nil
}

// storeForm validates a JSON value against the kind and returns the string
// written to the file. Errors name the setting and the rule, never the value.
func storeForm(d def, val any) (string, error) {
	bad := func(format string, a ...any) error {
		return invalid("invalid_value", "%s: %s", d.id, fmt.Sprintf(format, a...))
	}
	switch d.kind {
	case KindBool:
		b, ok := val.(bool)
		if !ok {
			return "", bad("must be true or false")
		}
		if b {
			return "1", nil
		}
		return "0", nil
	case KindList:
		items, ok := val.([]any)
		if !ok {
			return "", bad("must be a list of names")
		}
		var out []string
		for _, it := range items {
			s, ok := it.(string)
			if !ok {
				return "", bad("must be a list of names")
			}
			if s = strings.TrimSpace(s); s == "" {
				continue
			}
			if len(s) > maxItemLen || !listItemRe.MatchString(s) {
				return "", bad("each entry must be a variable name or a PREFIX_* pattern")
			}
			out = append(out, s)
		}
		if len(out) > maxListItems {
			return "", bad("at most %d entries", maxListItems)
		}
		return strings.Join(out, ","), nil
	}
	s, ok := val.(string)
	if !ok {
		return "", bad("must be a string")
	}
	s = strings.TrimSpace(s)
	if err := config.ValidEnvValue(s); err != nil {
		return "", bad("%s", err)
	}
	switch d.kind {
	case KindSecret:
		if s == "" {
			return "", bad("must not be empty (use unset to remove it)")
		}
		if len(s) > maxSecretLen {
			return "", bad("at most %d characters", maxSecretLen)
		}
	case KindModel:
		if s == "" {
			return "", bad("must not be empty (use unset to restore the default)")
		}
		if len(s) > maxModelLen || !modelRe.MatchString(s) {
			return "", bad("not a valid model id")
		}
	case KindText:
		if len(s) > maxTextLen {
			return "", bad("at most %d characters", maxTextLen)
		}
		if (d.id == IDRouterBaseURL || d.id == IDOllamaBaseURL) && s != "" {
			if err := validBaseURL(s); err != nil {
				return "", bad("%s", err)
			}
		}
	}
	return s, nil
}

func clip(s string) string {
	if len(s) > 64 {
		return s[:64] + "…"
	}
	return s
}

// Put validates u as a whole, writes the file, applies what can apply at once
// and returns the new view. Nothing is written when anything is invalid.
func (m *Manager) Put(u Update) (View, error) {
	m.mu.Lock()
	p, err := m.validate(u)
	if err != nil {
		m.mu.Unlock()
		return View{}, err
	}
	before, err := config.ReadEnvValues(m.opts.DataDir)
	if err != nil {
		m.mu.Unlock()
		return View{}, fmt.Errorf("read settings file: %w", err)
	}
	if err := config.UpdateEnvFile(m.opts.DataDir, p.set, p.unset); err != nil {
		m.mu.Unlock()
		return View{}, fmt.Errorf("write settings file: %w", err)
	}
	var changed []string
	for _, d := range defs {
		nv, set := p.set[d.id]
		if !set && !slices.Contains(p.unset, d.id) {
			continue
		}
		if nv != before[d.id] {
			changed = append(changed, d.id)
		}
	}
	after, rerr := config.ReadEnvValues(m.opts.DataDir)
	if rerr == nil {
		m.applyNow(changed, after)
	}
	view, verr := m.view()
	m.mu.Unlock()
	if len(changed) > 0 && m.opts.Notify != nil {
		m.opts.Notify(changed)
	}
	if rerr != nil {
		return View{}, fmt.Errorf("read settings file: %w", rerr)
	}
	return view, verr
}

// effective is the value a setting has now: the environment's when it locks
// the setting, else the file's, else "".
func (m *Manager) effective(id string, file map[string]string) string {
	if v, isLocked := m.locked(id); isLocked {
		return v
	}
	return file[id]
}

// applyNow pushes the changed apply-now settings into the running process.
func (m *Manager) applyNow(changed []string, file map[string]string) {
	var models, ollama, allow, trace, feat, key bool
	for _, id := range changed {
		switch id {
		case IDAnthropicKey:
			key = true
		case IDACPTrace:
			trace = true
		case IDFeatureAutoMemory, IDEscalateOnFailure:
			feat = true
		case IDModelOrch, IDModelFast, IDModelBalanced, IDModelDeep:
			models = true
		case IDModelCompletion, IDOllamaBaseURL:
			ollama = true
		case IDChildEnvAllow:
			allow = true
		}
	}
	if models && m.opts.Apply.Models != nil {
		b := config.BuiltinModels()
		pick := func(id, builtin string) string {
			if v := m.effective(id, file); v != "" {
				return v
			}
			return builtin
		}
		m.opts.Apply.Models(pick(IDModelOrch, b.Orchestrator), pick(IDModelFast, b.Fast),
			pick(IDModelBalanced, b.Balanced), pick(IDModelDeep, b.Deep))
	}
	if ollama && m.opts.Apply.Ollama != nil {
		url := strings.TrimSpace(m.effective(IDOllamaBaseURL, file))
		if url == "" {
			url = config.DefaultOllamaBaseURL
		}
		m.opts.Apply.Ollama(url, strings.TrimSpace(m.effective(IDModelCompletion, file)))
	}
	if key && m.opts.Apply.APIKey != nil {
		m.opts.Apply.APIKey(m.effective(IDAnthropicKey, file))
	}
	if trace && m.opts.Apply.ACPTrace != nil {
		m.opts.Apply.ACPTrace(routerOn(m.effective(IDACPTrace, file)))
	}
	if feat && m.opts.Apply.Features != nil {
		for _, d := range features.Defs() {
			v := strings.TrimSpace(m.effective(d.Env, file))
			on := d.Default
			if v != "" {
				on = routerOn(v)
			}
			m.opts.Apply.Features(d.ID, on)
		}
	}
	if allow && m.opts.Apply.ChildEnvAllow != nil {
		m.opts.Apply.ChildEnvAllow(m.effective(IDChildEnvAllow, file))
	}
}
