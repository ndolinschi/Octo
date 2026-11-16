package project

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/ndolinschi/Octo/apps/harness/internal/completion"
	"log/slog"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/approval"
	"github.com/ndolinschi/Octo/apps/harness/internal/budget"
	"github.com/ndolinschi/Octo/apps/harness/internal/config"
	"github.com/ndolinschi/Octo/apps/harness/internal/events"
	"github.com/ndolinschi/Octo/apps/harness/internal/inputs"
	"github.com/ndolinschi/Octo/apps/harness/internal/memory"
	"github.com/ndolinschi/Octo/apps/harness/internal/orchestrator"
	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
	"github.com/ndolinschi/Octo/apps/harness/internal/prices"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
	"github.com/ndolinschi/Octo/apps/harness/internal/providers"
	"github.com/ndolinschi/Octo/apps/harness/internal/router"
	"github.com/ndolinschi/Octo/apps/harness/internal/secrets"
)

// Turns is the orchestrator surface the service drives.
type Turns interface {
	Start(ctx context.Context, projectID, text string) (projectstore.Message, error)
	// Submit starts a turn, or queues the message when one runs.
	Submit(ctx context.Context, projectID, text string) (projectstore.Message, *projectstore.QueuedMessage, error)
	// SubmitMode is Submit with the mode chosen for this message.
	SubmitMode(ctx context.Context, projectID, text, mode string) (projectstore.Message, *projectstore.QueuedMessage, error)
	// SubmitAttach is SubmitMode with the ids of attached images.
	SubmitAttach(ctx context.Context, projectID, text, mode string, attachments []string) (projectstore.Message, *projectstore.QueuedMessage, error)
	// ImagesAccepted says whether the orchestrator takes images (known false: not found out yet; probe starts the agent to ask).
	ImagesAccepted(ctx context.Context, projectID string, probe bool) (accepts, known bool, label string, err error)
	// LatestPlan is the newest plan of a plan-mode turn; ApprovePlan approves it and starts an agent turn with it pinned.
	// Rewind cuts the conversation back to a user request and restores the files after it.
	Rewind(ctx context.Context, projectID string, messageID int64, dryRun bool) (orchestrator.RewindReport, error)
	// Compact summarises the orchestrator's conversation now (manual compaction).
	Compact(ctx context.Context, projectID string) (orchestrator.CompactResult, error)
	// Clear starts a new conversation (B11); SlashCommands lists the Octo and agent slash commands;
	// CompactViaAgent sends /compact to an ACP orchestrator that advertises it.
	Clear(ctx context.Context, projectID string) (orchestrator.ClearResult, error)
	SlashCommands(ctx context.Context, projectID string) (orchestrator.SlashReport, error)
	// Project sessions: a view with the live state, new / resume / stop, and a message to a sub-agent's session.
	SessionView(ctx context.Context, db *projectstore.DB, info projectstore.SessionInfo) orchestrator.SessionView
	NewSession(ctx context.Context, projectID, title string) (orchestrator.SessionView, error)
	ResumeSession(ctx context.Context, projectID, sessionID string) (orchestrator.SessionView, error)
	StopSession(ctx context.Context, projectID, sessionID string) (orchestrator.SessionView, error)
	MessageAgentSession(ctx context.Context, projectID, sessionID, text string, reportToParent bool) (orchestrator.MessageOutcome, orchestrator.SessionView, error)
	CompactViaAgent(ctx context.Context, projectID string) (projectstore.Message, bool, error)
	// Redact replaces the project's stored secret values in s.
	Redact(projectID, s string) string
	LatestPlan(ctx context.Context, projectID string) (projectstore.Plan, error)
	ApprovePlan(ctx context.Context, projectID, planID string) (projectstore.Plan, projectstore.Message, error)
	Queue(ctx context.Context, projectID string) ([]projectstore.QueuedMessage, bool, error)
	EditQueued(ctx context.Context, projectID, queueID, text string) (projectstore.QueuedMessage, error)
	RemoveQueued(ctx context.Context, projectID, queueID string) error
	ResumeQueue(ctx context.Context, projectID string) error
	SendNow(ctx context.Context, projectID, queueID string, interrupt bool) error
	Cancel(projectID string)
	Running(projectID string) bool
	// Active: a turn started and its turn.finished has not been published yet.
	Active(projectID string) bool
	Context(ctx context.Context, projectID, agentID string) (orchestrator.ContextReport, error)
	Side(ctx context.Context, projectID, text string) (orchestrator.SideStart, error)
	// Complete answers one inline-completion request (no turn, no transcript).
	Complete(ctx context.Context, projectID string, req completion.Request) (completion.Result, string, error)
	CancelSide(projectID string)
	// CloseSide stops a running side question and ends the side conversation's agent.
	CloseSide(projectID string)
	// CloseProject ends the project's ACP orchestrator process, if any.
	CloseProject(projectID string)
	// Approvals are the pending approval requests; ResolveApproval answers one.
	Approvals(projectID string) []approval.Approval
	ResolveApproval(projectID, id string, r approval.Resolution) error
	// Inputs are the open forms; SubmitInput answers one.
	Inputs(projectID string) []inputs.Input
	SubmitInput(projectID, id string, a inputs.Answer) error
	// Secrets are the project's stored secrets (names only).
	Secrets(projectID string) ([]secrets.Info, error)
	PutSecret(projectID, name, value string) error
	DeleteSecret(projectID, name string) error
	// TurnReceipt is the stored context receipt of a turn.
	TurnReceipt(ctx context.Context, projectID string, turnID int64) (json.RawMessage, error)
	// Memory is the project's memory service (tasks, memory files, search).
	Memory(ctx context.Context, projectID string) (*memory.Service, error)
	// Attention counts what waits for the user: approvals and open forms.
	Attention(projectID string) (approvals, inputs int)
}

// ACPAgents lists the loaded ACP agents, for validating `acp:` model settings.
type ACPAgents interface {
	Agents() []plugins.Agent
}

// ProviderSource says which providers can run a model now (providers.Service).
type ProviderSource interface {
	Snapshot() providers.Response
}

type Defaults struct {
	Models   config.Models
	MaxDepth int
	// Access is the access mode of projects created without one: "supervised"
	// or "full" (the zero value means full, so embedders and tests that never
	// heard of approvals keep today's behaviour; `harness serve` sets it).
	Access string
}

// Service is the application layer behind the bridge: projects, agents, messages.
type Service struct {
	store    *projectstore.Store
	hub      *events.Hub
	turns    Turns
	mu       sync.RWMutex // guards defaults.Models (SetDefaultTiers)
	defaults Defaults
	prices   prices.Table
	router   *router.Router
	acpAgent ACPAgents
	provider ProviderSource
	now      func() time.Time
}

// ServiceOption customizes NewService.
type ServiceOption func(*Service)

// WithPrices sets the table used to estimate API usage cost.
func WithPrices(t prices.Table) ServiceOption { return func(s *Service) { s.prices = t } }

// WithRouter lets project JSON include the spend an Octo router last reported.
func WithRouter(r *router.Router) ServiceOption { return func(s *Service) { s.router = r } }

// WithACPAgents validates `acp:<id>[/<model>]` model settings against the
// loaded plugin agents. Without it such settings are rejected.
func WithACPAgents(a ACPAgents) ServiceOption { return func(s *Service) { s.acpAgent = a } }

// WithProviders makes create and patch refuse a model whose provider cannot
// run it (422 model_unavailable) and a create with nothing connected (409
// no_provider), gives a new project the suggested models, and lists the
// unusable models of a project in models_unavailable. Without it nothing is
// checked.
func WithProviders(p ProviderSource) ServiceOption { return func(s *Service) { s.provider = p } }

// ValidateModels checks the `acp:` entries of a models overlay (non-empty
// fields): the agent must be loaded and available, and the model allowed.
func (s *Service) ValidateModels(m *config.Models) error {
	if m == nil {
		return nil
	}
	var agents []plugins.Agent
	if s.acpAgent != nil {
		agents = s.acpAgent.Agents()
	}
	for field, v := range map[string]string{
		"orchestrator": m.Orchestrator, "fast": m.Fast, "balanced": m.Balanced, "deep": m.Deep, "side": m.Side,
	} {
		if err := plugins.ValidateACPRef(v, agents); err != nil {
			return invalid("models.%s: %s", field, err)
		}
	}
	if plugins.IsACPRef(m.Completion) {
		return invalid("models.completion: inline completion needs a fast Messages API model; an ACP agent answers in seconds, not milliseconds")
	}
	if len(m.Completion) > 200 || strings.ContainsAny(m.Completion, " \t\n") {
		return invalid("models.completion must be a model id, fast, balanced, deep or off")
	}
	return validateAutoCandidates(m.AutoCandidates, agents)
}

// validateAutoCandidates checks models.auto_candidates: tier names or `acp:`
// settings of loaded, available agents, without duplicates.
func validateAutoCandidates(list []string, agents []plugins.Agent) error {
	seen := map[string]bool{}
	for _, c := range list {
		switch {
		case !config.ValidAutoCandidate(c):
			return invalid("models.auto_candidates: %q must be fast, balanced, deep or acp:<agent-id>[/<model>]", c)
		case seen[c]:
			return invalid("models.auto_candidates: duplicate %q", c)
		}
		seen[c] = true
		if err := plugins.ValidateACPRef(c, agents); err != nil {
			return invalid("models.auto_candidates: %s", err)
		}
	}
	return nil
}

func (s *Service) meter() budget.Meter { return budget.Meter{Prices: s.prices, Router: s.router} }

func NewService(store *projectstore.Store, hub *events.Hub, turns Turns, defaults Defaults, opts ...ServiceOption) *Service {
	s := &Service{store: store, hub: hub, turns: turns, defaults: defaults, now: time.Now}
	for _, o := range opts {
		o(s)
	}
	if st, ok := turns.(SessionTurns); ok {
		// The project's orchestrator_agent_id is the default session's root: a new default republishes the project.
		st.OnDefaultChanged(s.announceProject)
	}
	return s
}

// Defaults returns a copy of the current defaults (they can change while the
// server runs, see SetDefaultTiers).
func (s *Service) Defaults() Defaults {
	s.mu.RLock()
	defer s.mu.RUnlock()
	d := s.defaults
	d.Models.AutoCandidates = slices.Clone(d.Models.AutoCandidates)
	return d
}

// SetDefaultTiers swaps the default orchestrator and tier models used for
// projects created from now on (and for fields a stored project lacks). The
// caller has validated them. Safe concurrently with every other method.
func (s *Service) SetDefaultTiers(orchestrator, fast, balanced, deep string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.defaults.Models.Orchestrator = orchestrator
	s.defaults.Models.Fast = fast
	s.defaults.Models.Balanced = balanced
	s.defaults.Models.Deep = deep
}

// TurnRecoverer closes the turn a previous process left running in a project
// (orchestrator.RecoverInterrupted): its streamed text kept, its open tool calls
// closed, its exchange recorded. Recover calls it before the rows are settled.
type TurnRecoverer interface {
	RecoverInterrupted(ctx context.Context, db *projectstore.DB) error
}

// Recover settles agents a previous process left running.
func (s *Service) Recover(ctx context.Context) error {
	ids, err := s.store.IDs(ctx)
	if err != nil {
		return err
	}
	for _, id := range ids {
		db, err := s.store.Get(ctx, id)
		if err != nil {
			return err
		}
		if r, ok := s.turns.(TurnRecoverer); ok {
			// A project whose turn cannot be closed still starts: its rows are settled below as before.
			if err := r.RecoverInterrupted(ctx, db); err != nil {
				slog.Error("close the interrupted turn", "project", id, "err", err)
			}
		}
		if err := db.RecoverInterrupted(ctx); err != nil {
			return err
		}
		if _, err := db.PruneBlobs(ctx, projectstore.Stamp(s.now().Add(-ChangeRetention))); err != nil {
			return err
		}
	}
	return nil
}

func (s *Service) db(ctx context.Context, pid string) (*projectstore.DB, error) {
	db, err := s.store.Get(ctx, pid)
	if errors.Is(err, projectstore.ErrNotFound) {
		return nil, notFound("project")
	}
	return db, storeErr(err)
}

func (s *Service) List(ctx context.Context) ([]Summary, error) {
	ids, err := s.store.IDs(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]Summary, 0, len(ids))
	for _, id := range ids {
		p, err := s.Get(ctx, id)
		if err != nil {
			return nil, err
		}
		out = append(out, p.Summary)
	}
	slices.SortStableFunc(out, func(a, b Summary) int { return strings.Compare(b.UpdatedAt, a.UpdatedAt) })
	return out, nil
}

func (s *Service) Get(ctx context.Context, pid string) (Project, error) {
	db, err := s.db(ctx, pid)
	if err != nil {
		return Project{}, err
	}
	return s.load(ctx, db)
}

func (s *Service) Create(ctx context.Context, in Input) (Project, error) {
	if in.Name == nil || strings.TrimSpace(*in.Name) == "" {
		return Project{}, invalid("name is required")
	}
	depth := s.Defaults().MaxDepth
	if in.MaxDepth != nil {
		depth = *in.MaxDepth
	}
	if err := validDepth(depth); err != nil {
		return Project{}, err
	}
	var folderIn []FolderInput
	if in.Folders != nil {
		folderIn = *in.Folders
	}
	folders, err := resolveFolders(folderIn)
	if err != nil {
		return Project{}, err
	}
	if err := s.ValidateModels(in.Models); err != nil {
		return Project{}, err
	}
	base := s.Defaults().Models
	// A project is a folder and settings: it never waits for a provider or an
	// agent login. A project that names no models gets what can run now, else
	// the defaults as they are; readiness is said when a request is sent.
	if s.provider != nil {
		if snap := s.provider.Snapshot(); snap.Connected > 0 {
			sg := snap.Suggested
			base.Orchestrator, base.Fast, base.Balanced, base.Deep = sg.Orchestrator, sg.Fast, sg.Balanced, sg.Deep
		}
	}
	models, err := mergeModels(base, in.Models)
	if err != nil {
		return Project{}, err
	}
	models = alignACPSessionModels(models, in.Models)
	if err := validBudget(in.BudgetUSD); err != nil {
		return Project{}, err
	}
	if err := validAccess(in.Access); err != nil {
		return Project{}, err
	}
	if err := validNetwork(in.Network); err != nil {
		return Project{}, err
	}
	if err := validMode(in.Mode); err != nil {
		return Project{}, err
	}
	if err := checkCommands(in.Commands); err != nil {
		return Project{}, err
	}
	if err := checkReview(in.Review); err != nil {
		return Project{}, err
	}
	if err := checkSessionSettings(in.SessionSettings); err != nil {
		return Project{}, err
	}
	memJSON := ""
	if in.Memory != nil {
		if err := in.Memory.Validate(); err != nil {
			return Project{}, invalid("%s", err.Error())
		}
		memJSON = memory.ParseSettings("").Merge(*in.Memory).JSON()
	}
	access := s.Defaults().Access
	if in.Access != nil {
		access = *in.Access
	}
	modelsJSON, err := json.Marshal(models)
	if err != nil {
		return Project{}, err
	}
	db, err := s.store.Create(ctx, projectstore.NewProject{
		Name: strings.TrimSpace(*in.Name), Description: deref(in.Description), Instructions: deref(in.Instructions),
		ModelsJSON: string(modelsJSON), MaxDepth: depth, Folders: folders, OrchestratorModel: models.Orchestrator,
		BudgetUSD: in.BudgetUSD.Value, Access: access, MemoryJSON: memJSON,
		Network: deref(in.Network), NetworkPrivate: in.NetworkPrivate != nil && *in.NetworkPrivate, Mode: deref(in.Mode),
	})
	if err != nil {
		return Project{}, err
	}
	if err := saveCommands(ctx, db, in.Commands); err != nil {
		return Project{}, err
	}
	if err := saveReview(ctx, db, in.Review); err != nil {
		return Project{}, err
	}
	if err := saveSessionSettings(ctx, db, in.SessionSettings); err != nil {
		return Project{}, err
	}
	return s.load(ctx, db)
}

func (s *Service) Update(ctx context.Context, pid string, in Input) (Project, error) {
	db, err := s.db(ctx, pid)
	if err != nil {
		return Project{}, err
	}
	cur, err := s.load(ctx, db)
	if err != nil {
		return Project{}, err
	}
	patch := projectstore.InfoPatch{Description: in.Description, Instructions: in.Instructions}
	if in.Name != nil {
		name := strings.TrimSpace(*in.Name)
		if name == "" {
			return Project{}, invalid("name must not be empty")
		}
		patch.Name = &name
	}
	if in.MaxDepth != nil {
		if err := validDepth(*in.MaxDepth); err != nil {
			return Project{}, err
		}
		patch.MaxDepth = in.MaxDepth
	}
	if in.Models != nil {
		if err := s.ValidateModels(in.Models); err != nil {
			return Project{}, err
		}
		merged, err := mergeModels(cur.Models, in.Models)
		if err != nil {
			return Project{}, err
		}
		merged = alignACPSessionModels(merged, in.Models)
		raw, err := json.Marshal(merged)
		if err != nil {
			return Project{}, err
		}
		js := string(raw)
		patch.ModelsJSON = &js
	}
	if err := validBudget(in.BudgetUSD); err != nil {
		return Project{}, err
	}
	patch.SetBudget, patch.BudgetUSD = in.BudgetUSD.Set, in.BudgetUSD.Value
	if err := validAccess(in.Access); err != nil {
		return Project{}, err
	}
	patch.Access = in.Access
	if err := validNetwork(in.Network); err != nil {
		return Project{}, err
	}
	patch.Network, patch.NetworkPrivate = in.Network, in.NetworkPrivate
	if err := validMode(in.Mode); err != nil {
		return Project{}, err
	}
	patch.Mode = in.Mode
	if err := checkCommands(in.Commands); err != nil {
		return Project{}, err
	}
	if err := checkReview(in.Review); err != nil {
		return Project{}, err
	}
	if err := checkSessionSettings(in.SessionSettings); err != nil {
		return Project{}, err
	}
	if in.Memory != nil {
		if err := in.Memory.Validate(); err != nil {
			return Project{}, invalid("%s", err.Error())
		}
		js := cur.Memory.Merge(*in.Memory).JSON()
		patch.MemoryJSON = &js
	}
	var folders []projectstore.Folder
	if in.Folders != nil {
		if folders, err = resolveFolders(*in.Folders); err != nil {
			return Project{}, err
		}
	}
	if err := s.apply(ctx, db, patch, in.Folders != nil, folders); err != nil {
		return Project{}, err
	}
	if err := saveCommands(ctx, db, in.Commands); err != nil {
		return Project{}, err
	}
	if err := saveReview(ctx, db, in.Review); err != nil {
		return Project{}, err
	}
	if err := saveSessionSettings(ctx, db, in.SessionSettings); err != nil {
		return Project{}, err
	}
	if in.SessionSettings != nil {
		if st, ok := s.turns.(SessionTurns); ok {
			st.Reschedule() // a higher cap lets waiting messages start now
		}
	}
	p, err := s.load(ctx, db)
	if err != nil {
		return Project{}, err
	}
	if in.Models != nil && !s.turns.Running(pid) {
		orch, err := db.UpdateAgent(ctx, p.OrchestratorAgentID, projectstore.AgentPatch{Model: &p.Models.Orchestrator})
		if err != nil {
			return Project{}, err
		}
		s.hub.Publish(pid, events.AgentUpdated, map[string]any{"agent": orch})
	}
	s.hub.Publish(pid, events.ProjectUpdated, map[string]any{"project": p})
	return p, nil
}

func (s *Service) apply(ctx context.Context, db *projectstore.DB, patch projectstore.InfoPatch, replace bool, folders []projectstore.Folder) error {
	if replace {
		if err := db.ReplaceFolders(ctx, folders); err != nil {
			return err
		}
	}
	if err := db.UpdateInfo(ctx, patch); err != nil {
		return err
	}
	if patch.Name != nil {
		return s.store.Rename(ctx, db.ID(), *patch.Name)
	}
	return nil
}

func (s *Service) Delete(ctx context.Context, pid string) error {
	if _, err := s.db(ctx, pid); err != nil {
		return err
	}
	if s.turns.Running(pid) {
		return turnInProgress()
	}
	s.turns.CancelSide(pid)
	s.turns.CloseProject(pid)
	if err := s.store.Delete(ctx, pid); err != nil {
		return err
	}
	s.hub.Forget(pid)
	return nil
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// modelFields lists the model settings of a project in a fixed order.
func modelFields(m config.Models) []struct{ field, model string } {
	list := []struct{ field, model string }{
		{"orchestrator", m.Orchestrator}, {"fast", m.Fast}, {"balanced", m.Balanced}, {"deep", m.Deep},
		{"side", m.Side}, {"completion", m.Completion},
	}
	for _, c := range m.AutoCandidates {
		list = append(list, struct{ field, model string }{"auto_candidates", c})
	}
	return list
}

// ModelIssue is a model a project stores that cannot run now.
type ModelIssue struct {
	Field    string `json:"field"`
	Model    string `json:"model"`
	Provider string `json:"provider"`
	Reason   string `json:"reason"`
}

// unusableModels lists the models of m that snap says cannot run; reading a
// project never fails because of them.
func unusableModels(snap providers.Response, m config.Models) []ModelIssue {
	out := []ModelIssue{}
	for _, f := range modelFields(m) {
		if f.model == "" {
			continue
		}
		if u := providers.CheckIn(snap, f.model); u != nil {
			out = append(out, ModelIssue{Field: f.field, Model: f.model, Provider: u.Provider, Reason: u.Reason})
		}
	}
	return out
}
