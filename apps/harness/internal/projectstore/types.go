package projectstore

import (
	"errors"
	"time"
)

var ErrNotFound = errors.New("projectstore: not found")

type AgentStatus string

const (
	StatusIdle      AgentStatus = "idle"
	StatusRunning   AgentStatus = "running"
	StatusCompleted AgentStatus = "completed"
	StatusFailed    AgentStatus = "failed"
	StatusCancelled AgentStatus = "cancelled"
)

type Tier string

const (
	TierFast     Tier = "fast"
	TierBalanced Tier = "balanced"
	TierDeep     Tier = "deep"
)

func (t Tier) Valid() bool {
	return t == TierFast || t == TierBalanced || t == TierDeep
}

type NoteAuthor string

const (
	AuthorUser         NoteAuthor = "user"
	AuthorOrchestrator NoteAuthor = "orchestrator"
)

const OrchestratorRole = "orchestrator"

// Project is the single `project` row.
type Project struct {
	ID           string
	Name         string
	Description  string
	Instructions string
	ModelsJSON   string
	MaxDepth     int
	CreatedAt    string
	UpdatedAt    string
}

type Folder struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	Path  string `json:"path"`
}

type Agent struct {
	ID             string      `json:"id"`
	ProjectID      string      `json:"project_id"`
	ParentID       *string     `json:"parent_id"`
	Depth          int         `json:"depth"`
	Role           string      `json:"role"`
	Title          string      `json:"title"`
	Task           string      `json:"task"`
	Model          string      `json:"model"`
	Tier           *Tier       `json:"tier"`
	Status         AgentStatus `json:"status"`
	Result         *string     `json:"result"`
	Error          *string     `json:"error"`
	SpawnToolUseID *string     `json:"spawn_tool_use_id"`
	InputTokens    int64       `json:"input_tokens"`
	OutputTokens   int64       `json:"output_tokens"`
	CreatedAt      string      `json:"created_at"`
	StartedAt      *string     `json:"started_at"`
	FinishedAt     *string     `json:"finished_at"`
}

type NewAgent struct {
	ParentID       *string
	Depth          int
	Role           string
	Title          string
	Task           string
	Model          string
	Tier           *Tier
	Status         AgentStatus
	SpawnToolUseID *string
	Started        bool
}

// AgentPatch updates only the non-nil fields.
type AgentPatch struct {
	Status     *AgentStatus
	Model      *string
	Result     *string
	Error      *string
	StartedAt  *string
	FinishedAt *string
	// Reset clears result, error and finished_at before applying the other fields.
	Reset bool
}

type Note struct {
	ID        string     `json:"id"`
	Title     string     `json:"title"`
	Content   string     `json:"content"`
	Author    NoteAuthor `json:"author"`
	CreatedAt string     `json:"created_at"`
	UpdatedAt string     `json:"updated_at"`
}

type InfoPatch struct {
	Name         *string
	Description  *string
	Instructions *string
	ModelsJSON   *string
	MaxDepth     *int
}

type NewProject struct {
	Name         string
	Description  string
	Instructions string
	ModelsJSON   string
	MaxDepth     int
	Folders      []Folder
	// OrchestratorModel is recorded on the project's root agent row.
	OrchestratorModel string
}

// Now returns a fixed-width RFC 3339 UTC timestamp that sorts lexically.
func Now() string {
	return time.Now().UTC().Format("2006-01-02T15:04:05.000Z07:00")
}
