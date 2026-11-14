package remoteaccess

import (
	"bufio"
	"context"
	"errors"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/childenv"
)

type tunnelOpts struct {
	bin          string
	target       string // http://127.0.0.1:<port> of the remote listener
	startTimeout time.Duration
	backoff      func(attempt int) time.Duration
	maxFails     int
	stopGrace    time.Duration
}

type tunnelHooks struct {
	onURL       func(url string)
	onConnected func()
	onRestart   func(attempt int)
	onFailed    func(tail string)
}

// Backoff is the wait before restart number attempt (1-based): 1, 2, 4, 8, 16 s, at most 60 s.
func Backoff(attempt int) time.Duration {
	d := time.Second << max(0, attempt-1)
	if d > time.Minute || d <= 0 {
		d = time.Minute
	}
	return d
}

var errStartTimeout = errors.New("cloudflared printed no tunnel URL in time")

// superviseTunnel runs cloudflared until ctx ends, restarting it with backoff. maxFails runs in a row that end
// without a URL, or end after one, give up (hooks.onFailed with the last output lines).
func superviseTunnel(ctx context.Context, o tunnelOpts, h tunnelHooks) {
	tail := &ring{max: 20}
	fails := 0
	for {
		reached, err := runTunnelOnce(ctx, o, h, tail)
		if ctx.Err() != nil {
			return
		}
		if reached {
			fails = 0
		}
		fails++
		if err != nil {
			tail.add("(" + err.Error() + ")")
		}
		if fails >= o.maxFails {
			h.onFailed(tail.String())
			return
		}
		h.onRestart(fails)
		select {
		case <-time.After(o.backoff(fails)):
		case <-ctx.Done():
			return
		}
	}
}

func runTunnelOnce(ctx context.Context, o tunnelOpts, h tunnelHooks, tail *ring) (reached bool, err error) {
	cmd := exec.Command(o.bin, "tunnel", "--no-autoupdate", "--url", o.target)
	// The child environment filter keeps provider keys and the harness's own token away from it, as for every child.
	cmd.Env = childenv.Scrub(os.Environ())
	setProcessGroup(cmd)
	r, w, err := os.Pipe()
	if err != nil {
		return false, err
	}
	cmd.Stdout, cmd.Stderr = w, w
	if err := cmd.Start(); err != nil {
		_ = r.Close()
		_ = w.Close()
		return false, err
	}
	_ = w.Close()
	defer func() { _ = r.Close() }()
	lines := make(chan string, 64)
	go func() {
		defer close(lines)
		sc := bufio.NewScanner(r)
		sc.Buffer(make([]byte, 64*1024), 64*1024)
		for sc.Scan() {
			lines <- sc.Text()
		}
	}()
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()
	timer := time.NewTimer(o.startTimeout)
	defer timer.Stop()
	seen := func(line string) {
		tail.add(line)
		if u := ParseQuickURL(line); u != "" && !reached {
			reached = true
			timer.Stop()
			h.onURL(u)
		}
		if isRegistered(line) {
			h.onConnected()
		}
	}
	for {
		select {
		case line, ok := <-lines:
			if !ok {
				lines = nil
				continue
			}
			seen(line)
		case err := <-exited:
			// Lines written just before the exit are still worth reading (a URL, an error).
			drain(lines, seen)
			if err == nil {
				err = errors.New("cloudflared exited")
			}
			return reached, err
		case <-timer.C:
			if !reached {
				stopProcess(cmd, exited, o.stopGrace)
				return false, errStartTimeout
			}
		case <-ctx.Done():
			stopProcess(cmd, exited, o.stopGrace)
			return reached, ctx.Err()
		}
	}
}

func drain(lines <-chan string, f func(string)) {
	if lines == nil {
		return
	}
	deadline := time.After(200 * time.Millisecond)
	for {
		select {
		case l, ok := <-lines:
			if !ok {
				return
			}
			f(l)
		case <-deadline:
			return
		}
	}
}

// stopProcess sends SIGTERM to the group, waits grace, then SIGKILL; it returns once the process was reaped.
func stopProcess(cmd *exec.Cmd, exited <-chan error, grace time.Duration) {
	signalGroup(cmd, false)
	select {
	case <-exited:
		signalGroup(cmd, true) // helpers the group may still hold
	case <-time.After(grace):
		signalGroup(cmd, true)
		<-exited
	}
}

// ring keeps the last lines of output.
type ring struct {
	mu    sync.Mutex
	max   int
	lines []string
}

func (r *ring) add(s string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(s) > 300 {
		s = s[:300]
	}
	r.lines = append(r.lines, s)
	if len(r.lines) > r.max {
		r.lines = r.lines[len(r.lines)-r.max:]
	}
}

func (r *ring) String() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return strings.Join(r.lines, "\n")
}
