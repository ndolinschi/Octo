// Package permission is the single place that answers an ACP agent's
// session/request_permission. Today's policy is "approve within the project
// folders" (the folder confinement itself is enforced where the agent acts:
// fs/* requests are rejected outside the folders); the v7 approvals work
// replaces the Policy behind Decide without touching any caller.
package permission

import (
	"context"
	"log/slog"
	"sync"

	"github.com/ndolinschi/Octo/apps/harness/internal/acp"
)

// Request is one permission question from an agent.
type Request struct {
	ProjectID string
	// Agent is the plugin agent id (for logs and for policies per agent).
	Agent string
	// Orchestrator is true when the agent runs the project's orchestrator
	// rather than a sub-agent task.
	Orchestrator bool
	ACP          acp.PermissionRequest
}

// Decision is the answer. OptionID is the chosen option; empty means cancel
// (the agent is told the request was cancelled).
type Decision struct {
	OptionID string
	Allow    bool
	Reason   string
}

// Policy decides a request.
type Policy interface {
	Decide(ctx context.Context, req Request) Decision
}

// AutoApprove approves with the first allow option the agent offers.
type AutoApprove struct{}

func (AutoApprove) Decide(_ context.Context, req Request) Decision {
	opt, ok := req.ACP.FirstOption(acp.AllowOnce, acp.AllowAlways)
	if !ok {
		slog.Warn("acp permission: no allow option offered; cancelling",
			"project", req.ProjectID, "agent", req.Agent, "tool", req.ACP.ToolCall.Title)
		return Decision{Reason: "no allow option offered"}
	}
	slog.Info("acp permission auto-approved",
		"project", req.ProjectID, "agent", req.Agent, "tool", req.ACP.ToolCall.Title, "option", opt.Name, "kind", opt.Kind)
	return Decision{OptionID: opt.ID, Allow: true, Reason: "auto-approved within the project folders"}
}

var (
	mu      sync.RWMutex
	current Policy = AutoApprove{}
)

// SetPolicy replaces the policy (v7 approvals plug in here); nil restores the default.
func SetPolicy(p Policy) {
	mu.Lock()
	defer mu.Unlock()
	if p == nil {
		p = AutoApprove{}
	}
	current = p
}

// Decide answers a permission request through the current policy.
func Decide(ctx context.Context, req Request) Decision {
	mu.RLock()
	p := current
	mu.RUnlock()
	return p.Decide(ctx, req)
}
