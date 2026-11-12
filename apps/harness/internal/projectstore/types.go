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
	// BudgetUSD is the project's spend cap; nil means none.
	BudgetUSD *float64
	// Access is "supervised" or "full" (see AccessSupervised).
	Access string
	// MemoryJSON is the project's memory settings (context mode, window size).
	MemoryJSON string
	// Network is "off" (default) or "on": whether agents may use web_fetch.
	// NetworkPrivate lets web_fetch reach private and loopback addresses.
	Network        string
	NetworkPrivate bool
	// Mode is the project's default mode: agent, ask or plan.
	Mode string
}

// Network settings of a project.
const (
	NetworkOff = "off"
	NetworkOn  = "on"
)

func orNetworkOff(n string) string {
	if n == NetworkOn {
		return n
	}
	return NetworkOff
}

func orEmptyJSON(s string) string {
	if s == "" {
		return "{}"
	}
	return s
}

// Access modes of a project (v7 approvals).
const (
	AccessSupervised = "supervised"
	AccessFull       = "full"
)

func orFull(a string) string {
	if a == AccessSupervised {
		return a
	}
	return AccessFull
}

type Folder struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	Path  string `json:"path"`
}

type Agent struct {
	ID        string      `json:"id"`
	ProjectID string      `json:"project_id"`
	ParentID  *string     `json:"parent_id"`
	Depth     int         `json:"depth"`
	Role      string      `json:"role"`
	Title     string      `json:"title"`
	Task      string      `json:"task"`
	Model     string      `json:"model"`
	Tier      *Tier       `json:"tier"`
	Status    AgentStatus `json:"status"`
	Result    *string     `json:"result"`
	Error     *string     `json:"error"`
	// ErrorHint says what to do about Error (for a login problem, how to log in); never part of its text.
	ErrorHint      *string `json:"error_hint"`
	SpawnToolUseID *string `json:"spawn_tool_use_id"`
	InputTokens    int64   `json:"input_tokens"`
	OutputTokens   int64   `json:"output_tokens"`
	CreatedAt      string  `json:"created_at"`
	StartedAt      *string `json:"started_at"`
	FinishedAt     *string `json:"finished_at"`
	ContextUsed    *int64  `json:"context_used"`
	ContextSize    *int64  `json:"context_size"`
	// ServedModel and RoutedTier come from the agent's newest main-thread API
	// usage row: the model the Octo router answered with and the router tier it
	// chose. Both are null with no router in the path or nothing recorded yet.
	// (Tier above is the tier the agent was spawned at, not the router's.)
	ServedModel *string `json:"served_model"`
	RoutedTier  *string `json:"routed_tier"`
	// The router's decision for a sub-agent spawned with tier "auto"; all null
	// for an agent whose tier was chosen explicitly. RouteChoice is the
	// candidate that was started (also after a fallback), RouteReason why,
	// RouteBand the router's difficulty class (easy|medium|hard) and
	// RouteRequestID the router's id of the route call.
	RouteReason    *string `json:"route_reason"`
	RouteBand      *string `json:"route_band"`
	RouteRequestID *string `json:"route_request_id"`
	RouteChoice    *string `json:"route_choice"`
	// Plan is the latest plan an ACP agent published (null when none).
	Plan []PlanEntry `json:"plan"`
}

// PlanEntry is one line of an agent's plan.
type PlanEntry struct {
	Content  string `json:"content"`
	Status   string `json:"status"`
	Priority string `json:"priority"`
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
	// Route is the router decision recorded on the agent (nil: tier was explicit).
	Route *RouteInfo
}

// RouteInfo is what the agent row keeps of an automatic choice; empty fields
// are stored as null.
type RouteInfo struct {
	Reason, Band, RequestID, Choice string
}

// AgentPatch updates only the non-nil fields.
type AgentPatch struct {
	Status     *AgentStatus
	Model      *string
	Result     *string
	Error      *string
	ErrorHint  *string
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
	// SetBudget says BudgetUSD is provided; a nil BudgetUSD then clears the budget.
	SetBudget  bool
	BudgetUSD  *float64
	Access     *string
	MemoryJSON *string
	// Network and NetworkPrivate change the web_fetch settings.
	Network        *string
	NetworkPrivate *bool
	Mode           *string
}

type NewProject struct {
	Name         string
	Description  string
	Instructions string
	ModelsJSON   string
	MaxDepth     int
	Folders      []Folder
	BudgetUSD    *float64
	// Access is the new project's access mode ("" = full).
	Access string
	// MemoryJSON is the new project's memory settings ("" = defaults).
	MemoryJSON string
	// Network ("" = off) and NetworkPrivate are the new project's web_fetch settings.
	Network        string
	NetworkPrivate bool
	// Mode ("" = agent) is the new project's default mode.
	Mode string
	// OrchestratorModel is recorded on the project's root agent row.
	OrchestratorModel string
}

// Now returns a fixed-width RFC 3339 UTC timestamp that sorts lexically.
func Now() string { return Stamp(time.Now()) }

// Stamp formats t the way Now does, for comparing against stored times.
func Stamp(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z07:00") }
