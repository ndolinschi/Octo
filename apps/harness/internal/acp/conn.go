package acp

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"strconv"
	"sync"
	"time"
)

// maxLine bounds one JSON-RPC message; agents can send whole files.
const maxLine = 16 << 20

var (
	// ErrClosed is returned by calls on a connection whose peer is gone.
	ErrClosed = errors.New("acp: connection closed")
	errTooBig = errors.New("acp: message exceeds 16 MiB line limit")
)

// incoming receives the peer's requests and notifications in arrival order,
// one at a time, on the reader goroutine.
type incoming interface {
	notify(ctx context.Context, method string, params json.RawMessage)
	request(ctx context.Context, method string, params json.RawMessage) (any, *RPCError)
}

type wireMessage struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *RPCError       `json:"error,omitempty"`
}

type response struct {
	result json.RawMessage
	err    *RPCError
}

type conn struct {
	r    io.Reader
	w    io.Writer
	wmu  sync.Mutex
	in   incoming
	done chan struct{}

	mu      sync.Mutex
	nextID  int64
	pending map[int64]chan response
	err     error
}

func newConn(r io.Reader, w io.Writer, in incoming) *conn {
	return &conn{r: r, w: w, in: in, done: make(chan struct{}), pending: make(map[int64]chan response)}
}

// serve reads until the stream ends, then closes the connection with the
// error endErr derives from the read error (nil read error = clean EOF).
func (c *conn) serve(ctx context.Context, endErr func(readErr error) error) {
	err := c.readLoop(ctx)
	if endErr != nil {
		err = endErr(err)
	} else if err == nil {
		err = ErrClosed
	}
	c.shutdown(err)
}

func (c *conn) readLoop(ctx context.Context) error {
	sc := bufio.NewScanner(c.r)
	sc.Buffer(make([]byte, 0, 64<<10), maxLine)
	for sc.Scan() {
		line := sc.Bytes()
		if len(line) == 0 {
			continue
		}
		var m wireMessage
		if err := json.Unmarshal(line, &m); err != nil {
			slog.Debug("acp: skipping non-JSON line", "bytes", len(line), "err", err)
			continue
		}
		c.dispatch(ctx, m)
	}
	if err := sc.Err(); err != nil {
		if errors.Is(err, bufio.ErrTooLong) {
			return errTooBig
		}
		return err
	}
	return nil
}

func (c *conn) dispatch(ctx context.Context, m wireMessage) {
	switch {
	case m.Method != "" && len(m.ID) > 0:
		result, rpcErr := c.in.request(ctx, m.Method, m.Params)
		if err := c.reply(m.ID, result, rpcErr); err != nil {
			slog.Debug("acp: reply failed", "method", m.Method, "err", err)
		}
	case m.Method != "":
		c.in.notify(ctx, m.Method, m.Params)
	default:
		id, err := strconv.ParseInt(string(m.ID), 10, 64)
		if err != nil {
			slog.Debug("acp: response with unusable id", "id", string(m.ID))
			return
		}
		c.mu.Lock()
		ch := c.pending[id]
		delete(c.pending, id)
		c.mu.Unlock()
		if ch != nil {
			ch <- response{result: m.Result, err: m.Error}
		}
	}
}

func (c *conn) shutdown(err error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.err != nil {
		return
	}
	c.err = err
	c.pending = make(map[int64]chan response)
	close(c.done)
}

// Done is closed when the peer is gone; Err then says why.
func (c *conn) Done() <-chan struct{} { return c.done }

func (c *conn) Err() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.err
}

// call sends a request and waits for its response, ctx, or connection loss.
func (c *conn) call(ctx context.Context, method string, params, result any) error {
	c.mu.Lock()
	if c.err != nil {
		defer c.mu.Unlock()
		return c.err
	}
	c.nextID++
	id := c.nextID
	ch := make(chan response, 1)
	c.pending[id] = ch
	c.mu.Unlock()

	idRaw := json.RawMessage(strconv.FormatInt(id, 10))
	raw, err := json.Marshal(params)
	if err == nil {
		err = c.write(wireMessage{JSONRPC: "2.0", ID: idRaw, Method: method, Params: raw})
	}
	if err != nil {
		c.forget(id)
		return c.explainWriteFailure(ctx, err)
	}
	select {
	case resp := <-ch:
		if resp.err != nil {
			return resp.err
		}
		if result == nil || len(resp.result) == 0 {
			return nil
		}
		if err := json.Unmarshal(resp.result, result); err != nil {
			return fmt.Errorf("acp: decode %s result: %w", method, err)
		}
		return nil
	case <-ctx.Done():
		c.forget(id)
		return ctx.Err()
	case <-c.done:
		return c.Err()
	}
}

// writeFailGrace bounds how long a failed write waits for the read side to
// report why the peer is gone.
const writeFailGrace = 3 * time.Second

// explainWriteFailure prefers the connection's own end-of-stream error (which
// names how the agent exited and its stderr tail) over a bare "broken pipe" or
// "file already closed": a peer that exits makes the write fail and the read
// reach EOF at about the same time, and which is seen first is a race. It waits
// for the read side, not for a fixed time; the grace only bounds a peer that
// closed its input but is still running.
func (c *conn) explainWriteFailure(ctx context.Context, writeErr error) error {
	t := time.NewTimer(writeFailGrace)
	defer t.Stop()
	select {
	case <-c.done:
		return c.Err()
	case <-ctx.Done():
	case <-t.C:
	}
	return writeErr
}

func (c *conn) forget(id int64) {
	c.mu.Lock()
	delete(c.pending, id)
	c.mu.Unlock()
}

func (c *conn) notifyPeer(method string, params any) error {
	raw, err := json.Marshal(params)
	if err != nil {
		return err
	}
	return c.write(wireMessage{JSONRPC: "2.0", Method: method, Params: raw})
}

func (c *conn) reply(id json.RawMessage, result any, rpcErr *RPCError) error {
	m := wireMessage{JSONRPC: "2.0", ID: id}
	if rpcErr != nil {
		m.Error = rpcErr
	} else {
		if result == nil {
			result = struct{}{}
		}
		raw, err := json.Marshal(result)
		if err != nil {
			m.Error = &RPCError{Code: codeInternal, Message: "encode result: " + err.Error()}
		} else {
			m.Result = raw
		}
	}
	return c.write(m)
}

func (c *conn) write(m wireMessage) error {
	line, err := json.Marshal(m)
	if err != nil {
		return err
	}
	line = append(line, '\n')
	c.wmu.Lock()
	defer c.wmu.Unlock()
	if _, err := c.w.Write(line); err != nil {
		return fmt.Errorf("%w: %v", ErrClosed, err)
	}
	return nil
}
