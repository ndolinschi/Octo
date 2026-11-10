package acp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// ErrAuthRequired marks a sub-agent that refused the session because it is
// not logged in and offers no login this client can complete unattended.
var ErrAuthRequired = errors.New("acp: agent is not logged in")

const authTimeout = 30 * time.Second

// AuthMethod is one entry of initialize's authMethods. Type is "agent" (or
// empty) when the agent logs in by itself; "terminal", "env_var" and unknown
// types need a person or an environment this client cannot provide.
type AuthMethod struct {
	ID          string          `json:"id"`
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Type        string          `json:"type"`
	Meta        json.RawMessage `json:"_meta"`
}

// Unattended reports whether the method can run without interaction.
func (m AuthMethod) Unattended() bool {
	var meta map[string]json.RawMessage
	if err := json.Unmarshal(m.Meta, &meta); err == nil {
		if _, legacy := meta["terminal-auth"]; legacy {
			return false
		}
	}
	return m.ID != "" && (m.Type == "" || m.Type == "agent")
}

// newSession opens a session; when the agent refuses and has advertised
// authentication methods, it authenticates once and retries.
func (c *Client) newSession(ctx context.Context, cwd, hint string) (newSessionResult, error) {
	var sess newSessionResult
	params := newSessionParams{Cwd: cwd, MCPServers: []json.RawMessage{}}
	err := c.conn.call(ctx, methodSessionNew, params, &sess)
	var rpcErr *RPCError
	if err != nil && errors.As(err, &rpcErr) && len(c.authMethods) > 0 {
		if authErr := c.authenticate(ctx, rpcErr, hint); authErr != nil {
			return sess, authErr
		}
		sess = newSessionResult{}
		err = c.conn.call(ctx, methodSessionNew, params, &sess)
	}
	if err != nil {
		return sess, fmt.Errorf("acp session/new: %w", err)
	}
	return sess, nil
}

// authenticate tries each unattended method in the order offered.
func (c *Client) authenticate(ctx context.Context, refusal *RPCError, hint string) error {
	var tried, failures []string
	for _, m := range c.authMethods {
		if !m.Unattended() {
			continue
		}
		tried = append(tried, m.ID)
		actx, cancel := context.WithTimeout(ctx, authTimeout)
		err := c.conn.call(actx, methodAuth, map[string]string{"methodId": m.ID}, nil)
		cancel()
		if err == nil {
			return nil
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		failures = append(failures, fmt.Sprintf("%s: %v", m.ID, err))
	}
	msg := fmt.Sprintf("the agent refused the session (%s)", refusal.Message)
	if len(tried) == 0 {
		msg += "; it offers only interactive login methods (" + methodNames(c.authMethods) + ")"
	} else {
		msg += "; authenticate failed (" + strings.Join(failures, "; ") + ")"
	}
	if hint = strings.TrimSpace(hint); hint != "" {
		msg += ". " + hint
	}
	return fmt.Errorf("%w: %s", ErrAuthRequired, msg)
}

func methodNames(ms []AuthMethod) string {
	names := make([]string, len(ms))
	for i, m := range ms {
		names[i] = m.ID
	}
	return strings.Join(names, ", ")
}
