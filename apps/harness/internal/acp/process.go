package acp

import (
	"bytes"
	"fmt"
	"github.com/ndolinschi/Octo/apps/harness/internal/acptrace"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/childenv"
)

const (
	stderrLineCap = 2000
	stderrTailCap = 4096
	waitDelay     = 2 * time.Second
)

// Spec says how to start an agent process. Env entries are added after the
// inherited environment has been scrubbed of provider keys (see childenv); Dir is the process's working directory.
type Spec struct {
	Command string
	Args    []string
	Env     map[string]string
	Dir     string
	// Name labels the agent in logs.
	Name string
	// Redact, when set, removes secrets from the agent's stderr lines before
	// they are logged or quoted in an error.
	Redact func(string) string
	// OnCommands, when set, is called with the agent's slash commands every
	// time it sends available_commands_update, also outside a prompt (agents
	// send the first list right after the session is created).
	OnCommands func([]Command)
}

type process struct {
	// trace is the session's wire trace (nil when tracing is off).
	trace  *acptrace.Trace
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout *os.File
	stderr *stderrLog
	exited chan struct{}
	err    error // valid after exited is closed
}

func startProcess(spec Spec) (*process, error) {
	cmd := exec.Command(spec.Command, spec.Args...)
	cmd.Dir = spec.Dir
	cmd.Env = childenv.Build(os.Environ(), spec.Env)
	cmd.WaitDelay = waitDelay
	setProcessGroup(cmd)
	tr := acptrace.Begin(spec.Name, mapValues(spec.Env), spec.Redact)
	stderr := &stderrLog{name: spec.Name, redact: spec.Redact, tr: tr}
	cmd.Stderr = stderr
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	pr, pw, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	cmd.Stdout = pw
	if err := cmd.Start(); err != nil {
		_ = pr.Close()
		_ = pw.Close()
		return nil, fmt.Errorf("start %s: %w", spec.Command, err)
	}
	if err := pw.Close(); err != nil {
		slog.Debug("acp: close pipe writer", "err", err)
	}
	p := &process{trace: tr, cmd: cmd, stdin: stdin, stdout: pr, stderr: stderr, exited: make(chan struct{})}
	go func() {
		p.err = cmd.Wait()
		close(p.exited)
	}()
	return p, nil
}

func (p *process) pid() int { return p.cmd.Process.Pid }

// kill terminates the process and, on unix, its whole group.
func (p *process) kill() {
	killGroup(p.cmd)
}

// closeAndWait ends stdin, gives the process a moment to exit on its own,
// then kills it. It returns once the process is reaped.
func (p *process) closeAndWait(grace time.Duration) {
	if err := p.stdin.Close(); err != nil {
		slog.Debug("acp: close stdin", "err", err)
	}
	select {
	case <-p.exited:
	case <-time.After(grace):
	}
	p.kill()
	<-p.exited
	if err := p.stdout.Close(); err != nil {
		slog.Debug("acp: close stdout", "err", err)
	}
}

// describeExit summarizes how the process ended, with the stderr tail.
func (p *process) describeExit() string {
	select {
	case <-p.exited:
	case <-time.After(time.Second):
		return "agent closed its output"
	}
	msg := "agent exited"
	if p.err != nil {
		msg = "agent exited: " + p.err.Error()
	}
	if tail := p.stderr.tail(); tail != "" {
		msg += " (stderr: " + tail + ")"
	}
	return msg
}

// stderrLog logs each stderr line at debug (capped) and remembers a tail.
type stderrLog struct {
	name string
	// redact, when set, cleans each line before it is logged or kept.
	redact func(string) string
	tr     *acptrace.Trace
	mu     sync.Mutex
	buf    bytes.Buffer
	last   []byte
	// firstLine is the first non-empty (redacted) line the agent wrote.
	firstLine string
}

func (s *stderrLog) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.buf.Write(p)
	for {
		i := bytes.IndexByte(s.buf.Bytes(), '\n')
		if i < 0 {
			break
		}
		s.line(string(s.buf.Next(i + 1)))
	}
	if s.buf.Len() > stderrLineCap {
		s.line(string(s.buf.Next(s.buf.Len())))
	}
	return len(p), nil
}

func (s *stderrLog) line(l string) {
	l = strings.TrimRight(l, "\r\n")
	if s.redact != nil {
		l = s.redact(l)
	}
	if len(l) > stderrLineCap {
		l = l[:stderrLineCap] + "...(truncated)"
	}
	if s.firstLine == "" {
		s.firstLine = strings.TrimSpace(strings.ToValidUTF8(l, ""))
	}
	s.tr.Stderr(l)
	slog.Debug("acp agent stderr", "agent", s.name, "line", l)
	s.last = append(s.last, l...)
	s.last = append(s.last, ' ')
	if len(s.last) > stderrTailCap {
		s.last = s.last[len(s.last)-stderrTailCap:]
	}
}

func (s *stderrLog) tail() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.buf.Len() > 0 {
		s.line(string(s.buf.Next(s.buf.Len())))
	}
	return strings.TrimSpace(strings.ToValidUTF8(string(s.last), ""))
}

// first is the first non-empty line the agent wrote to stderr (redacted), "" when none.
func (s *stderrLog) first() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.buf.Len() > 0 {
		s.line(string(s.buf.Next(s.buf.Len())))
	}
	return s.firstLine
}

func mapValues(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for _, v := range m {
		out = append(out, v)
	}
	return out
}
