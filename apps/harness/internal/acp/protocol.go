// Package acp is a client for the Agent Client Protocol: JSON-RPC 2.0 over a
// child process's stdio, one compact JSON object per line. It knows nothing
// about projects or the orchestrator; callers implement Handler.
package acp

import (
	"encoding/json"
	"fmt"
)

// ProtocolVersion is the only protocol version this client speaks.
const ProtocolVersion = 1

// Methods.
const (
	methodInitialize  = "initialize"
	methodSessionNew  = "session/new"
	methodSessionLoad = "session/load"
	methodPrompt      = "session/prompt"
	methodCancel      = "session/cancel"
	methodAuth        = "authenticate"
	methodSetModel    = "session/set_model"
	methodSetConfig   = "session/set_config_option"
	methodSetMode     = "session/set_mode"
	methodUpdate      = "session/update"
	methodPermission  = "session/request_permission"
	methodReadFile    = "fs/read_text_file"
	methodWriteFile   = "fs/write_text_file"
	codeMethodMissing = -32601
	codeInvalidParams = -32602
	codeInternal      = -32603
	codeServerError   = -32000
)

// StopReason says why a prompt turn ended.
type StopReason string

const (
	StopEndTurn         StopReason = "end_turn"
	StopMaxTokens       StopReason = "max_tokens"
	StopMaxTurnRequests StopReason = "max_turn_requests"
	StopRefusal         StopReason = "refusal"
	StopCancelled       StopReason = "cancelled"
)

// ToolStatus is a tool call's lifecycle state.
type ToolStatus string

const (
	ToolPending    ToolStatus = "pending"
	ToolInProgress ToolStatus = "in_progress"
	ToolCompleted  ToolStatus = "completed"
	ToolFailed     ToolStatus = "failed"
)

// Terminal reports whether the status ends the tool call.
func (s ToolStatus) Terminal() bool { return s == ToolCompleted || s == ToolFailed }

// OptionKind classifies a permission option.
type OptionKind string

const (
	AllowOnce    OptionKind = "allow_once"
	AllowAlways  OptionKind = "allow_always"
	RejectOnce   OptionKind = "reject_once"
	RejectAlways OptionKind = "reject_always"
)

// RPCError is a JSON-RPC error object; it is both received and returned.
type RPCError struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
}

func (e *RPCError) Error() string { return fmt.Sprintf("acp rpc error %d: %s", e.Code, e.Message) }

type clientCapabilities struct {
	FS       fsCapabilities `json:"fs"`
	Terminal bool           `json:"terminal"`
}

type fsCapabilities struct {
	ReadTextFile  bool `json:"readTextFile"`
	WriteTextFile bool `json:"writeTextFile"`
}

type implementation struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

type initializeParams struct {
	ProtocolVersion    int                `json:"protocolVersion"`
	ClientCapabilities clientCapabilities `json:"clientCapabilities"`
	ClientInfo         implementation     `json:"clientInfo"`
}

type initializeResult struct {
	ProtocolVersion   int               `json:"protocolVersion"`
	AgentInfo         *implementation   `json:"agentInfo"`
	AuthMethods       []AuthMethod      `json:"authMethods"`
	AgentCapabilities agentCapabilities `json:"agentCapabilities"`
}

// agentCapabilities is the part of initialize's agentCapabilities this client
// uses; every field defaults to false when absent (ACP schema).
type agentCapabilities struct {
	LoadSession        bool `json:"loadSession"`
	PromptCapabilities struct {
		Image bool `json:"image"`
	} `json:"promptCapabilities"`
	MCPCapabilities struct {
		HTTP bool `json:"http"`
		SSE  bool `json:"sse"`
	} `json:"mcpCapabilities"`
}

// Capabilities is what an agent advertised in initialize.
type Capabilities struct {
	// LoadSession: the agent supports session/load.
	LoadSession bool
	// PromptImage: the agent accepts image content blocks in session/prompt
	// (promptCapabilities.image).
	PromptImage bool
	// MCPHTTP: the agent accepts HTTP MCP servers in session/new (stdio is
	// mandatory for every agent).
	MCPHTTP bool
	// MCPSSE: the agent accepts SSE MCP servers (unused by this client).
	MCPSSE bool
}

// MCPServer is one entry of session/new's (and session/load's) mcpServers, in
// the wire shape of the ACP schema.
type MCPServer = json.RawMessage

// HTTPHeader is a name/value pair in an HTTP MCP server entry.
type HTTPHeader struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// EnvVar is a name/value pair in a stdio MCP server entry.
type EnvVar struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// HTTPMCPServer builds {"type":"http","name","url","headers":[...]}; the agent
// must have advertised mcpCapabilities.http.
func HTTPMCPServer(name, url string, headers []HTTPHeader) MCPServer {
	if headers == nil {
		headers = []HTTPHeader{}
	}
	raw, _ := json.Marshal(map[string]any{"type": "http", "name": name, "url": url, "headers": headers})
	return raw
}

// StdioMCPServer builds {"name","command","args":[...],"env":[...]}; command
// must be an absolute path. Stdio has no "type" field in the schema.
func StdioMCPServer(name, command string, args []string, env []EnvVar) MCPServer {
	if args == nil {
		args = []string{}
	}
	if env == nil {
		env = []EnvVar{}
	}
	raw, _ := json.Marshal(map[string]any{"name": name, "command": command, "args": args, "env": env})
	return raw
}

type newSessionParams struct {
	Cwd        string            `json:"cwd"`
	MCPServers []json.RawMessage `json:"mcpServers"`
}

type loadSessionParams struct {
	SessionID  string            `json:"sessionId"`
	Cwd        string            `json:"cwd"`
	MCPServers []json.RawMessage `json:"mcpServers"`
}

type newSessionResult struct {
	SessionID string `json:"sessionId"`
	// Models and ConfigOptions stay raw: agents differ in shape, and an
	// unreadable one must not fail the session.
	Models        json.RawMessage   `json:"models"`
	ConfigOptions []json.RawMessage `json:"configOptions"`
	Meta          json.RawMessage   `json:"_meta"`
	// Modes is the session's mode list (currentModeId, availableModes), raw for the same reason.
	Modes json.RawMessage `json:"modes"`
}

type contentBlock struct {
	Type string `json:"type"`
	Text string `json:"text,omitempty"`
	// Data and MimeType carry an image block (base64 data).
	Data     string `json:"data,omitempty"`
	MimeType string `json:"mimeType,omitempty"`
}

type promptParams struct {
	SessionID string         `json:"sessionId"`
	Prompt    []contentBlock `json:"prompt"`
}

type promptResult struct {
	StopReason StopReason `json:"stopReason"`
	// Usage is the token usage of the prompt, which agents that implement the
	// usage extension of session/prompt put in its response.
	Usage *PromptUsage `json:"usage"`
}

// PromptUsage is the per-prompt token usage an agent may report with its
// stopReason.
type PromptUsage struct {
	InputTokens       int64 `json:"inputTokens"`
	OutputTokens      int64 `json:"outputTokens"`
	ThoughtTokens     int64 `json:"thoughtTokens"`
	CachedReadTokens  int64 `json:"cachedReadTokens"`
	CachedWriteTokens int64 `json:"cachedWriteTokens"`
	TotalTokens       int64 `json:"totalTokens"`
}

type cancelParams struct {
	SessionID string `json:"sessionId"`
}

type sessionNotification struct {
	SessionID string          `json:"sessionId"`
	Update    json.RawMessage `json:"update"`
}

type updateHeader struct {
	SessionUpdate string `json:"sessionUpdate"`
}

type contentChunk struct {
	Content contentBlock `json:"content"`
}

// Location is a file a tool call touches.
type Location struct {
	Path string `json:"path"`
	Line *int   `json:"line,omitempty"`
}

// ToolContent is one item of a tool call's content: Type is "content",
// "diff" or "terminal".
type ToolContent struct {
	Type       string        `json:"type"`
	Content    *contentBlock `json:"content,omitempty"`
	Path       string        `json:"path,omitempty"`
	OldText    *string       `json:"oldText,omitempty"`
	NewText    string        `json:"newText,omitempty"`
	TerminalID string        `json:"terminalId,omitempty"`
}

// ToolCall announces a tool call. ToolCallUpdate carries only changed fields
// (empty string / nil slices mean "unchanged").
type ToolCall struct {
	ID        string          `json:"toolCallId"`
	Title     string          `json:"title"`
	Kind      string          `json:"kind"`
	Status    ToolStatus      `json:"status"`
	Content   []ToolContent   `json:"content"`
	Locations []Location      `json:"locations"`
	RawInput  json.RawMessage `json:"rawInput"`
	RawOutput json.RawMessage `json:"rawOutput"`
}

type ToolCallUpdate = ToolCall

// Cost is the cumulative session cost an agent may report in a usage_update.
type Cost struct {
	Amount   float64 `json:"amount"`
	Currency string  `json:"currency"`
}

// Usage is a usage_update: tokens currently in context, the window size and,
// when the agent reports it, the cumulative cost.
type Usage struct {
	Used int64 `json:"used"`
	Size int64 `json:"size"`
	Cost *Cost `json:"cost,omitempty"`
}

// PermissionOption is one choice offered by session/request_permission.
type PermissionOption struct {
	ID   string     `json:"optionId"`
	Name string     `json:"name"`
	Kind OptionKind `json:"kind"`
}

type PermissionRequest struct {
	SessionID string             `json:"sessionId"`
	ToolCall  ToolCallUpdate     `json:"toolCall"`
	Options   []PermissionOption `json:"options"`
}

// FirstOption returns the first option of the first kind (in kinds order)
// that is offered.
func (r PermissionRequest) FirstOption(kinds ...OptionKind) (PermissionOption, bool) {
	for _, k := range kinds {
		for _, o := range r.Options {
			if o.Kind == k {
				return o, true
			}
		}
	}
	return PermissionOption{}, false
}

type permissionOutcome struct {
	Outcome  string `json:"outcome"`
	OptionID string `json:"optionId,omitempty"`
}

type permissionResult struct {
	Outcome permissionOutcome `json:"outcome"`
}

// ReadTextFileParams is fs/read_text_file; Line is 1-based.
type ReadTextFileParams struct {
	SessionID string `json:"sessionId"`
	Path      string `json:"path"`
	Line      *int   `json:"line,omitempty"`
	Limit     *int   `json:"limit,omitempty"`
}

// WriteTextFileParams is fs/write_text_file.
type WriteTextFileParams struct {
	SessionID string `json:"sessionId"`
	Path      string `json:"path"`
	Content   string `json:"content"`
}
