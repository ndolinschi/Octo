// Package providers answers "what can run a model right now": the built-in
// Messages-API loop (an API key, or a gateway), a detected Octo router, and
// every ACP agent of the loaded plugins, each with a state, the models it
// offers and the one-line instructions to make it ready. It backs
// GET /v1/providers, the model checks of project create and patch, and the
// default models a new project gets.
//
// Nothing here runs a command or calls a provider: states come from
// configuration, the plugin registry (availability and the background login
// probe) and a small cache of the models agents advertised.
package providers

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/config"
	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
)

// Provider kinds.
const (
	KindAPI    = "api"
	KindRouter = "router"
	KindAgent  = "agent"
)

// Provider states. StateError is reserved for a provider that is set up but
// failing; nothing reports it yet.
const (
	StateReady        = "ready"
	StateNotConnected = "not_connected"
	StateNotLoggedIn  = "not_logged_in"
	StateNotInstalled = "not_installed"
	StateError        = "error"
)

// Login values of an agent provider.
const (
	LoginOK          = "ok"
	LoginNotLoggedIn = "not_logged_in"
	LoginUnchecked   = "unchecked"
)

// preferredOf is the user's preferred model of an agent ("" = none).
func preferredOf(adv advertised) string {
	if adv.Preferred == nil {
		return ""
	}
	return *adv.Preferred
}

// effectiveRoles is the manifest's role models overlaid by the user's own
// (a stored "" means the agent's default, overriding a manifest hint).
func effectiveRoles(a plugins.Agent, adv advertised) map[string]string {
	out := map[string]string{}
	for k, v := range a.Roles {
		out[k] = v
	}
	for k, v := range adv.Roles {
		out[k] = v
	}
	return out
}

// Model sources.
const (
	SourceCatalogue  = "catalogue"
	SourceManifest   = "manifest"
	SourceAdvertised = "advertised"
	// SourceCustom: a name the user typed for the agent (PUT custom-models).
	SourceCustom = "custom"
	// SourceCommand: printed by the manifest's models command.
	SourceCommand = "command"
)

// IDs of the two non-agent providers.
const (
	IDAPI    = "api"
	IDRouter = "router"
)

// Model is one model a provider offers. SeenAt is when an agent last
// advertised it (RFC 3339); Stale says the agent's latest session did not
// advertise it any more (it is kept, not dropped).
type Model struct {
	ID     string `json:"id"`
	Label  string `json:"label"`
	Source string `json:"source"`
	SeenAt string `json:"seen_at,omitempty"`
	Stale  bool   `json:"stale,omitempty"`
}

// Provider is one entry of GET /v1/providers.
type Provider struct {
	ID          string  `json:"id"`
	Kind        string  `json:"kind"`
	Label       string  `json:"label"`
	State       string  `json:"state"`
	Reason      string  `json:"reason"`
	InstallHint string  `json:"install_hint"`
	LoginHint   string  `json:"login_hint"`
	Models      []Model `json:"models"`
	// DefaultModel is the model used when none is named ("" when unknown).
	DefaultModel string `json:"default_model"`
	// FlatRate: a flat-rate subscription, no per-token charge at the margin.
	FlatRate bool `json:"flat_rate"`
	// ModelsRefreshedAt is when the agent's models were last looked for (RFC 3339;
	// agents only), ModelsError why the last look failed, ModelsNote the manifest's
	// remark on its model list.
	ModelsRefreshedAt string `json:"models_refreshed_at,omitempty"`
	ModelsError       string `json:"models_error,omitempty"`
	ModelsNote        string `json:"models_note,omitempty"`
	// AcceptsCustomModel: any model name may be chosen for this provider (true
	// for every agent).
	AcceptsCustomModel bool `json:"accepts_custom_model"`
	// Login (agents): "ok" when the login probe succeeded, "not_logged_in" when it
	// positively said so, "unchecked" when there is no probe or it failed to run,
	// timed out or printed something unexpected (the agent can be used all the same).
	Login string `json:"login,omitempty"`
	// PreferredModel is the model used when this agent is chosen without one
	// ("" = the agent's own default). Roles say which model does the work of a
	// delegation decided fast, balanced or deep ("" = the agent's default).
	PreferredModel string `json:"preferred_model,omitempty"`
	Roles          *Roles `json:"roles,omitempty"`
}

// Roles is the model per tier of one agent ("" = the agent's own default).
type Roles struct {
	Fast     string `json:"fast"`
	Balanced string `json:"balanced"`
	Deep     string `json:"deep"`
}

// Suggested are the models a new project gets when the request names none:
// the current defaults when the API (or a router) is ready, else the first
// ready agent everywhere. Empty strings when nothing is ready.
type Suggested struct {
	Orchestrator string `json:"orchestrator"`
	Fast         string `json:"fast"`
	Balanced     string `json:"balanced"`
	Deep         string `json:"deep"`
}

// Response is the body of GET /v1/providers.
type Response struct {
	// Connected counts the providers in state ready.
	Connected int        `json:"connected"`
	Suggested Suggested  `json:"suggested"`
	Providers []Provider `json:"providers"`
}

// Unavailable says why a model cannot run: the provider that would run it and
// what is missing.
type Unavailable struct {
	Provider string `json:"provider"`
	Reason   string `json:"reason"`
}

// RouterState is the Octo router detection (router.Router).
type RouterState interface{ Enabled() bool }

// Options configures a Service. Builtin and Agents are read on every call, so
// a key written to the settings file or a finished login probe shows at once.
type Options struct {
	// DataDir holds the advertised-models cache (agent-models.json); empty
	// keeps it in memory only.
	DataDir string
	// Builtin reports whether the built-in loop can run and, when not, why.
	Builtin func() (ready bool, reason string)
	// Router is the detected router (nil: none).
	Router RouterState
	// Agents lists the ACP agents of the loaded plugins, manifest models only.
	Agents func() []plugins.Agent
	// Defaults are the current default models (the HARNESS_MODEL_* settings).
	Defaults func() config.Models
	// Publish is told the new connected count when the picture changed (see
	// Refresh). It may be nil.
	Publish func(connected int)
	// Now is the clock (default time.Now).
	Now func() time.Time
	// Discovery turns on model discovery (nil: off). See Discovery.
	Discovery *Discovery
}

// Service computes the provider picture. Safe for concurrent use.
type Service struct {
	opts  Options
	cache *cache

	mu          sync.Mutex
	fingerprint string
	disc        map[string]chan struct{} // agents with a discovery running
	bg          context.Context          // lifetime of background discoveries (Watch)
	login       map[string]string        // last login value seen per agent (kickDiscovery)
	wg          sync.WaitGroup           // background discoveries (WaitIdle)
}

// New builds a Service and loads the advertised-models cache; an unreadable
// cache is ignored (it is rebuilt by the next sessions).
func New(opts Options) *Service {
	if opts.Now == nil {
		opts.Now = time.Now
	}
	return &Service{opts: opts, cache: loadCache(opts.DataDir, opts.Now)}
}

// catalogue is the built-in loop's model list: the compiled-in tiers, deepest
// first, plus whatever non-ACP model the defaults currently name.
var catalogue = []Model{
	{ID: "claude-opus-5-5", Label: "Claude Opus 5.5", Source: SourceCatalogue},
	{ID: "claude-sonnet-5-5", Label: "Claude Sonnet 5.5", Source: SourceCatalogue},
	{ID: "claude-haiku-5-5", Label: "Claude Haiku 5.5", Source: SourceCatalogue},
}

// preferredAgents is the order a suggested orchestrator is looked for in; it
// matches the harness's default-orchestrator fallback.
var preferredAgents = []string{"claude-code", "codex", "copilot"}

// listFirst is the order agents are listed in before the rest (manifest order).
var listFirst = []string{"claude-code", "copilot", "grok"}

// Snapshot is the current picture.
func (s *Service) Snapshot() Response {
	builtinOK, builtinWhy := true, ""
	if s.opts.Builtin != nil {
		builtinOK, builtinWhy = s.opts.Builtin()
	}
	routerOn := s.opts.Router != nil && s.opts.Router.Enabled()
	defaults := config.BuiltinModels()
	if s.opts.Defaults != nil {
		defaults = s.opts.Defaults()
	}

	var agents []plugins.Agent
	if s.opts.Agents != nil {
		agents = s.opts.Agents()
	}

	resp := Response{Providers: []Provider{}}
	api := Provider{
		ID: IDAPI, Kind: KindAPI, Label: "Anthropic API", Models: catalogueFor(defaults), DefaultModel: apiDefault(defaults),
		LoginHint: "Add an API key in Settings (ANTHROPIC_API_KEY).",
	}
	switch {
	case routerOn:
		api.State, api.Reason = StateNotConnected, "The built-in loop runs through the Octo router."
	case builtinOK:
		api.State = StateReady
	default:
		api.State, api.Reason = StateNotConnected, builtinWhy
	}
	resp.Providers = append(resp.Providers, api)
	if routerOn {
		resp.Providers = append(resp.Providers, Provider{
			ID: IDRouter, Kind: KindRouter, Label: "Octo router", State: StateReady,
			Models: catalogueFor(defaults), DefaultModel: apiDefault(defaults),
		})
	}
	for _, a := range orderAgents(agents) {
		resp.Providers = append(resp.Providers, s.agentProvider(a))
	}
	for _, p := range resp.Providers {
		if p.State == StateReady {
			resp.Connected++
		}
	}
	resp.Suggested = suggest(resp.Providers, defaults)
	return resp
}

func catalogueFor(d config.Models) []Model {
	out := slices.Clone(catalogue)
	for _, id := range []string{d.Orchestrator, d.Fast, d.Balanced, d.Deep} {
		if id == "" || plugins.IsACPRef(id) || slices.ContainsFunc(out, func(m Model) bool { return m.ID == id }) {
			continue
		}
		out = append(out, Model{ID: id, Label: id, Source: SourceCatalogue})
	}
	return out
}

// apiDefault is the model the built-in loop uses when none is named: the
// default orchestrator unless that names an agent.
func apiDefault(d config.Models) string {
	for _, id := range []string{d.Orchestrator, d.Balanced} {
		if id != "" && !plugins.IsACPRef(id) {
			return id
		}
	}
	return config.BuiltinModels().Balanced
}

func orderAgents(in []plugins.Agent) []plugins.Agent {
	out := make([]plugins.Agent, 0, len(in))
	used := make([]bool, len(in))
	for _, id := range listFirst {
		for i, a := range in {
			if a.ID == id && !used[i] {
				out, used[i] = append(out, a), true
			}
		}
	}
	for i, a := range in {
		if !used[i] {
			out = append(out, a)
		}
	}
	return out
}

func (s *Service) agentProvider(a plugins.Agent) Provider {
	p := Provider{
		ID: a.ID, Kind: KindAgent, Label: a.Label, InstallHint: a.InstallHint, LoginHint: a.Hint,
		DefaultModel: a.DefaultModel, FlatRate: a.FlatRate, ModelsNote: a.ModelsNote, AcceptsCustomModel: true,
	}
	if p.Label == "" {
		p.Label = a.ID
	}
	switch {
	case !a.Available:
		p.State = StateNotInstalled
		p.Reason = a.UnavailableReason
		if p.Reason == "" {
			p.Reason = "not installed"
		}
	case a.LoggedIn != nil && !*a.LoggedIn:
		p.State, p.Reason = StateNotLoggedIn, "not logged in"
		p.Login = LoginNotLoggedIn
	case a.LoggedIn != nil:
		p.State, p.Login = StateReady, LoginOK
	default:
		// No probe, or one that could not tell: usable, login not checked.
		p.State, p.Login = StateReady, LoginUnchecked
	}
	adv := s.cache.get(a.ID)
	p.PreferredModel = preferredOf(adv)
	r := effectiveRoles(a, adv)
	p.Roles = &Roles{Fast: r["fast"], Balanced: r["balanced"], Deep: r["deep"]}
	p.Models = agentModels(a, adv)
	p.ModelsRefreshedAt, p.ModelsError = adv.RefreshedAt, adv.Error
	if p.DefaultModel == "" && adv.Current != "" {
		p.DefaultModel = adv.Current
	}
	return p
}

// agentModels is the manifest's models, then those a models command printed,
// then those the agent advertised in earlier sessions, then the names the user
// typed; a model is listed once, under the first source that has it. An
// advertised model carries seen_at, and stale when the agent's latest session
// did not advertise it (a manifest alias is the CLI's own name and is not
// expected in its list, so it is never flagged).
func agentModels(a plugins.Agent, adv advertised) []Model {
	out := []Model{}
	index := map[string]int{}
	add := func(id, label, source string) {
		if _, dup := index[id]; dup {
			return
		}
		if label == "" {
			label = id
		}
		index[id] = len(out)
		out = append(out, Model{ID: id, Label: label, Source: source})
	}
	for _, id := range a.Models {
		add(id, a.ModelLabels[id], SourceManifest)
	}
	for _, id := range adv.Cmd {
		add(id, adv.Labels[id], SourceCommand)
	}
	for _, id := range adv.Order {
		add(id, adv.Labels[id], SourceAdvertised)
	}
	for _, id := range adv.Custom {
		add(id, "", SourceCustom)
	}
	for i := range out {
		if at, ok := adv.Seen[out[i].ID]; ok {
			out[i].SeenAt = at
		}
		if out[i].Source != SourceAdvertised {
			continue
		}
		if len(adv.Last) > 0 && !slices.Contains(adv.Last, out[i].ID) {
			out[i].Stale = true
		}
	}
	return out
}

// suggest is the default models of a new project: the defaults when the
// built-in path is ready, else the first ready agent for every slot.
func suggest(list []Provider, d config.Models) Suggested {
	ready := func(id string) bool {
		for _, p := range list {
			if p.ID == id {
				return p.State == StateReady
			}
		}
		return false
	}
	apiReady := ready(IDAPI) || ready(IDRouter)
	if apiReady {
		// A default that names an agent that cannot run now falls back to the
		// compiled-in model of its slot.
		b := config.BuiltinModels()
		pick := func(v, builtin string) string {
			if id, _, ok := plugins.ParseACPRef(v); ok && !ready(id) {
				return builtin
			}
			if v == "" {
				return builtin
			}
			return v
		}
		return Suggested{
			Orchestrator: pick(d.Orchestrator, b.Orchestrator), Fast: pick(d.Fast, b.Fast),
			Balanced: pick(d.Balanced, b.Balanced), Deep: pick(d.Deep, b.Deep),
		}
	}
	var readyAgents []string
	for _, p := range list {
		if p.Kind == KindAgent && p.State == StateReady {
			readyAgents = append(readyAgents, p.ID)
		}
	}
	if len(readyAgents) == 0 {
		return Suggested{}
	}
	id := readyAgents[0]
	for _, want := range preferredAgents {
		if slices.Contains(readyAgents, want) {
			id = want
			break
		}
	}
	ref := plugins.ACPPrefix + id
	return Suggested{Orchestrator: ref, Fast: ref, Balanced: ref, Deep: ref}
}

// Check says why model cannot run now, or nil when it can (or when it is not a
// model id: a tier name or empty). `acp:<id>[/<model>]` is checked against the
// agent's state, anything else against the built-in path (the router when one
// is detected, else the API).
func (s *Service) Check(model string) *Unavailable {
	switch model {
	case "", "off", "fast", "balanced", "deep":
		return nil
	}
	return CheckIn(s.Snapshot(), model)
}

// CheckIn is Check against a snapshot already taken.
func CheckIn(snap Response, model string) *Unavailable {
	switch model {
	case "", "off", "fast", "balanced", "deep":
		return nil
	}
	byID := func(id string) *Provider {
		for i := range snap.Providers {
			if snap.Providers[i].ID == id {
				return &snap.Providers[i]
			}
		}
		return nil
	}
	if agentID, _, ok := plugins.ParseACPRef(model); ok {
		p := byID(agentID)
		switch {
		case p == nil:
			return &Unavailable{Provider: agentID, Reason: fmt.Sprintf("unknown agent %q", agentID)}
		case p.State != StateReady:
			return &Unavailable{Provider: p.ID, Reason: describe(*p)}
		}
		return nil
	}
	p := byID(IDRouter)
	if p == nil {
		p = byID(IDAPI)
	}
	if p != nil && p.State != StateReady {
		return &Unavailable{Provider: p.ID, Reason: describe(*p)}
	}
	return nil
}

// describe is one sentence on why p is not ready, with what to do about it.
func describe(p Provider) string {
	var b strings.Builder
	b.WriteString(p.Label)
	switch p.State {
	case StateNotInstalled:
		b.WriteString(" is not installed")
	case StateNotLoggedIn:
		b.WriteString(" is not logged in")
	case StateError:
		b.WriteString(" is not working")
	default:
		b.WriteString(" is not connected")
	}
	if p.Reason != "" && !strings.EqualFold(p.Reason, "not installed") && !strings.EqualFold(p.Reason, "not logged in") {
		b.WriteString(" (" + strings.TrimRight(p.Reason, ".") + ")")
	}
	b.WriteString(".")
	switch {
	case p.State == StateNotInstalled && p.InstallHint != "":
		b.WriteString(" " + p.InstallHint)
	case p.State == StateNotLoggedIn && p.LoginHint != "":
		b.WriteString(" " + p.LoginHint)
	case p.Kind == KindAPI && p.LoginHint != "":
		b.WriteString(" " + p.LoginHint)
	}
	return b.String()
}

// Agents is the plugin registry's agents with the models they advertised added
// to those the manifest lists, for validating `acp:<id>/<model>` settings. An
// agent whose manifest lists no models still accepts any model id.
func (s *Service) Agents() []plugins.Agent {
	var in []plugins.Agent
	if s.opts.Agents != nil {
		in = s.opts.Agents()
	}
	out := make([]plugins.Agent, len(in))
	for i, a := range in {
		out[i] = a
		adv := s.cache.get(a.ID)
		out[i].PreferredModel = preferredOf(adv)
		out[i].Roles = effectiveRoles(a, adv)
		if len(a.Models) == 0 {
			continue
		}
		models := slices.Clone(a.Models)
		for _, id := range adv.Order {
			if !slices.Contains(models, id) {
				models = append(models, id)
			}
		}
		out[i].Models = models
	}
	return out
}

// Record stores the models an agent advertised in a session it opened (and the
// one in use). `harness serve` calls it from Orchestrator.OnAdvertisedModels; an empty list is ignored. When the set of models changed
// it refreshes the picture.
func (s *Service) Record(agentID string, models []string, current string) {
	infos := make([]ModelInfo, len(models))
	for i, id := range models {
		infos[i] = ModelInfo{ID: id}
	}
	s.RecordModels(agentID, infos, current)
}

// RecordModels is Record with a display name per model.
func (s *Service) RecordModels(agentID string, models []ModelInfo, current string) {
	if s == nil {
		return
	}
	if s.cache.record(agentID, models, current) {
		s.Refresh()
	}
}

// Refresh recomputes the picture and, when it differs from the last one
// (timestamps aside), calls Options.Publish. The first call only remembers the
// picture. Call it when a probe result or a relevant setting may have changed.
func (s *Service) Refresh() {
	fp := fingerprint(s.Snapshot())
	s.mu.Lock()
	prev := s.fingerprint
	s.fingerprint = fp.key
	s.mu.Unlock()
	if prev != "" && prev != fp.key && s.opts.Publish != nil {
		s.opts.Publish(fp.connected)
	}
	s.kickDiscovery()
}

type fp struct {
	key       string
	connected int
}

func fingerprint(r Response) fp {
	cp := r
	cp.Providers = slices.Clone(r.Providers)
	for i := range cp.Providers {
		ms := slices.Clone(cp.Providers[i].Models)
		for j := range ms {
			ms[j].SeenAt = ""
		}
		cp.Providers[i].Models = ms
		cp.Providers[i].ModelsRefreshedAt = ""
	}
	b, _ := json.Marshal(cp)
	return fp{key: string(b), connected: r.Connected}
}
