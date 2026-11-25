// Package mcp is a small MCP (Model Context Protocol) server: Streamable HTTP
// (POST only, JSON responses) exposing tools supplied by a Backend, guarded by
// per-session bearer tokens, loopback only. It implements what a tool-calling
// client needs: initialize (with the backend's instructions, if it has any),
// ping, tools/list and tools/call.
package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strings"
)

// PathPrefix is where the bridge mounts the server; a session's endpoint is
// PathPrefix + project id.
const PathPrefix = "/mcp/v1/projects/"

// Path is the MCP endpoint path of a project.
func Path(projectID string) string { return PathPrefix + url.PathEscape(projectID) }

const (
	maxBody       = 4 << 20
	latestVersion = "2025-06-18"
	// ServerName is reported in initialize and used as the mcpServers entry name.
	ServerName = "octo-harness"
)

var supportedVersions = []string{"2025-06-18", "2025-03-26", "2024-11-05"}

// Tool describes one tool for tools/list.
type Tool struct {
	Name        string          `json:"name"`
	Description string          `json:"description,omitempty"`
	InputSchema json.RawMessage `json:"inputSchema"`
}

// ErrUnknownTool is returned by Backend.Call for a tool name it does not have.
var ErrUnknownTool = errors.New("mcp: unknown tool")

// Backend supplies the tools a binding may use.
type Backend interface {
	Tools(b Binding) ([]Tool, error)
	// Call runs a tool. A tool-level failure is (text, true, nil); err is for
	// failures of the call itself (ErrUnknownTool, no active turn...).
	Call(ctx context.Context, b Binding, name string, args json.RawMessage) (text string, isError bool, err error)
}

// Instructor is an optional Backend extension: text for the "instructions"
// field of the initialize result. MCP clients put a server's instructions into
// the model's system prompt, also when they load the tools' schemas only on
// demand (Claude Code's tool search), so they are the place to say what the
// tools take. "" leaves the field out.
type Instructor interface {
	Instructions(b Binding) string
}

// Server is the http.Handler.
type Server struct {
	tokens  *Tokens
	backend Backend
	version string
}

func NewServer(tokens *Tokens, backend Backend, version string) *Server {
	return &Server{tokens: tokens, backend: backend, version: version}
}

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !loopback(r.RemoteAddr) {
		http.Error(w, "loopback only", http.StatusForbidden)
		return
	}
	if o := r.Header.Get("Origin"); o != "" && !loopbackOrigin(o) {
		http.Error(w, "origin not allowed", http.StatusForbidden)
		return
	}
	tok, ok := bearer(r)
	if !ok {
		unauthorized(w)
		return
	}
	b, ok := s.tokens.Lookup(tok)
	if !ok {
		unauthorized(w)
		return
	}
	pid, found := strings.CutPrefix(r.URL.Path, PathPrefix)
	if unescaped, err := url.PathUnescape(pid); err == nil {
		pid = unescaped
	}
	if !found || pid != b.ProjectID {
		http.Error(w, "token does not grant this project", http.StatusForbidden)
		return
	}
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBody))
	if err != nil {
		http.Error(w, "request body too large or unreadable", http.StatusRequestEntityTooLarge)
		return
	}
	var req rpcRequest
	if err := json.Unmarshal(body, &req); err != nil {
		writeRPC(w, nil, nil, &rpcError{Code: -32700, Message: "parse error: " + err.Error()}, http.StatusBadRequest)
		return
	}
	if req.Method == "" || len(req.ID) == 0 {
		// A notification or a response from the client: accepted, no body.
		w.WriteHeader(http.StatusAccepted)
		return
	}
	result, rpcErr := s.dispatch(r.Context(), b, req)
	writeRPC(w, req.ID, result, rpcErr, http.StatusOK)
}

func (s *Server) dispatch(ctx context.Context, b Binding, req rpcRequest) (any, *rpcError) {
	switch req.Method {
	case "initialize":
		var p struct {
			ProtocolVersion string `json:"protocolVersion"`
		}
		_ = json.Unmarshal(req.Params, &p)
		version := latestVersion
		for _, v := range supportedVersions {
			if v == p.ProtocolVersion {
				version = v
			}
		}
		result := map[string]any{
			"protocolVersion": version,
			"capabilities":    map[string]any{"tools": map[string]any{"listChanged": false}},
			"serverInfo":      map[string]string{"name": ServerName, "version": s.version},
		}
		if in, ok := s.backend.(Instructor); ok {
			if text := in.Instructions(b); text != "" {
				result["instructions"] = text
			}
		}
		return result, nil
	case "ping":
		return map[string]any{}, nil
	case "tools/list":
		tools, err := s.backend.Tools(b)
		if err != nil {
			return nil, &rpcError{Code: -32000, Message: err.Error()}
		}
		if tools == nil {
			tools = []Tool{}
		}
		return map[string]any{"tools": tools}, nil
	case "tools/call":
		var p struct {
			Name      string          `json:"name"`
			Arguments json.RawMessage `json:"arguments"`
		}
		if err := json.Unmarshal(req.Params, &p); err != nil || p.Name == "" {
			return nil, &rpcError{Code: -32602, Message: "tools/call needs a tool name"}
		}
		if len(p.Arguments) == 0 || string(p.Arguments) == "null" {
			p.Arguments = json.RawMessage(`{}`)
		}
		text, isErr, err := s.backend.Call(ctx, b, p.Name, p.Arguments)
		switch {
		case errors.Is(err, ErrUnknownTool):
			return nil, &rpcError{Code: -32602, Message: "unknown tool: " + p.Name}
		case err != nil:
			slog.Warn("mcp tool call failed", "project", b.ProjectID, "tool", p.Name, "err", err)
			text, isErr = "tool failed: "+err.Error(), true
		}
		return map[string]any{
			"content": []map[string]string{{"type": "text", "text": text}},
			"isError": isErr,
		}, nil
	}
	return nil, &rpcError{Code: -32601, Message: "method not found: " + req.Method}
}

func writeRPC(w http.ResponseWriter, id json.RawMessage, result any, rpcErr *rpcError, status int) {
	msg := map[string]any{"jsonrpc": "2.0"}
	if len(id) > 0 {
		msg["id"] = json.RawMessage(id)
	} else {
		msg["id"] = nil
	}
	if rpcErr != nil {
		msg["error"] = rpcErr
	} else {
		msg["result"] = result
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(msg); err != nil {
		slog.Debug("mcp: write response", "err", err)
	}
}

func unauthorized(w http.ResponseWriter) {
	w.Header().Set("WWW-Authenticate", `Bearer realm="octo-harness-mcp"`)
	http.Error(w, "missing or invalid token", http.StatusUnauthorized)
}

func bearer(r *http.Request) (string, bool) {
	h := r.Header.Get("Authorization")
	if len(h) < 8 || !strings.EqualFold(h[:7], "bearer ") {
		return "", false
	}
	return strings.TrimSpace(h[7:]), true
}

func loopback(remoteAddr string) bool {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		host = remoteAddr
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func loopbackOrigin(origin string) bool {
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	switch u.Hostname() {
	case "localhost", "127.0.0.1", "::1":
		return true
	}
	return false
}
