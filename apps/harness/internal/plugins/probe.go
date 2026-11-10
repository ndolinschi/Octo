package plugins

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"os/exec"
	"sync"
	"time"
)

// Probe pacing: a probe for one agent runs at most once per ProbeInterval and
// is killed after ProbeTimeout.
const (
	ProbeInterval = time.Minute
	ProbeTimeout  = 5 * time.Second
)

// prober caches login probe results. It never blocks a caller: refreshes run
// in their own goroutines and readers see the last result.
type prober struct {
	now func() time.Time
	run func(ctx context.Context, a Agent) *bool

	mu    sync.Mutex
	ctx   context.Context // nil until StartProbes; probing is off before that
	state map[string]*probeState
}

type probeState struct {
	at      time.Time
	running bool
	result  *bool
}

func newProber() *prober {
	return &prober{now: time.Now, run: runProbe, state: map[string]*probeState{}}
}

func (a Agent) probeable() bool { return a.Available && a.ProbeCommand != "" }

// result returns the last probe outcome for id, nil when unknown.
func (p *prober) result(id string) *bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if st := p.state[id]; st != nil && st.result != nil {
		v := *st.result
		return &v
	}
	return nil
}

// refresh starts a background probe for each agent whose last one is older
// than ProbeInterval and is not already running.
func (p *prober) refresh(agents []Agent) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.ctx == nil || p.ctx.Err() != nil {
		return
	}
	for _, a := range agents {
		if !a.probeable() {
			continue
		}
		st := p.state[a.ID]
		if st == nil {
			st = &probeState{}
			p.state[a.ID] = st
		}
		if st.running || (!st.at.IsZero() && p.now().Sub(st.at) < ProbeInterval) {
			continue
		}
		st.running, st.at = true, p.now()
		go p.probe(p.ctx, a, st)
	}
}

func (p *prober) probe(ctx context.Context, a Agent, st *probeState) {
	res := p.run(ctx, a)
	p.mu.Lock()
	st.result, st.running = res, false
	p.mu.Unlock()
}

// runProbe executes the manifest's probe command: exit 0 is logged in, a
// non-zero exit is logged out, anything else (not startable, timed out) is
// unknown. Its output is discarded.
func runProbe(ctx context.Context, a Agent) *bool {
	ctx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, a.ProbeCommand, a.ProbeArgs...)
	cmd.Dir = a.Launch.Dir
	cmd.Env = os.Environ()
	for k, v := range a.ResolvedEnv() {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
	cmd.WaitDelay = time.Second
	err := cmd.Run()
	var exit *exec.ExitError
	switch {
	case err == nil:
		return boolPtr(true)
	case errors.As(err, &exit) && ctx.Err() == nil:
		return boolPtr(false)
	}
	slog.Debug("agent login probe inconclusive", "agent", a.ID, "err", err)
	return nil
}

func boolPtr(v bool) *bool { return &v }

// probeTimeout is ProbeTimeout; tests shorten it.
var probeTimeout = ProbeTimeout

// Probe runs the agent's login probe once, synchronously (the registry does
// this in the background; this is for tools and tests). Nil means there is no
// probe or it was inconclusive.
func (a Agent) Probe(ctx context.Context) *bool {
	if !a.probeable() {
		return nil
	}
	return runProbe(ctx, a)
}
