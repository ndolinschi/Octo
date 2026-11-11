package project

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/budget"
	"github.com/ndolinschi/Octo/apps/harness/internal/config"
	"github.com/ndolinschi/Octo/apps/harness/internal/events"
	"github.com/ndolinschi/Octo/apps/harness/internal/orchestrator"
	"github.com/ndolinschi/Octo/apps/harness/internal/prices"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
	"github.com/ndolinschi/Octo/apps/harness/internal/router"
)

// Turns is the orchestrator surface the service drives.
type Turns interface {
	Start(ctx context.Context, projectID, text string) (projectstore.Message, error)
	Cancel(projectID string)
	Running(projectID string) bool
	Context(ctx context.Context, projectID, agentID string) (orchestrator.ContextReport, error)
	Side(ctx context.Context, projectID, text string) (orchestrator.SideStart, error)
	CancelSide(projectID string)
}

type Defaults struct {
	Models   config.Models
	MaxDepth int
}

// Service is the application layer behind the bridge: projects, agents, messages.
type Service struct {
	store    *projectstore.Store
	hub      *events.Hub
	turns    Turns
	defaults Defaults
	prices   prices.Table
	router   *router.Router
	now      func() time.Time
}

// ServiceOption customizes NewService.
type ServiceOption func(*Service)

// WithPrices sets the table used to estimate API usage cost.
func WithPrices(t prices.Table) ServiceOption { return func(s *Service) { s.prices = t } }

// WithRouter lets project JSON include the spend an Octo router last reported.
func WithRouter(r *router.Router) ServiceOption { return func(s *Service) { s.router = r } }

func (s *Service) meter() budget.Meter { return budget.Meter{Prices: s.prices, Router: s.router} }

func NewService(store *projectstore.Store, hub *events.Hub, turns Turns, defaults Defaults, opts ...ServiceOption) *Service {
	s := &Service{store: store, hub: hub, turns: turns, defaults: defaults, now: time.Now}
	for _, o := range opts {
		o(s)
	}
	return s
}

func (s *Service) Defaults() Defaults { return s.defaults }

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
		if err := db.RecoverInterrupted(ctx); err != nil {
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
	return db, err
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
	depth := s.defaults.MaxDepth
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
	models, err := mergeModels(s.defaults.Models, in.Models)
	if err != nil {
		return Project{}, err
	}
	if err := validBudget(in.BudgetUSD); err != nil {
		return Project{}, err
	}
	modelsJSON, err := json.Marshal(models)
	if err != nil {
		return Project{}, err
	}
	db, err := s.store.Create(ctx, projectstore.NewProject{
		Name: strings.TrimSpace(*in.Name), Description: deref(in.Description), Instructions: deref(in.Instructions),
		ModelsJSON: string(modelsJSON), MaxDepth: depth, Folders: folders, OrchestratorModel: models.Orchestrator,
		BudgetUSD: in.BudgetUSD.Value,
	})
	if err != nil {
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
		merged, err := mergeModels(cur.Models, in.Models)
		if err != nil {
			return Project{}, err
		}
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
	var folders []projectstore.Folder
	if in.Folders != nil {
		if folders, err = resolveFolders(*in.Folders); err != nil {
			return Project{}, err
		}
	}
	if err := s.apply(ctx, db, patch, in.Folders != nil, folders); err != nil {
		return Project{}, err
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
		return turnInProgress("project has a running turn; cancel it first")
	}
	s.turns.CancelSide(pid)
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
