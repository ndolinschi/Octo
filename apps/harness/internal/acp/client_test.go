package acp_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/acp"
	"github.com/ndolinschi/Octo/apps/harness/internal/fakeacp"
)

func TestMain(m *testing.M) {
	if fakeacp.ChildMode() {
		os.Exit(fakeacp.Main())
	}
	os.Exit(m.Run())
}

func fakeSpec(dir string, env map[string]string) acp.Spec {
	e := map[string]string{fakeacp.EnvChild: "1", "GORACE": "atexit_sleep_ms=0"}
	for k, v := range env {
		e[k] = v
	}
	return acp.Spec{Command: os.Args[0], Env: e, Dir: dir, Name: "fake"}
}

type recHandler struct {
	mu       sync.Mutex
	text     strings.Builder
	calls    []string
	updates  []string
	usage    []int64
	perms    []string
	started  chan struct{}
	once     sync.Once
	readErrs []error
}

func newRec() *recHandler { return &recHandler{started: make(chan struct{})} }

func (h *recHandler) signal() { h.once.Do(func() { close(h.started) }) }

func (h *recHandler) AgentText(_ context.Context, t string) {
	h.mu.Lock()
	h.text.WriteString(t)
	h.mu.Unlock()
	h.signal()
}

func (h *recHandler) ToolCall(_ context.Context, c acp.ToolCall) {
	h.mu.Lock()
	h.calls = append(h.calls, c.ID+":"+c.Kind)
	h.mu.Unlock()
}

func (h *recHandler) ToolCallUpdate(_ context.Context, u acp.ToolCallUpdate) {
	h.mu.Lock()
	h.updates = append(h.updates, u.ID+":"+string(u.Status))
	h.mu.Unlock()
}

func (h *recHandler) Usage(_ context.Context, u acp.Usage) {
	h.mu.Lock()
	h.usage = append(h.usage, u.Used)
	h.mu.Unlock()
}

func (h *recHandler) RequestPermission(_ context.Context, r acp.PermissionRequest) string {
	opt, ok := r.FirstOption(acp.AllowOnce, acp.AllowAlways)
	h.mu.Lock()
	h.perms = append(h.perms, opt.ID)
	h.mu.Unlock()
	if !ok {
		return ""
	}
	return opt.ID
}

func (h *recHandler) ReadTextFile(_ context.Context, r acp.ReadTextFileParams) (string, error) {
	b, err := os.ReadFile(r.Path)
	if err != nil {
		h.readErrs = append(h.readErrs, err)
		return "", err
	}
	return string(b), nil
}

func (h *recHandler) WriteTextFile(_ context.Context, r acp.WriteTextFileParams) error {
	return os.WriteFile(r.Path, []byte(r.Content), 0o644)
}

func alive(pid int) bool { return syscall.Kill(pid, 0) == nil }

func TestClientHappyPath(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("# Hello\nbody\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	c, err := acp.Start(context.Background(), fakeSpec(dir, nil))
	if err != nil {
		t.Fatal(err)
	}
	pid := c.PID()
	h := newRec()
	stop, err := c.Run(context.Background(), dir, "summarize", h)
	if err != nil || stop != acp.StopEndTurn {
		t.Fatalf("Run = %q, %v", stop, err)
	}
	c.Close()
	if alive(pid) {
		t.Fatal("agent process still alive after Close")
	}
	if got := strings.Join(h.calls, ","); got != "call-read:read,call-edit:edit" {
		t.Errorf("calls = %s", got)
	}
	if got := strings.Join(h.updates, ","); got != "call-read:in_progress,call-read:completed,call-edit:completed" {
		t.Errorf("updates = %s", got)
	}
	if len(h.perms) != 1 || h.perms[0] != "allow-once" {
		t.Errorf("permission choices = %v", h.perms)
	}
	if len(h.usage) != 2 || h.usage[1] != 1800 {
		t.Errorf("usage = %v", h.usage)
	}
	if !strings.Contains(h.text.String(), "# Hello") || !strings.Contains(h.text.String(), fakeacp.NoteFile) {
		t.Errorf("text = %q", h.text.String())
	}
	if _, err := os.Stat(filepath.Join(dir, fakeacp.NoteFile)); err != nil {
		t.Errorf("note not written: %v", err)
	}
}

func TestClientUnknownVariantsAndRequestsTolerated(t *testing.T) {
	dir := t.TempDir()
	c, err := acp.Start(context.Background(), fakeSpec(dir, nil))
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	h := newRec()
	stop, err := c.Run(context.Background(), dir, "go "+fakeacp.MarkerUnknown, h)
	if err != nil || stop != acp.StopEndTurn {
		t.Fatalf("Run = %q, %v", stop, err)
	}
	if !strings.Contains(h.text.String(), "-32601") {
		t.Errorf("unknown request was not answered with -32601: %q", h.text.String())
	}
}

func TestClientCancelHang(t *testing.T) {
	dir := t.TempDir()
	c, err := acp.Start(context.Background(), fakeSpec(dir, nil))
	if err != nil {
		t.Fatal(err)
	}
	pid := c.PID()
	h := newRec()
	ctx, cancel := context.WithCancel(context.Background())
	go func() { <-h.started; cancel() }()
	start := time.Now()
	stop, err := c.Run(ctx, dir, fakeacp.MarkerHang, h)
	if err != nil || stop != acp.StopCancelled {
		t.Fatalf("Run = %q, %v", stop, err)
	}
	if time.Since(start) > 2*time.Second {
		t.Errorf("cooperative cancel took %s", time.Since(start))
	}
	c.Close()
	if alive(pid) {
		t.Fatal("agent process still alive")
	}
}

func TestClientCancelKillsDeafAgent(t *testing.T) {
	old := acp.CancelGrace
	acp.CancelGrace = 300 * time.Millisecond
	t.Cleanup(func() { acp.CancelGrace = old })
	dir := t.TempDir()
	c, err := acp.Start(context.Background(), fakeSpec(dir, nil))
	if err != nil {
		t.Fatal(err)
	}
	pid := c.PID()
	h := newRec()
	ctx, cancel := context.WithCancel(context.Background())
	go func() { <-h.started; cancel() }()
	_, err = c.Run(ctx, dir, fakeacp.MarkerDeaf, h)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
	c.Close()
	if alive(pid) {
		t.Fatal("deaf agent survived")
	}
}

func TestClientCrashMidTurn(t *testing.T) {
	dir := t.TempDir()
	c, err := acp.Start(context.Background(), fakeSpec(dir, nil))
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	_, err = c.Run(context.Background(), dir, fakeacp.MarkerCrash, newRec())
	if !errors.Is(err, acp.ErrClosed) || !strings.Contains(err.Error(), "exit status 3") {
		t.Fatalf("err = %v, want ErrClosed mentioning exit status 3", err)
	}
}

func TestStartFailures(t *testing.T) {
	dir := t.TempDir()
	for name, tc := range map[string]struct {
		spec acp.Spec
		want string
	}{
		"missing binary":  {acp.Spec{Command: filepath.Join(dir, "nope"), Dir: dir}, "start"},
		"wrong version":   {fakeSpec(dir, map[string]string{fakeacp.EnvProtocolVersion: "2"}), "protocol version 2"},
		"exits at launch": {acp.Spec{Command: "sh", Args: []string{"-c", "echo oops >&2; exit 4"}, Dir: dir}, "exit status 4"},
	} {
		t.Run(name, func(t *testing.T) {
			c, err := acp.Start(context.Background(), tc.spec)
			if err == nil {
				c.Close()
				t.Fatal("Start succeeded")
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want mention of %q", err, tc.want)
			}
		})
	}
}

func TestSessionAPIAdvertisesCapabilitiesAndResumes(t *testing.T) {
	dir := t.TempDir()
	c, err := acp.Start(context.Background(), fakeSpec(dir, map[string]string{
		fakeacp.EnvLoadSession: "1", fakeacp.EnvMCPHTTP: "1", fakeacp.EnvUniqueSessions: "1",
	}))
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if caps := c.Capabilities(); !caps.LoadSession || !caps.MCPHTTP || caps.MCPSSE {
		t.Fatalf("capabilities = %+v", caps)
	}
	http := acp.HTTPMCPServer("octo", "http://127.0.0.1:1/mcp", []acp.HTTPHeader{{Name: "Authorization", Value: "Bearer t"}})
	stdio := acp.StdioMCPServer("octo", "/bin/true", []string{"--x"}, []acp.EnvVar{{Name: "T", Value: "v"}})
	sess, err := c.NewSession(context.Background(), dir, []acp.MCPServer{http, stdio}, acp.RunOptions{})
	if err != nil {
		t.Fatal(err)
	}
	h := newRec()
	stop, err := c.Prompt(context.Background(), sess.ID, fakeacp.MarkerEcho+" hi", h)
	if err != nil || stop != acp.StopEndTurn {
		t.Fatalf("prompt = %v, %v", stop, err)
	}
	if !strings.Contains(h.text.String(), "session="+sess.ID) {
		t.Errorf("text = %q, want the session id %s", h.text.String(), sess.ID)
	}
	// A second prompt on the same session, then a resume that replays history
	// (dropped, not delivered to the handler).
	h2 := newRec()
	if _, err := c.Prompt(context.Background(), sess.ID, fakeacp.MarkerEcho+" again", h2); err != nil {
		t.Fatal(err)
	}
	if err := c.LoadSession(context.Background(), "resumed-1", dir, nil); err != nil {
		t.Fatal(err)
	}
	h3 := newRec()
	if _, err := c.Prompt(context.Background(), "resumed-1", fakeacp.MarkerEcho+" back", h3); err != nil {
		t.Fatal(err)
	}
	if got := h3.text.String(); !strings.Contains(got, "session=resumed-1 loaded=true") || strings.Contains(got, "replayed") {
		t.Errorf("after load: %q", got)
	}
}

func TestNewSessionRefusalUnwrapsToRPCError(t *testing.T) {
	dir := t.TempDir()
	c, err := acp.Start(context.Background(), fakeSpec(dir, map[string]string{fakeacp.EnvMCPReject: "1"}))
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if caps := c.Capabilities(); caps.LoadSession || caps.MCPHTTP {
		t.Fatalf("capabilities default to false: %+v", caps)
	}
	_, err = c.NewSession(context.Background(), dir, []acp.MCPServer{acp.StdioMCPServer("x", "/bin/true", nil, nil)}, acp.RunOptions{})
	var rpcErr *acp.RPCError
	if !errors.As(err, &rpcErr) {
		t.Fatalf("err = %v, want an *acp.RPCError", err)
	}
	if _, err := c.NewSession(context.Background(), dir, nil, acp.RunOptions{}); err != nil {
		t.Fatalf("without servers: %v", err)
	}
	if err := c.LoadSession(context.Background(), "s", dir, nil); err == nil {
		t.Error("session/load must fail on an agent without loadSession")
	}
}
