package acp

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"sync"
	"testing"
	"time"
)

type recorder struct {
	mu       sync.Mutex
	notified []string
	reqs     []string
}

func (r *recorder) notify(_ context.Context, method string, params json.RawMessage) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.notified = append(r.notified, method+":"+string(params))
}

func (r *recorder) request(_ context.Context, method string, _ json.RawMessage) (any, *RPCError) {
	r.mu.Lock()
	r.reqs = append(r.reqs, method)
	r.mu.Unlock()
	if method == "boom" {
		return nil, &RPCError{Code: -32000, Message: "nope"}
	}
	return map[string]string{"echo": method}, nil
}

// peer is the far end of a conn: it reads what the conn writes and writes raw lines.
type peer struct {
	fromConn *io.PipeReader
	toConn   *io.PipeWriter
	c        *conn
	rec      *recorder
}

func newPeer(t *testing.T) *peer {
	t.Helper()
	cr, pw := io.Pipe() // peer -> conn
	pr, cw := io.Pipe() // conn -> peer
	rec := &recorder{}
	c := newConn(cr, cw, rec)
	go c.serve(context.Background(), nil)
	t.Cleanup(func() { _ = pw.Close(); _ = pr.Close() })
	return &peer{fromConn: pr, toConn: pw, c: c, rec: rec}
}

func (p *peer) readLine(t *testing.T) map[string]any {
	t.Helper()
	var buf []byte
	one := make([]byte, 1)
	for {
		if _, err := p.fromConn.Read(one); err != nil {
			t.Fatalf("peer read: %v", err)
		}
		if one[0] == '\n' {
			break
		}
		buf = append(buf, one[0])
	}
	var m map[string]any
	if err := json.Unmarshal(buf, &m); err != nil {
		t.Fatalf("peer got %q: %v", buf, err)
	}
	return m
}

func (p *peer) send(t *testing.T, line string) {
	t.Helper()
	if _, err := io.WriteString(p.toConn, line+"\n"); err != nil {
		t.Fatalf("peer write: %v", err)
	}
}

func TestConnInterleavedNotificationsRequestsAndResponses(t *testing.T) {
	p := newPeer(t)
	got := make(chan error, 1)
	var result struct{ Value string }
	go func() { got <- p.c.call(context.Background(), "ping", map[string]int{"n": 1}, &result) }()

	req := p.readLine(t)
	if req["method"] != "ping" || req["jsonrpc"] != "2.0" {
		t.Fatalf("request = %v", req)
	}
	id := req["id"]
	// notification, agent request, then the response, all before the call returns
	p.send(t, `{"jsonrpc":"2.0","method":"session/update","params":{"n":1}}`)
	p.send(t, `{"jsonrpc":"2.0","id":"abc","method":"fs/echo","params":{}}`)
	reply := p.readLine(t)
	if reply["id"] != "abc" || reply["result"] == nil {
		t.Fatalf("reply to agent request = %v", reply)
	}
	p.send(t, `{"jsonrpc":"2.0","id":99,"method":"boom"}`)
	if e := p.readLine(t); e["error"] == nil {
		t.Fatalf("want error reply, got %v", e)
	}
	idJSON, err := json.Marshal(id)
	if err != nil {
		t.Fatal(err)
	}
	p.send(t, `{"jsonrpc":"2.0","id":`+string(idJSON)+`,"result":{"Value":"pong"}}`)
	if err := <-got; err != nil || result.Value != "pong" {
		t.Fatalf("call = %v, %+v", err, result)
	}
	if len(p.rec.notified) != 1 || len(p.rec.reqs) != 2 {
		t.Fatalf("recorder = %+v", p.rec)
	}
}

func TestConnLargeLines(t *testing.T) {
	p := newPeer(t)
	big := strings.Repeat("x", 5<<20)
	got := make(chan error, 1)
	var res struct{ Value string }
	go func() { got <- p.c.call(context.Background(), "big", nil, &res) }()
	req := p.readLine(t)
	idJSON, _ := json.Marshal(req["id"])
	go func() {
		line := `{"jsonrpc":"2.0","id":` + string(idJSON) + `,"result":{"Value":"` + big + `"}}` + "\n"
		if _, err := io.WriteString(p.toConn, line); err != nil {
			t.Errorf("write: %v", err)
		}
	}()
	if err := <-got; err != nil || len(res.Value) != len(big) {
		t.Fatalf("call = %v, len %d", err, len(res.Value))
	}
}

func TestConnOversizedLineClosesWithError(t *testing.T) {
	p := newPeer(t)
	got := make(chan error, 1)
	go func() { got <- p.c.call(context.Background(), "x", nil, nil) }()
	p.readLine(t)
	go func() {
		if _, err := io.WriteString(p.toConn, strings.Repeat("y", maxLine+10)+"\n"); err != nil && !errors.Is(err, io.ErrClosedPipe) {
			t.Errorf("write: %v", err)
		}
	}()
	err := <-got
	if !errors.Is(err, errTooBig) {
		t.Fatalf("err = %v, want errTooBig", err)
	}
}

func TestConnPeerExitFailsPendingCalls(t *testing.T) {
	p := newPeer(t)
	errs := make(chan error, 2)
	for range 2 {
		go func() { errs <- p.c.call(context.Background(), "hang", nil, nil) }()
	}
	p.readLine(t)
	p.readLine(t)
	if err := p.toConn.Close(); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		select {
		case err := <-errs:
			if !errors.Is(err, ErrClosed) {
				t.Fatalf("err = %v, want ErrClosed", err)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("pending call not released after peer exit")
		}
	}
	if err := p.c.call(context.Background(), "late", nil, nil); !errors.Is(err, ErrClosed) {
		t.Fatalf("call after close = %v", err)
	}
	p.c.mu.Lock()
	n := len(p.c.pending)
	p.c.mu.Unlock()
	if n != 0 {
		t.Fatalf("%d pending calls leaked", n)
	}
}

func TestConnCallContextCancelForgetsPending(t *testing.T) {
	p := newPeer(t)
	ctx, cancel := context.WithCancel(context.Background())
	got := make(chan error, 1)
	go func() { got <- p.c.call(ctx, "slow", nil, nil) }()
	p.readLine(t)
	cancel()
	if err := <-got; !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v", err)
	}
	p.c.mu.Lock()
	n := len(p.c.pending)
	p.c.mu.Unlock()
	if n != 0 {
		t.Fatalf("%d pending calls leaked", n)
	}
}

func TestConnSkipsGarbageLines(t *testing.T) {
	p := newPeer(t)
	p.send(t, `not json at all`)
	p.send(t, ``)
	p.send(t, `{"jsonrpc":"2.0","method":"session/update","params":{}}`)
	deadline := time.After(5 * time.Second)
	for {
		p.rec.mu.Lock()
		n := len(p.rec.notified)
		p.rec.mu.Unlock()
		if n == 1 {
			return
		}
		select {
		case <-deadline:
			t.Fatal("notification after garbage never arrived")
		case <-time.After(5 * time.Millisecond):
		}
	}
}

// A CLI that prints a banner, an update notice or escape codes on stdout before
// its first message (agy and its auto-updater are the reason) still gets
// through: lines without a message are skipped, a prefix before `{"jsonrpc"`
// on the same line is dropped.
func TestConnToleratesBannerAndPrefixedMessages(t *testing.T) {
	p := newPeer(t)
	p.send(t, `Antigravity CLI 1.5.9 — a new version is available, run the installer to update`)
	p.send(t, "\x1b[2K\x1b[1G{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{\"n\":1}}")
	p.send(t, `{"level":"info","msg":"not a message"}`)
	p.send(t, `[agy] ready {"jsonrpc":"2.0","method":"session/update","params":{"n":2}}`)
	deadline := time.After(5 * time.Second)
	for {
		p.rec.mu.Lock()
		n := len(p.rec.notified)
		p.rec.mu.Unlock()
		if n == 2 {
			return
		}
		select {
		case <-deadline:
			t.Fatalf("got %d notifications, want 2", n)
		case <-time.After(5 * time.Millisecond):
		}
	}
}

func TestParseWire(t *testing.T) {
	for _, c := range []struct {
		line string
		ok   bool
	}{
		{`{"jsonrpc":"2.0","id":1,"result":{}}`, true},
		{"\x1b[0m{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}", true},
		{`Updating agy... {"jsonrpc":"2.0","method":"x"}`, true},
		{`Updating agy...`, false},
		{`prefix {"jsonrpc": broken`, false},
	} {
		if _, ok := parseWire([]byte(c.line)); ok != c.ok {
			t.Errorf("parseWire(%q) ok = %v, want %v", c.line, ok, c.ok)
		}
	}
}
