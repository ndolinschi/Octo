package project

import (
	"context"
	"encoding/json"

	"github.com/ndolinschi/Octo/apps/harness/internal/config"
	"github.com/ndolinschi/Octo/apps/harness/internal/memory"
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
	// NeedsYou is true while an approval or a form waits for the user;
	// PendingApprovals and PendingInputs count them. (Status stays idle or
	// running: a turn that waits for the user is still running.)
	NeedsYou         bool `json:"needs_you"`
	PendingApprovals int  `json:"pending_approvals"`
	PendingInputs    int  `json:"pending_inputs"`
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
	// Access is "supervised" (writes, commands and ACP permission requests
	// wait for the user) or "full".
	Access string `json:"access"`
	// Memory is the memory setting: how the orchestrator's context is built.
	Memory memory.Settings `json:"memory"`
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
	models := s.Defaults().Models
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
		BudgetUSD: info.BudgetUSD, Access: info.Access, Memory: memory.ParseSettings(info.MemoryJSON),
	}
	p.PendingApprovals, p.PendingInputs = s.turns.Attention(info.ID)
	p.NeedsYou = p.PendingApprovals+p.PendingInputs > 0
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

// Compaction is a transcript marker: the history up to and including message
// UptoMessageID was replaced by a summary at At. SummaryTokens is an estimate.
type Compaction struct {
	UptoMessageID int64  `json:"upto_message_id"`
	At            string `json:"at"`
	SummaryTokens int64  `json:"summary_tokens"`
}
