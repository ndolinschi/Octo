package acp

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	initTimeout = 60 * time.Second
	exitGrace   = time.Second
)

// CancelGrace is how long Run waits for the agent to answer a prompt after
// session/cancel before killing the process.
var CancelGrace = 3 * time.Second

// ClientName and ClientVersion identify this client in initialize.
var (
	ClientName    = "octo-harness"
	ClientVersion = "0.2.0"
)

// Client is one running agent process after a successful initialize.
type Client struct {
	proc *process
	conn *conn
	name string

	authMethods []AuthMethod

	mu         sync.Mutex
	active     *run
	cancelling atomic.Bool
}

type run struct {
	sessionID string
	h         Handler
	ctx       context.Context
}

// Start launches the agent and performs the initialize handshake. On error
// the process is already gone. ctx bounds the handshake only.
func Start(ctx context.Context, spec Spec) (*Client, error) {
	if spec.Name == "" {
		spec.Name = spec.Command
	}
	p, err := startProcess(spec)
	if err != nil {
		return nil, err
	}
	c := &Client{proc: p, name: spec.Name}
	c.conn = newConn(p.stdout, p.stdin, c)
	go c.conn.serve(context.Background(), func(readErr error) error {
		msg := p.describeExit()
		if readErr != nil {
			return fmt.Errorf("%w: %v; %s", ErrClosed, readErr, msg)
		}
		return fmt.Errorf("%w: %s", ErrClosed, msg)
	})
	if err := c.initialize(ctx); err != nil {
		c.Close()
		return nil, err
	}
	return c, nil
}

func (c *Client) initialize(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, initTimeout)
	defer cancel()
	var res initializeResult
	err := c.conn.call(ctx, methodInitialize, initializeParams{
		ProtocolVersion:    ProtocolVersion,
		ClientCapabilities: clientCapabilities{FS: fsCapabilities{ReadTextFile: true, WriteTextFile: true}},
		ClientInfo:         implementation{Name: ClientName, Version: ClientVersion},
	}, &res)
	if err != nil {
		return fmt.Errorf("acp initialize: %w", err)
	}
	c.authMethods = res.AuthMethods
	if res.ProtocolVersion != ProtocolVersion {
		return fmt.Errorf("acp initialize: agent speaks protocol version %d, this client supports %d",
			res.ProtocolVersion, ProtocolVersion)
	}
	return nil
}

// childHas reports whether the agent's environment sets name to a non-empty value.
func (c *Client) childHas(name string) bool {
	env := c.proc.cmd.Env
	for i := len(env) - 1; i >= 0; i-- {
		if k, v, ok := strings.Cut(env[i], "="); ok && k == name {
			return v != ""
		}
	}
	return false
}

// PID is the agent process id.
func (c *Client) PID() int { return c.proc.pid() }

// Close ends the agent: stdin EOF, a short grace, then kill of the process
// group. It returns once the process is reaped.
func (c *Client) Close() {
	c.proc.closeAndWait(exitGrace)
	c.conn.shutdown(ErrClosed)
}

// Run opens a session at cwd, sends one text prompt and returns the stop
// reason. When ctx ends it sends session/cancel and waits up to CancelGrace
// for the agent to answer; otherwise it kills the process and returns
// ctx.Err(). A Client runs one prompt at a time.
func (c *Client) Run(ctx context.Context, cwd, prompt string, h Handler) (StopReason, error) {
	return c.RunWith(ctx, cwd, prompt, h, RunOptions{})
}

// RunWith is Run with a model choice and a login hint; see RunOptions. When
// the agent refuses the session and advertised auth methods, it logs in with
// the first one that needs no interaction.
func (c *Client) RunWith(ctx context.Context, cwd, prompt string, h Handler, opts RunOptions) (StopReason, error) {
	sess, err := c.newSession(ctx, cwd, opts.AuthHint, opts.Auth)
	if err != nil {
		return "", err
	}
	if err := c.selectModel(ctx, sess, opts); err != nil {
		return "", err
	}
	runCtx, endRun := context.WithCancel(context.WithoutCancel(ctx))
	defer endRun()
	c.mu.Lock()
	c.active = &run{sessionID: sess.SessionID, h: h, ctx: runCtx}
	c.mu.Unlock()
	c.cancelling.Store(false)
	defer func() {
		c.mu.Lock()
		c.active = nil
		c.mu.Unlock()
	}()

	type outcome struct {
		res promptResult
		err error
	}
	done := make(chan outcome, 1)
	go func() {
		var res promptResult
		err := c.conn.call(runCtx, methodPrompt, promptParams{
			SessionID: sess.SessionID, Prompt: []contentBlock{{Type: "text", Text: prompt}},
		}, &res)
		done <- outcome{res, err}
	}()

	select {
	case o := <-done:
		return finish(o.res, o.err)
	case <-ctx.Done():
	}
	c.cancelling.Store(true)
	if err := c.conn.notifyPeer(methodCancel, cancelParams{SessionID: sess.SessionID}); err != nil {
		slog.Debug("acp: send cancel", "agent", c.name, "err", err)
	}
	select {
	case o := <-done:
		if stop, err := finish(o.res, o.err); err == nil {
			return stop, nil
		}
	case <-time.After(CancelGrace):
		slog.Warn("acp agent ignored session/cancel; killing", "agent", c.name)
		c.proc.kill()
	}
	return "", ctx.Err()
}

func finish(res promptResult, err error) (StopReason, error) {
	if err != nil {
		var rpcErr *RPCError
		if errors.As(err, &rpcErr) {
			return "", fmt.Errorf("acp session/prompt: %w", err)
		}
		return "", fmt.Errorf("acp: %w", err)
	}
	if res.StopReason == "" {
		return "", errors.New("acp session/prompt: response has no stopReason")
	}
	return res.StopReason, nil
}
