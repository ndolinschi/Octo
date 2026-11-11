package project

import (
	"context"
	"encoding/json"

	"github.com/ndolinschi/Octo/apps/harness/internal/config"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

type Summary struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Status      string `json:"status"`
	FolderCount int    `json:"folder_count"`
	AgentCount  int    `json:"agent_count"`
	CreatedAt   string `json:"created_at"`
	UpdatedAt   string `json:"updated_at"`
}

type Project struct {
	Summary
	Instructions        string                `json:"instructions"`
	Folders             []projectstore.Folder `json:"folders"`
	Models              config.Models         `json:"models"`
	MaxDepth            int                   `json:"max_depth"`
	OrchestratorAgentID string                `json:"orchestrator_agent_id"`
	// BudgetUSD is the spend cap (null: none); SpentUSD the last known spend
	// (null: unknown).
	BudgetUSD *float64 `json:"budget_usd"`
	SpentUSD  *float64 `json:"spent_usd"`
}

func (s *Service) load(ctx context.Context, db *projectstore.DB) (Project, error) {
	info, err := db.Info(ctx)
	if err != nil {
		return Project{}, err
	}
	folders, err := db.Folders(ctx)
	if err != nil {
		return Project{}, err
	}
	agents, err := db.Agents(ctx)
	if err != nil {
		return Project{}, err
	}
	models := s.defaults.Models
	if err := json.Unmarshal([]byte(info.ModelsJSON), &models); err != nil {
		return Project{}, err
	}
	p := Project{
		Summary: Summary{
			ID: info.ID, Name: info.Name, Description: info.Description, Status: "idle",
			FolderCount: len(folders), AgentCount: len(agents),
			CreatedAt: info.CreatedAt, UpdatedAt: info.UpdatedAt,
		},
		Instructions: info.Instructions, Folders: folders, Models: models, MaxDepth: info.MaxDepth,
		BudgetUSD: info.BudgetUSD,
	}
	spent, known, err := s.meter().Spent(ctx, db)
	if err != nil {
		return Project{}, err
	}
	if known {
		p.SpentUSD = &spent
	}
	for _, a := range agents {
		if a.ParentID == nil {
			p.OrchestratorAgentID = a.ID
			if a.Status == projectstore.StatusRunning {
				p.Status = "running"
			}
		}
	}
	return p, nil
}
