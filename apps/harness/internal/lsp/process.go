package lsp

import (
	"bytes"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"
)

const (
	waitDelay       = 2 * time.Second
	stderrLineCap   = 2000
	stderrTotalCap  = 1 << 20
	stderrPartialSz = 8 << 10
)

// Spec says how to start a language server. Env entries are added to the
// inherited environment; Dir is the working directory.
type Spec struct {
	Name    string
	Command string
	Args    []string
	Env     map[string]string
	Dir     string
}

type process struct {
	cmd    *exec.Cmd
	stdin  *os.File
	stdout *os.File
	exited chan struct{}
	code   int // valid after exited is closed; -1 when killed by a signal
}

func startProcess(spec Spec) (*process, error) {
	cmd := exec.Command(spec.Command, spec.Args...)
	cmd.Dir = spec.Dir
	cmd.Env = os.Environ()
	for k, v := range spec.Env {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
	cmd.WaitDelay = waitDelay
	setProcessGroup(cmd)
	cmd.Stderr = &stderrLog{name: spec.Name}
	inR, inW, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	outR, outW, err := os.Pipe()
	if err != nil {
		closeAll(inR, inW)
		return nil, err
	}
	cmd.Stdin, cmd.Stdout = inR, outW
	if err := cmd.Start(); err != nil {
		closeAll(inR, inW, outR, outW)
		return nil, fmt.Errorf("start %s: %w", spec.Command, err)
	}
	closeAll(inR, outW)
	p := &process{cmd: cmd, stdin: inW, stdout: outR, exited: make(chan struct{})}
	go func() {
		err := cmd.Wait()
		p.code = cmd.ProcessState.ExitCode()
		if err != nil {
			slog.Debug("lsp: server ended", "server", spec.Name, "err", err)
		}
		closeAll(p.stdin)
		close(p.exited)
	}()
	return p, nil
}

func closeAll(files ...*os.File) {
	for _, f := range files {
		if err := f.Close(); err != nil {
			slog.Debug("lsp: close pipe", "err", err)
		}
	}
}

// kill terminates the process and, on unix, its whole group.
func (p *process) kill() { killGroup(p.cmd) }

// stderrLog logs server stderr line by line at debug level, truncating long
// lines and discarding everything after stderrTotalCap bytes.
type stderrLog struct {
	name    string
	mu      sync.Mutex
	buf     bytes.Buffer
	written int
}

func (s *stderrLog) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.written >= stderrTotalCap {
		return len(p), nil
	}
	s.written += len(p)
	s.buf.Write(p)
	for {
		i := bytes.IndexByte(s.buf.Bytes(), '\n')
		if i < 0 {
			break
		}
		s.line(string(s.buf.Next(i + 1)))
	}
	if s.buf.Len() > stderrPartialSz {
		s.line(string(s.buf.Next(s.buf.Len())))
	}
	return len(p), nil
}

func (s *stderrLog) line(l string) {
	l = strings.ToValidUTF8(strings.TrimRight(l, "\r\n"), "")
	if len(l) > stderrLineCap {
		l = l[:stderrLineCap] + "...(truncated)"
	}
	slog.Debug("lsp server stderr", "server", s.name, "line", l)
}
