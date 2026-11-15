// Package fakeacp is a scripted, deterministic Agent Client Protocol agent
// for tests and demos. It speaks the agent side of the protocol over stdio.
package fakeacp

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
)

// EnvChild marks a test binary re-executed as the fake agent.
const EnvChild = "OCTO_FAKEACP_CHILD"

// EnvProtocolVersion overrides the protocol version the agent answers initialize with.
const EnvProtocolVersion = "OCTO_FAKEACP_PROTOCOL"

// ChildMode reports whether this process was started as the fake agent.
func ChildMode() bool { return os.Getenv(EnvChild) == "1" }

// Main runs the agent on stdin/stdout and returns the process exit code.
func Main() int {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if os.Getenv(EnvProfile) == ProfileAgy {
		if code, done := agyCLI(os.Args[1:]); done {
			return code
		}
	}
	opts := optionsFromEnv(os.Args[1:])
	a := &agent{in: os.Stdin, out: os.Stdout, log: os.Stderr, exit: os.Exit, pending: map[int64]chan reply{},
		opts: opts, model: opts.initialModel()}
	err := a.serve(ctx)
	a.closeMCP()
	if err != nil {
		fmt.Fprintln(os.Stderr, "fakeacp:", err)
		return 1
	}
	return 0
}

type message struct {
	ID     json.RawMessage `json:"id,omitempty"`
	Method string          `json:"method,omitempty"`
	Params json.RawMessage `json:"params,omitempty"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *rpcError       `json:"error,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type reply struct {
	result json.RawMessage
	err    *rpcError
}

type agent struct {
	in   io.Reader
	out  io.Writer
	log  io.Writer
	exit func(int)

	wmu sync.Mutex

	mu       sync.Mutex
	nextID   int64
	pending  map[int64]chan reply
	cwd      string
	cancel   context.CancelFunc
	deafMode bool
	cumN     int
	opts     options
	authed   bool
	model    string
	mode     string // current session mode (EnvModes)
	commands []map[string]any
	blocks   string // the content blocks of the last prompt (type, or image:mime:len)

	sess    string // current session id ("" until session/new or session/load)
	nSess   int
	loaded  bool
	mcpSrvs []mcpEntry
	mcpc    *mcpClient
	// mcpInstr is the "instructions" of the harness MCP server's initialize result.
	mcpInstr string
}

// sid is the current session id.
func (a *agent) sid() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.sess == "" {
		return defaultSessionID
	}
	return a.sess
}

func (a *agent) serve(ctx context.Context) error {
	sc := bufio.NewScanner(a.in)
	sc.Buffer(make([]byte, 0, 64<<10), 16<<20)
	for sc.Scan() {
		if ctx.Err() != nil {
			return nil
		}
		var m message
		if err := json.Unmarshal(sc.Bytes(), &m); err != nil {
			fmt.Fprintln(a.log, "bad line:", err)
			continue
		}
		switch {
		case m.Method != "" && len(m.ID) > 0:
			a.handleRequest(ctx, m)
		case m.Method != "":
			if m.Method == "session/cancel" {
				a.cancelPrompt()
			}
		default:
			a.deliver(m)
		}
	}
	a.cancelPrompt()
	return sc.Err()
}

func (a *agent) handleRequest(ctx context.Context, m message) {
	a.logRequest(m)
	switch m.Method {
	case "initialize":
		version := 1
		if v, err := strconv.Atoi(os.Getenv(EnvProtocolVersion)); err == nil {
			version = v
		}
		caps := map[string]any{}
		if a.opts.loadSession {
			caps["loadSession"] = true
		}
		if pc := a.opts.promptCaps(); len(pc) > 0 {
			caps["promptCapabilities"] = pc
		}
		if a.opts.mcpHTTP {
			caps["mcpCapabilities"] = map[string]any{"http": true, "sse": false}
		}
		if a.opts.any() {
			caps["futureCapability"] = map[string]any{"enabled": true}
			if err := a.notify("x/hello", map[string]string{"from": "fake-acp"}); err != nil {
				fmt.Fprintln(a.log, "hello:", err)
			}
		}
		a.respond(m.ID, map[string]any{
			"protocolVersion":   version,
			"agentCapabilities": caps,
			"agentInfo":         map[string]string{"name": "fake-acp", "version": "0.1.0"},
			"authMethods":       a.opts.authMethods(),
		})
	case "authenticate":
		a.handleAuthenticate(m)
	case "session/set_model", "session/set_config_option":
		a.handleSetModel(m)
	case "session/set_mode":
		var p struct {
			ModeID string `json:"modeId"`
		}
		if len(a.opts.modes()) == 0 {
			a.respondError(m.ID, -32601, "method not found: session/set_mode")
			return
		}
		if err := json.Unmarshal(m.Params, &p); err != nil || !a.opts.knownMode(p.ModeID) {
			a.respondError(m.ID, -32602, "unknown mode")
			return
		}
		a.mu.Lock()
		a.mode = p.ModeID
		a.mu.Unlock()
		a.respond(m.ID, map[string]any{})
	case "session/new":
		var p struct {
			Cwd        string
			McpServers []mcpEntry
		}
		if err := json.Unmarshal(m.Params, &p); err != nil || p.Cwd == "" {
			a.respondError(m.ID, -32602, "cwd required")
			return
		}
		a.mu.Lock()
		a.cwd = p.Cwd
		authed := a.authed || a.opts.savedLogin
		a.mu.Unlock()
		if a.opts.auth != "" && !authed {
			a.respondError(m.ID, -32000, "Authentication required")
			return
		}
		if a.opts.mcpReject && len(p.McpServers) > 0 {
			a.respondError(m.ID, -32602, "MCP servers are not supported by this agent")
			return
		}
		if msg := a.checkMCPServers(p.McpServers); msg != "" {
			a.respondError(m.ID, -32602, msg)
			return
		}
		a.mu.Lock()
		a.nSess++
		a.sess = defaultSessionID
		if a.opts.unique {
			a.sess = fmt.Sprintf("fake-%d-%d", os.Getpid(), a.nSess)
		}
		a.loaded = false
		a.mode = a.opts.firstMode()
		a.mcpSrvs = p.McpServers
		a.mu.Unlock()
		a.closeMCP()
		a.respond(m.ID, a.sessionResult())
		a.advertiseCommands(true)
	case "session/load":
		var p struct {
			SessionID  string
			Cwd        string
			McpServers []mcpEntry
		}
		if !a.opts.loadSession {
			a.respondError(m.ID, -32601, "method not found: session/load")
			return
		}
		if err := json.Unmarshal(m.Params, &p); err != nil || p.Cwd == "" || p.SessionID == "" {
			a.respondError(m.ID, -32602, "sessionId and cwd required")
			return
		}
		if a.opts.loadFail {
			a.respondError(m.ID, -32002, "session not found: "+p.SessionID)
			return
		}
		if a.opts.mcpReject && len(p.McpServers) > 0 {
			a.respondError(m.ID, -32602, "MCP servers are not supported by this agent")
			return
		}
		if msg := a.checkMCPServers(p.McpServers); msg != "" {
			a.respondError(m.ID, -32602, msg)
			return
		}
		a.mu.Lock()
		a.cwd, a.sess, a.loaded, a.mcpSrvs = p.Cwd, p.SessionID, true, p.McpServers
		a.mu.Unlock()
		a.closeMCP()
		// A real agent replays the whole conversation here; the client must drop it.
		a.update(map[string]any{"sessionUpdate": "user_message_chunk", "content": textBlock("replayed user message")})
		a.update(map[string]any{"sessionUpdate": "agent_message_chunk", "content": textBlock("replayed agent message")})
		a.respond(m.ID, map[string]any{})
		a.advertiseCommands(true)
	case "session/prompt":
		var p struct {
			Prompt []struct {
				Type     string
				Text     string
				Data     string
				MimeType string
			}
		}
		if err := json.Unmarshal(m.Params, &p); err != nil || len(p.Prompt) == 0 {
			a.respondError(m.ID, -32602, "prompt required")
			return
		}
		text := ""
		var kinds []string
		for _, b := range p.Prompt {
			text += b.Text
			if b.Type == "image" {
				kinds = append(kinds, fmt.Sprintf("image:%s:%d", b.MimeType, len(b.Data)))
			} else {
				kinds = append(kinds, b.Type)
			}
		}
		a.mu.Lock()
		a.blocks = strings.Join(kinds, ",")
		a.mu.Unlock()
		pctx, cancel := context.WithCancel(ctx)
		a.mu.Lock()
		a.cancel = cancel
		a.mu.Unlock()
		go func() {
			defer cancel()
			stop := a.runScript(pctx, text)
			if stop == stopAuthRequired {
				// What a CLI that is not logged in answers to session/prompt.
				a.respondError(m.ID, -32000, "Authentication required")
				return
			}
			res := map[string]any{"stopReason": stop}
			if n, err := strconv.ParseInt(a.opts.promptUsage, 10, 64); err == nil {
				res["usage"] = map[string]int64{"inputTokens": 100, "outputTokens": n, "thoughtTokens": 0, "totalTokens": 100 + n}
			}
			a.respond(m.ID, res)
		}()
	default:
		a.respondError(m.ID, -32601, "method not found: "+m.Method)
	}
}

func (a *agent) cancelPrompt() {
	a.mu.Lock()
	cancel := a.cancel
	a.mu.Unlock()
	if cancel != nil && !a.deaf() {
		cancel()
	}
}

func (a *agent) deliver(m message) {
	id, err := strconv.ParseInt(string(m.ID), 10, 64)
	if err != nil {
		return
	}
	a.mu.Lock()
	ch := a.pending[id]
	delete(a.pending, id)
	a.mu.Unlock()
	if ch != nil {
		ch <- reply{result: m.Result, err: m.Error}
	}
}

// call sends a request to the client and waits for its answer.
func (a *agent) call(ctx context.Context, method string, params any) (json.RawMessage, *rpcError, error) {
	a.mu.Lock()
	a.nextID++
	id := a.nextID
	ch := make(chan reply, 1)
	a.pending[id] = ch
	a.mu.Unlock()
	raw, err := json.Marshal(params)
	if err != nil {
		return nil, nil, err
	}
	if err := a.send(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": json.RawMessage(raw)}); err != nil {
		return nil, nil, err
	}
	select {
	case r := <-ch:
		return r.result, r.err, nil
	case <-ctx.Done():
		return nil, nil, ctx.Err()
	}
}

func (a *agent) notify(method string, params any) error {
	return a.send(map[string]any{"jsonrpc": "2.0", "method": method, "params": params})
}

func (a *agent) respond(id json.RawMessage, result any) {
	if err := a.send(map[string]any{"jsonrpc": "2.0", "id": id, "result": result}); err != nil {
		fmt.Fprintln(a.log, "respond:", err)
	}
}

func (a *agent) respondError(id json.RawMessage, code int, msg string) {
	if err := a.send(map[string]any{"jsonrpc": "2.0", "id": id, "error": rpcError{Code: code, Message: msg}}); err != nil {
		fmt.Fprintln(a.log, "respond:", err)
	}
}

func (a *agent) send(v any) error {
	line, err := json.Marshal(v)
	if err != nil {
		return err
	}
	a.wmu.Lock()
	defer a.wmu.Unlock()
	_, err = a.out.Write(append(line, '\n'))
	return err
}
