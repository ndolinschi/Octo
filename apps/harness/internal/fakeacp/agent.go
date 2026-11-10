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
	a := &agent{in: os.Stdin, out: os.Stdout, log: os.Stderr, exit: os.Exit, pending: map[int64]chan reply{}}
	if err := a.serve(ctx); err != nil {
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
	switch m.Method {
	case "initialize":
		version := 1
		if v, err := strconv.Atoi(os.Getenv(EnvProtocolVersion)); err == nil {
			version = v
		}
		a.respond(m.ID, map[string]any{
			"protocolVersion":   version,
			"agentCapabilities": map[string]any{},
			"agentInfo":         map[string]string{"name": "fake-acp", "version": "0.1.0"},
			"authMethods":       []any{},
		})
	case "session/new":
		var p struct{ Cwd string }
		if err := json.Unmarshal(m.Params, &p); err != nil || p.Cwd == "" {
			a.respondError(m.ID, -32602, "cwd required")
			return
		}
		a.mu.Lock()
		a.cwd = p.Cwd
		a.mu.Unlock()
		a.respond(m.ID, map[string]string{"sessionId": "fake-session-1"})
	case "session/prompt":
		var p struct {
			Prompt []struct{ Text string }
		}
		if err := json.Unmarshal(m.Params, &p); err != nil || len(p.Prompt) == 0 {
			a.respondError(m.ID, -32602, "prompt required")
			return
		}
		text := ""
		for _, b := range p.Prompt {
			text += b.Text
		}
		pctx, cancel := context.WithCancel(ctx)
		a.mu.Lock()
		a.cancel = cancel
		a.mu.Unlock()
		go func() {
			defer cancel()
			stop := a.runScript(pctx, text)
			a.respond(m.ID, map[string]string{"stopReason": stop})
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
