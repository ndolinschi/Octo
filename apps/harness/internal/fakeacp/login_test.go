package fakeacp

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestLoginAndStatus(t *testing.T) {
	file := filepath.Join(t.TempDir(), "acct", "login")
	t.Setenv(EnvLoginFile, file)
	ctx := context.Background()

	var out, errOut bytes.Buffer
	if code, done := cliCommand(ctx, []string{"status"}, strings.NewReader(""), &out, &errOut); !done || code != 1 || !strings.Contains(out.String(), NotLoggedInLine) {
		t.Fatalf("status before login = %d %v %q", code, done, out.String())
	}

	out.Reset()
	if code, done := cliCommand(ctx, []string{"login"}, strings.NewReader("\n"), &out, &errOut); !done || code != 0 {
		t.Fatalf("login = %d %v %q %q", code, done, out.String(), errOut.String())
	}
	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	if len(lines) < 3 || lines[0] != LoginURLLine || lines[1] != LoginCodeLine || lines[len(lines)-1] != LoginDone {
		t.Fatalf("login output = %q", out.String())
	}
	if _, err := os.Stat(file); err != nil {
		t.Fatalf("login file not written: %v", err)
	}

	out.Reset()
	if code, _ := cliCommand(ctx, []string{"status"}, strings.NewReader(""), &out, &errOut); code != 0 {
		t.Fatalf("status after login = %d %q", code, out.String())
	}
}

func TestLoginNeedsInputAndFile(t *testing.T) {
	ctx := context.Background()
	var out, errOut bytes.Buffer
	t.Setenv(EnvLoginFile, "")
	if code, done := cliCommand(ctx, []string{"login"}, strings.NewReader("\n"), &out, &errOut); !done || code != 1 {
		t.Fatalf("login without %s = %d %v", EnvLoginFile, code, done)
	}
	file := filepath.Join(t.TempDir(), "login")
	t.Setenv(EnvLoginFile, file)
	if code, _ := cliCommand(ctx, []string{"login"}, strings.NewReader(""), &out, &errOut); code != 1 {
		t.Fatalf("login with no input = %d, want 1", code)
	}
	if _, err := os.Stat(file); err == nil {
		t.Fatal("login file written without input")
	}
	if _, done := cliCommand(ctx, []string{"--model", "x"}, strings.NewReader(""), &out, &errOut); done {
		t.Fatal("ACP arguments were taken for a subcommand")
	}
}

// prompt runs one session/prompt on a fresh agent and returns the lines it wrote.
func prompt(t *testing.T, text string) []map[string]json.RawMessage {
	t.Helper()
	req := func(id int, method, params string) string {
		return `{"jsonrpc":"2.0","id":` + string(rune('0'+id)) + `,"method":"` + method + `","params":` + params + "}\n"
	}
	in := req(1, "initialize", `{}`) + req(2, "session/new", `{"cwd":"`+t.TempDir()+`"}`) +
		req(3, "session/prompt", `{"sessionId":"fake-session-1","prompt":[{"type":"text","text":"`+text+`"}]}`)
	out := &syncBuf{}
	a := &agent{in: strings.NewReader(in), out: out, log: &bytes.Buffer{}, exit: func(int) {}, pending: map[int64]chan reply{}}
	if err := a.serve(context.Background()); err != nil {
		t.Fatal(err)
	}
	// serve returns at end of input; the prompt runs in a goroutine.
	waitFor(t, func() bool { return strings.Contains(out.String(), `"id":3`) })
	var lines []map[string]json.RawMessage
	for _, l := range strings.Split(strings.TrimSpace(out.String()), "\n") {
		var m map[string]json.RawMessage
		if json.Unmarshal([]byte(l), &m) == nil {
			lines = append(lines, m)
		}
	}
	return lines
}

func TestLimitRPCMarker(t *testing.T) {
	for _, m := range prompt(t, "hello "+MarkerLimitRPC) {
		if string(m["id"]) != "3" {
			continue
		}
		var e struct {
			Data struct {
				ErrorKind string `json:"errorKind"`
				RateLimit struct {
					ResetsAt string `json:"resetsAt"`
				} `json:"rateLimit"`
			} `json:"data"`
		}
		if err := json.Unmarshal(m["error"], &e); err != nil || e.Data.ErrorKind != "rate_limit" || e.Data.RateLimit.ResetsAt == "" {
			t.Fatalf("error = %s (%v)", m["error"], err)
		}
		return
	}
	t.Fatal("no answer to the prompt")
}

func TestLimitAgentErrorMarker(t *testing.T) {
	found := false
	for _, m := range prompt(t, "hello "+MarkerLimitAgentError) {
		if strings.Contains(string(m["params"]), `"agent_error"`) && strings.Contains(string(m["params"]), `"statusCode":429`) {
			found = true
		}
		if string(m["id"]) == "3" && m["error"] != nil {
			t.Fatalf("the prompt failed with an RPC error: %s", m["error"])
		}
	}
	if !found {
		t.Fatal("no agent_error update with status 429")
	}
}

func TestReportValues(t *testing.T) {
	t.Setenv(EnvReportValues, "OCTO_FAKEACP_LOGIN_FILE, NOPE_FAKEACP")
	t.Setenv(EnvLoginFile, "/x/login")
	os.Unsetenv("NOPE_FAKEACP")
	want := " Env values: OCTO_FAKEACP_LOGIN_FILE=/x/login, NOPE_FAKEACP=unset."
	if got := reportValues(); got != want {
		t.Fatalf("reportValues = %q, want %q", got, want)
	}
	t.Setenv(EnvReportValues, "")
	if got := reportValues(); got != "" {
		t.Fatalf("reportValues without names = %q", got)
	}
}

func waitFor(t *testing.T, ok func() bool) {
	t.Helper()
	for i := 0; i < 200; i++ {
		if ok() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("timed out")
}

// syncBuf is a buffer the agent's goroutines write while the test reads it.
type syncBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuf) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuf) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}
