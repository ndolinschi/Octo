package project

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/ndolinschi/Octo/apps/harness/internal/config"
	"github.com/ndolinschi/Octo/apps/harness/internal/memory"
	"github.com/ndolinschi/Octo/apps/harness/internal/projcfg"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
	"github.com/ndolinschi/Octo/apps/harness/internal/usererr"
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
	// Attention is what the project asks of the user: "needs_you" while an
	// approval or a form waits, "failed" when the last turn failed (the error is
	// on the orchestrator's agent row) and nothing waits, else "none".
	Attention string `json:"attention"`
	// Sessions counts the project's main sessions (not archived) by live state (schema 15).
	Sessions SessionsSummary `json:"sessions"`
	// Error is set, with Status "unavailable", when the project's database cannot be opened (damaged, unreadable,
	// written by a newer version): the catalogue case, the file path in details. Nothing else about it is known.
	// With another status it is a project folder that is missing (folder_missing).
	Error *usererr.Info `json:"error,omitempty"`
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
	// Network is "off" (default) or "on": agents get the web_fetch tool only when on
	// (in a supervised project every fetch is an approval). NetworkPrivate lets
	// web_fetch reach private and loopback addresses; it is refused otherwise.
	Network        string `json:"network"`
	NetworkPrivate bool   `json:"network_private"`
	// Mode is the project's default mode: "agent", "ask" (read-only answers) or "plan"
	// (read-only, the answer is a plan to approve). A message may override it for one turn.
	Mode string `json:"mode"`
	// ReviewWorkspace is the review whose worktree the file tree, editor, search and language
	// server are pointed at ("Open in workspace"); null when the project's own folders are shown.
	// While it is set the file API accepts the folder "@review" (see Files).
	ReviewWorkspace *projectstore.ReviewWorkspace `json:"review_workspace"`
	// Commands are the project's named commands (decision 68), [] when none.
	Commands []projcfg.Command `json:"commands"`
	// Review is the review configuration (UI decision 78): commands to offer, extra mechanical globs, split or unified.
	Review projcfg.ReviewConfig `json:"review"`
	// ModelsUnavailable lists the stored models whose provider cannot run them
	// now (never an error: the project is still readable and editable).
	ModelsUnavailable []ModelIssue `json:"models_unavailable"`
	// SessionSettings is the project's sessions setting: how many of its main sessions run at once
	// (max_running), where a new session works and how sessions coordinate (the last two: later phases).
	SessionSettings projectstore.SessionsSettings `json:"session_settings"`
	// AcceptsImages says whether the project's orchestrator takes images:
	// true for the built-in loop, what the ACP agent advertised
	// (promptCapabilities.image) once it has been started, null before that
	// (a message with images then asks the agent, and 422 images_unsupported
	// refuses it).
	AcceptsImages *bool `json:"accepts_images"`
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
		Network: info.Network, NetworkPrivate: info.NetworkPrivate, Mode: info.Mode,
	}
	if u := projectstore.MissingFolder(folders); u != nil {
		p.Error = u.Info() // the project stays usable to fix it; turns, terminals and runs answer this case
	}
	p.Commands = loadCommands(ctx, db)
	p.Review = loadReviewConfig(ctx, db)
	if ws, err := db.ReviewWorkspace(ctx); err == nil {
		p.ReviewWorkspace = ws
	}
	p.PendingApprovals, p.PendingInputs = s.turns.Attention(info.ID)
	p.NeedsYou = p.PendingApprovals+p.PendingInputs > 0
	if ok, known, _, err := s.turns.ImagesAccepted(ctx, info.ID, false); err == nil && known {
		p.AcceptsImages = &ok
	}
	p.ModelsUnavailable = []ModelIssue{}
	if s.provider != nil {
		p.ModelsUnavailable = unusableModels(s.provider.Snapshot(), models)
	}
	spent, known, err := s.meter().Spent(ctx, db)
	if err != nil {
		return Project{}, err
	}
	if known {
		p.SpentUSD = &spent
	}
	failed := false
	// orchestrator_agent_id is the default session's root (schema 15: every main session has its own root).
	if root, err := db.RootAgent(ctx, ""); err == nil {
		p.OrchestratorAgentID = root.ID
	}
	for _, a := range agents {
		if a.ParentID == nil {
			if a.Status == projectstore.StatusRunning {
				p.Status = "running"
			}
			// A root is idle after a failed turn; its error (not a warning) says it failed, until its
			// session's next request resets it.
			failed = failed || a.Status == projectstore.StatusFailed ||
				(a.Error != nil && *a.Error != "" && !strings.HasPrefix(*a.Error, "warning:"))
		}
	}
	p.SessionSettings = db.SessionsSettings(ctx)
	// Read last: a project whose orchestrator row says idle is still running until
	// turn.finished has been published (see Orchestrator.finish).
	if p.Status == "idle" && s.turns.Active(info.ID) {
		p.Status = "running"
	}
	p.Sessions = s.summarizeSessions(ctx, db)
	switch {
	case p.NeedsYou:
		p.Attention = "needs_you"
	case failed && p.Status != "running":
		p.Attention = "failed"
	default:
		p.Attention = "none"
	}
	return p, nil
}

// Compaction is a transcript marker: the history up to and including message
// UptoMessageID was replaced by a summary at At. SummaryTokens is an estimate.
//
// Label is the marker's text ("history compacted"); Manual says the user asked for it
// and MessageCount (manual only) how many messages the summary replaced.
type Compaction struct {
	UptoMessageID int64  `json:"upto_message_id"`
	At            string `json:"at"`
	SummaryTokens int64  `json:"summary_tokens"`
	Label         string `json:"label"`
	Manual        bool   `json:"manual"`
	MessageCount  int    `json:"message_count"`
}
