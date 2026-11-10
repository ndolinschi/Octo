package lsp_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/fakelsp"
	"github.com/ndolinschi/Octo/apps/harness/internal/lsp"
)

func TestMain(m *testing.M) {
	if fakelsp.ChildMode() {
		os.Exit(fakelsp.Main())
	}
	os.Exit(m.Run())
}

func fakeSpec(t *testing.T) lsp.Spec {
	t.Helper()
	return lsp.Spec{
		Name: "fake", Command: os.Args[0], Dir: t.TempDir(),
		Env: map[string]string{fakelsp.EnvChild: "1", "GORACE": "atexit_sleep_ms=0"},
	}
}

func newManager(t *testing.T, opts lsp.Options) *lsp.Manager {
	t.Helper()
	m := lsp.NewManager(opts)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := m.Shutdown(ctx); err != nil {
			t.Errorf("shutdown: %v", err)
		}
	})
	return m
}

func start(t *testing.T, m *lsp.Manager, project string) *lsp.Session {
	t.Helper()
	s, err := m.Start(context.Background(), project, fakeSpec(t))
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func send(t *testing.T, s *lsp.Session, msg string) {
	t.Helper()
	if err := s.Send(context.Background(), []byte(msg)); err != nil {
		t.Fatalf("send %s: %v", msg, err)
	}
}

type rpc struct {
	ID     json.RawMessage `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
	Result json.RawMessage `json:"result"`
}

func recv(t *testing.T, ch <-chan []byte) rpc {
	t.Helper()
	select {
	case raw, ok := <-ch:
		if !ok {
			t.Fatal("event channel closed")
		}
		var m rpc
		if err := json.Unmarshal(raw, &m); err != nil {
			t.Fatalf("bad event %q: %v", raw, err)
		}
		return m
	case <-time.After(10 * time.Second):
		t.Fatal("timed out waiting for event")
	}
	return rpc{}
}

func waitClosed(t *testing.T, ch <-chan []byte) {
	t.Helper()
	timeout := time.After(10 * time.Second)
	for {
		select {
		case _, ok := <-ch:
			if !ok {
				return
			}
		case <-timeout:
			t.Fatal("channel not closed")
		}
	}
}

func exitInfo(t *testing.T, s *lsp.Session) lsp.ExitInfo {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	info, err := s.Exit(ctx)
	if err != nil {
		t.Fatal(err)
	}
	return info
}

func pidGone(pid int) bool {
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return syscall.Kill(pid, 0) == syscall.ESRCH
	}
	i := strings.LastIndexByte(string(data), ')')
	return i >= 0 && i+2 < len(data) && data[i+2] == 'Z'
}

func waitPidGone(t *testing.T, pid int) {
	t.Helper()
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
		if pidGone(pid) {
			return
		}
	}
	t.Fatalf("process %d still alive", pid)
}

func TestSessionRelay(t *testing.T) {
	m := newManager(t, lsp.Options{})
	s := start(t, m, "p1")
	ch, release, err := s.Subscribe()
	if err != nil {
		t.Fatal(err)
	}
	defer release()

	send(t, s, `{"jsonrpc":"2.0","id":7,"method":"initialize","params":{}}`)
	if r := recv(t, ch); string(r.ID) != "7" || !strings.Contains(string(r.Result), "capabilities") {
		t.Fatalf("initialize reply = %+v", r)
	}
	send(t, s, `{"jsonrpc":"2.0","method":"initialized","params":{}}`)
	if r := recv(t, ch); r.Method != "fake/echo" {
		t.Fatalf("echo = %+v", r)
	}
	send(t, s, `{"jsonrpc":"2.0","method":"textDocument/didOpen","params":{"textDocument":{"uri":"file:///x.go"}}}`)
	recv(t, ch)
	r := recv(t, ch)
	if r.Method != "textDocument/publishDiagnostics" || !strings.Contains(string(r.Params), "file:///x.go") {
		t.Fatalf("diagnostics = %+v", r)
	}
	send(t, s, `{"jsonrpc":"2.0","method":"fake/stderr"}`)
	send(t, s, `{"jsonrpc":"2.0","method":"exit"}`)
	waitClosed(t, ch)
	if info := exitInfo(t, s); info.Code != 0 || info.Reason != "" {
		t.Fatalf("exit = %+v", info)
	}
}

func TestMessagesBufferedBeforeSubscribe(t *testing.T) {
	m := newManager(t, lsp.Options{})
	s := start(t, m, "p1")
	send(t, s, `{"jsonrpc":"2.0","method":"a"}`)
	send(t, s, `{"jsonrpc":"2.0","method":"b"}`)
	time.Sleep(100 * time.Millisecond)
	ch, release, err := s.Subscribe()
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	for _, want := range []string{"a", "b"} {
		r := recv(t, ch)
		if r.Method != "fake/echo" || !strings.Contains(string(r.Params), `"`+want+`"`) {
			t.Fatalf("want echo of %s, got %+v", want, r)
		}
	}
}

func TestSingleSubscriber(t *testing.T) {
	m := newManager(t, lsp.Options{})
	s := start(t, m, "p1")
	_, release, err := s.Subscribe()
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.Subscribe(); !errors.Is(err, lsp.ErrSubscribed) {
		t.Fatalf("second subscribe err = %v", err)
	}
	release()
	release()
	if _, release2, err := s.Subscribe(); err != nil {
		t.Fatalf("resubscribe: %v", err)
	} else {
		release2()
	}
}

func TestSendValidation(t *testing.T) {
	m := newManager(t, lsp.Options{})
	s := start(t, m, "p1")
	tests := []struct {
		name string
		msg  []byte
		want error
	}{
		{"not json", []byte(`nope`), lsp.ErrInvalidMessage},
		{"array", []byte(`[]`), lsp.ErrInvalidMessage},
		{"truncated object", []byte(`{"a":`), lsp.ErrInvalidMessage},
		{"empty", nil, lsp.ErrInvalidMessage},
		{"too large", []byte(`{"a":"` + strings.Repeat("x", lsp.MaxMessageSize) + `"}`), lsp.ErrTooLarge},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if err := s.Send(context.Background(), tt.msg); !errors.Is(err, tt.want) {
				t.Fatalf("err = %v, want %v", err, tt.want)
			}
		})
	}
}

func TestServerProtocolViolationsDropSession(t *testing.T) {
	for _, method := range []string{"fake/big", "fake/garbage"} {
		t.Run(method, func(t *testing.T) {
			m := newManager(t, lsp.Options{})
			s := start(t, m, "p1")
			ch, release, err := s.Subscribe()
			if err != nil {
				t.Fatal(err)
			}
			defer release()
			send(t, s, `{"jsonrpc":"2.0","method":"`+method+`"}`)
			waitClosed(t, ch)
			if info := exitInfo(t, s); !strings.Contains(info.Reason, "language server output") {
				t.Fatalf("exit = %+v", info)
			}
			if _, err := m.Get("p1", s.ID); !errors.Is(err, lsp.ErrNotFound) {
				t.Fatalf("session still registered: %v", err)
			}
		})
	}
}

func TestExitCode(t *testing.T) {
	m := newManager(t, lsp.Options{})
	s := start(t, m, "p1")
	ch, release, err := s.Subscribe()
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	send(t, s, `{"jsonrpc":"2.0","method":"fake/exit","params":{"code":3}}`)
	waitClosed(t, ch)
	if info := exitInfo(t, s); info.Code != 3 {
		t.Fatalf("exit = %+v", info)
	}
	if err := s.Send(context.Background(), []byte(`{}`)); !errors.Is(err, lsp.ErrClosed) {
		t.Fatalf("send after exit err = %v", err)
	}
}

func TestBackpressureDropsSession(t *testing.T) {
	m := newManager(t, lsp.Options{Buffer: 4})
	s := start(t, m, "p1")
	send(t, s, `{"jsonrpc":"2.0","method":"fake/flood","params":{"n":200}}`)
	ch, release, err := s.Subscribe()
	if err != nil {
		if errors.Is(err, lsp.ErrClosed) {
			ch = nil
		} else {
			t.Fatal(err)
		}
	} else {
		defer release()
	}
	if info := exitInfo(t, s); !strings.Contains(info.Reason, "too slow") || info.Code != -1 {
		t.Fatalf("exit = %+v", info)
	}
	if ch != nil {
		waitClosed(t, ch)
	}
	if _, err := m.Get("p1", s.ID); !errors.Is(err, lsp.ErrNotFound) {
		t.Fatalf("session still registered: %v", err)
	}
}

func TestSessionLimitPerProject(t *testing.T) {
	m := newManager(t, lsp.Options{MaxPerProject: 2})
	a, b := start(t, m, "p1"), start(t, m, "p1")
	if _, err := m.Start(context.Background(), "p1", fakeSpec(t)); !errors.Is(err, lsp.ErrTooManySessions) {
		t.Fatalf("third start err = %v", err)
	}
	start(t, m, "p2")
	if err := m.Close("p1", a.ID); err != nil {
		t.Fatal(err)
	}
	start(t, m, "p1")

	ch, release, err := b.Subscribe()
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	send(t, b, `{"jsonrpc":"2.0","method":"exit"}`)
	waitClosed(t, ch)
	start(t, m, "p1")
}

func TestConcurrentStartRespectsLimit(t *testing.T) {
	m := newManager(t, lsp.Options{MaxPerProject: 3})
	var wg sync.WaitGroup
	var mu sync.Mutex
	ok, limited := 0, 0
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := m.Start(context.Background(), "p1", fakeSpec(t))
			mu.Lock()
			defer mu.Unlock()
			switch {
			case err == nil:
				ok++
			case errors.Is(err, lsp.ErrTooManySessions):
				limited++
			default:
				t.Errorf("start: %v", err)
			}
		}()
	}
	wg.Wait()
	if ok != 3 || limited != 5 {
		t.Fatalf("ok=%d limited=%d", ok, limited)
	}
}

func TestProjectScoping(t *testing.T) {
	m := newManager(t, lsp.Options{})
	s := start(t, m, "p1")
	if _, err := m.Get("p2", s.ID); !errors.Is(err, lsp.ErrNotFound) {
		t.Fatalf("cross-project get err = %v", err)
	}
	if err := m.Close("p2", s.ID); !errors.Is(err, lsp.ErrNotFound) {
		t.Fatalf("cross-project close err = %v", err)
	}
	if _, err := m.Get("p1", s.ID); err != nil {
		t.Fatal(err)
	}
}

func TestConcurrentSendsStayFramed(t *testing.T) {
	m := newManager(t, lsp.Options{Buffer: 1024})
	s := start(t, m, "p1")
	ch, release, err := s.Subscribe()
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	var wg sync.WaitGroup
	for i := range 20 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			pad := strings.Repeat("x", 50000)
			send(t, s, fmt.Sprintf(`{"jsonrpc":"2.0","method":"n%d","params":{"pad":%q}}`, i, pad))
		}()
	}
	wg.Wait()
	for range 20 {
		if r := recv(t, ch); r.Method != "fake/echo" {
			t.Fatalf("got %+v", r)
		}
	}
}

func TestCloseKillsProcessGroup(t *testing.T) {
	m := newManager(t, lsp.Options{})
	s := start(t, m, "p1")
	ch, release, err := s.Subscribe()
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	send(t, s, `{"jsonrpc":"2.0","id":1,"method":"fake/spawn"}`)
	var child int
	if err := json.Unmarshal(recv(t, ch).Result, &child); err != nil || child == 0 {
		t.Fatalf("child pid: %v", err)
	}
	server := s.PID()
	if err := m.Close("p1", s.ID); err != nil {
		t.Fatal(err)
	}
	waitPidGone(t, server)
	waitPidGone(t, child)
	if _, err := m.Get("p1", s.ID); !errors.Is(err, lsp.ErrNotFound) {
		t.Fatalf("get after close: %v", err)
	}
	if info := exitInfo(t, s); info.Code != -1 || info.Reason != "closed by client" {
		t.Fatalf("exit = %+v", info)
	}
}

func TestShutdownKillsEverything(t *testing.T) {
	m := lsp.NewManager(lsp.Options{})
	a, b := start(t, m, "p1"), start(t, m, "p2")
	if err := m.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
	waitPidGone(t, a.PID())
	waitPidGone(t, b.PID())
	if _, err := m.Start(context.Background(), "p1", fakeSpec(t)); !errors.Is(err, lsp.ErrShutdown) {
		t.Fatalf("start after shutdown err = %v", err)
	}
}

func TestStartFailure(t *testing.T) {
	m := newManager(t, lsp.Options{MaxPerProject: 1})
	spec := fakeSpec(t)
	spec.Command = "/definitely/not/here"
	if _, err := m.Start(context.Background(), "p1", spec); err == nil {
		t.Fatal("expected error")
	}
	start(t, m, "p1")
}
