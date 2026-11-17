package acp

import (
	"context"
	"encoding/json"
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
	caps        Capabilities

	onCommands func([]Command)

	mu         sync.Mutex
	active     *run
	cancelling atomic.Bool
}

type run struct {
	sessionID string
	h         Handler
	ctx       context.Context
	// permCtx bounds the answer to a permission request: it ends when the
	// prompt is cancelled, so a question still waiting for the user (an
	// approval card) is withdrawn and the reader is free to receive the agent's
	// "cancelled" answer, instead of the agent being killed after CancelGrace.
	permCtx context.Context
}

// ExitError is ErrClosed for an agent process that ended: its message names how
// the process exited and its stderr tail, StderrFirst is the first line it
// wrote there (already redacted), which is what an argument error looks like.
type ExitError struct {
	err         error
	StderrFirst string
}

func (e *ExitError) Error() string { return e.err.Error() }
func (e *ExitError) Unwrap() error { return e.err }

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
	c := &Client{proc: p, name: spec.Name, onCommands: spec.OnCommands}
	c.conn = newConn(p.stdout, p.stdin, c)
	c.conn.tr = p.trace
	go c.conn.serve(context.Background(), func(readErr error) error {
		msg := p.describeExit()
		if readErr != nil {
			return &ExitError{err: fmt.Errorf("%w: %v; %s", ErrClosed, readErr, msg), StderrFirst: p.stderr.first()}
		}
		return &ExitError{err: fmt.Errorf("%w: %s", ErrClosed, msg), StderrFirst: p.stderr.first()}
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
		ProtocolVersion: ProtocolVersion,
		ClientCapabilities: clientCapabilities{
			FS:      fsCapabilities{ReadTextFile: true, WriteTextFile: true},
			Session: &sessionCapabilities{Compaction: &struct{}{}},
		},
		ClientInfo: implementation{Name: ClientName, Version: ClientVersion},
	}, &res)
	if err != nil {
		return fmt.Errorf("acp initialize: %w", err)
	}
	c.authMethods = res.AuthMethods
	c.caps = Capabilities{
		LoadSession: res.AgentCapabilities.LoadSession,
		PromptImage: res.AgentCapabilities.PromptCapabilities.Image,
		MCPHTTP:     res.AgentCapabilities.MCPCapabilities.HTTP,
		MCPSSE:      res.AgentCapabilities.MCPCapabilities.SSE,
	}
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

// Capabilities reports what the agent advertised in initialize.
func (c *Client) Capabilities() Capabilities { return c.caps }

// Done is closed when the agent connection is gone (the process exited or
// closed its output).
func (c *Client) Done() <-chan struct{} { return c.conn.Done() }

// TracePath is the wire trace file of this agent process ("" when tracing is off).
func (c *Client) TracePath() string { return c.proc.trace.Path() }

// TraceHide makes the wire trace (when on) redact v, a value the harness
// handed to the agent after it started, such as an MCP bearer token.
func (c *Client) TraceHide(v string) { c.proc.trace.Hide(v) }

// PID is the agent process id.
func (c *Client) PID() int { return c.proc.pid() }

// Stderr returns the redacted trailing stderr lines captured from the agent process.
func (c *Client) Stderr() string { return c.proc.stderr.tail() }

// Close ends the agent: stdin EOF, a short grace, then kill of the process
// group. It returns once the process is reaped.
func (c *Client) Close() {
	c.proc.closeAndWait(exitGrace)
	c.conn.shutdown(ErrClosed)
	c.proc.trace.Close()
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
	sess, err := c.newSession(ctx, cwd, nil, opts.AuthHint, opts.Auth)
	if err != nil {
		return "", err
	}
	if err := c.selectModel(ctx, sess, opts); err != nil {
		return "", err
	}
	return c.Prompt(ctx, sess.SessionID, prompt, h)
}

// Session is a session opened by NewSession.
type Session struct {
	ID string
	// Modes are the session modes the agent advertised and Mode the one in use ("" when it advertised none).
	Modes []SessionMode
	Mode  string
}

// SessionMode is one mode an ACP agent offers (session/new's modes.availableModes).
type SessionMode struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
}

func parseModes(raw json.RawMessage) (modes []SessionMode, current string) {
	if len(raw) == 0 {
		return nil, ""
	}
	var m struct {
		Current   string        `json:"currentModeId"`
		Available []SessionMode `json:"availableModes"`
	}
	if json.Unmarshal(raw, &m) != nil {
		return nil, ""
	}
	return m.Available, m.Current
}

// SetMode switches the session to one of its advertised modes (session/set_mode).
func (c *Client) SetMode(ctx context.Context, sessionID, modeID string) error {
	err := c.conn.call(ctx, methodSetMode, map[string]string{"sessionId": sessionID, "modeId": modeID}, nil)
	if err != nil {
		return fmt.Errorf("acp session/set_mode: %w", err)
	}
	return nil
}

// NewSession opens a session at cwd with the given MCP servers (nil: none),
// authenticating once when the agent refuses and advertised auth methods. An
// agent that rejects the servers answers with a JSON-RPC error that unwraps to
// *RPCError. Use Prompt to talk to it.
func (c *Client) NewSession(ctx context.Context, cwd string, servers []MCPServer, opts RunOptions) (Session, error) {
	sess, err := c.newSession(ctx, cwd, servers, opts.AuthHint, opts.Auth)
	if err != nil {
		return Session{}, err
	}
	if err := c.selectModel(ctx, sess, opts); err != nil {
		return Session{}, err
	}
	modes, cur := parseModes(sess.Modes)
	return Session{ID: sess.SessionID, Modes: modes, Mode: cur}, nil
}

// LoadSession resumes a stored session (session/load); only call it when
// Capabilities().LoadSession is true. The agent replays the conversation as
// session/update notifications, which are dropped: nothing is running yet.
func (c *Client) LoadSession(ctx context.Context, sessionID, cwd string, servers []MCPServer) error {
	if servers == nil {
		servers = []MCPServer{}
	}
	err := c.conn.call(ctx, methodSessionLoad, loadSessionParams{SessionID: sessionID, Cwd: cwd, MCPServers: servers}, nil)
	if err != nil {
		return fmt.Errorf("acp session/load: %w", err)
	}
	return nil
}

// Prompt sends one text prompt on an open session and returns the stop
// reason. When ctx ends it sends session/cancel and waits up to CancelGrace for
// the agent to answer (the session stays usable); otherwise it kills the
// process and returns ctx.Err(). A Client runs one prompt at a time.
func (c *Client) Prompt(ctx context.Context, sessionID, prompt string, h Handler) (StopReason, error) {
	return c.PromptWith(ctx, sessionID, prompt, nil, h)
}

// Image is an image content block of a prompt: base64 data and its media type.
type Image struct {
	MimeType string
	Data     string
}

// PromptWith is Prompt with images: image content blocks come first, in order,
// then the text. Only send images to an agent whose Capabilities().PromptImage is true.
func (c *Client) PromptWith(ctx context.Context, sessionID, prompt string, images []Image, h Handler) (StopReason, error) {
	blocks := make([]contentBlock, 0, len(images)+1)
	for _, im := range images {
		blocks = append(blocks, contentBlock{Type: "image", Data: im.Data, MimeType: im.MimeType})
	}
	blocks = append(blocks, contentBlock{Type: "text", Text: prompt})
	sess := newSessionResult{SessionID: sessionID}
	runCtx, endRun := context.WithCancel(context.WithoutCancel(ctx))
	defer endRun()
	permCtx, stopPerms := context.WithCancel(runCtx)
	defer stopPerms()
	c.mu.Lock()
	c.active = &run{sessionID: sess.SessionID, h: h, ctx: runCtx, permCtx: permCtx}
	c.mu.Unlock()
	c.cancelling.Store(false)
	defer func() {
		c.mu.Lock()
		c.active = nil
		c.mu.Unlock()
	}()
	if ps, ok := h.(PromptStartHandler); ok {
		ps.PromptStarted(runCtx)
	}

	type outcome struct {
		res promptResult
		err error
	}
	done := make(chan outcome, 1)
	go func() {
		var res promptResult
		err := c.conn.call(runCtx, methodPrompt, promptParams{
			SessionID: sess.SessionID, Prompt: blocks,
		}, &res)
		done <- outcome{res, err}
	}()

	select {
	case o := <-done:
		reportPromptUsage(h, runCtx, o.res)
		return finish(o.res, o.err)
	case <-ctx.Done():
	}
	c.cancelling.Store(true)
	stopPerms()
	if err := c.conn.notifyPeer(methodCancel, cancelParams{SessionID: sess.SessionID}); err != nil {
		slog.Debug("acp: send cancel", "agent", c.name, "err", err)
	}
	select {
	case o := <-done:
		reportPromptUsage(h, runCtx, o.res)
		if stop, err := finish(o.res, o.err); err == nil {
			return stop, nil
		}
	case <-time.After(CancelGrace):
		slog.Warn("acp agent ignored session/cancel; killing", "agent", c.name)
		c.proc.kill()
	}
	return "", ctx.Err()
}

// reportPromptUsage hands the usage a prompt's response carried to a handler that wants it.
func reportPromptUsage(h Handler, ctx context.Context, res promptResult) {
	if u, ok := h.(PromptUsageHandler); ok && res.Usage != nil {
		u.PromptUsage(ctx, *res.Usage)
	}
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
