package plugins

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"sync"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/childenv"
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

// runProbe executes the manifest's probe command: exit 0 is logged in (unless
// its output matches the agent's notLoggedInPattern), a non-zero exit is logged
// out, anything else (not startable, timed out) is unknown. Its output is never
// kept or shown.
func runProbe(ctx context.Context, a Agent) *bool {
	r := probeOnce(ctx, a)
	if r.LoggedIn == nil {
		slog.Debug("agent login probe inconclusive", "agent", a.ID, "reason", r.Reason)
	}
	return r.LoggedIn
}

// probeOnce runs the probe and classifies the outcome.
func probeOnce(ctx context.Context, a Agent) ProbeReport {
	pctx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()
	cmd := exec.CommandContext(pctx, a.ProbeCommand, a.ProbeArgs...)
	cmd.Dir = a.Launch.Dir
	cmd.Env = childenv.Build(os.Environ(), a.ResolvedEnv())
	cmd.WaitDelay = time.Second
	var out capped
	if a.ProbeNotLoggedIn != nil {
		cmd.Stdout, cmd.Stderr = &out, &out
	}
	err := cmd.Run()
	var exit *exec.ExitError
	switch {
	case err == nil:
		if a.ProbeNotLoggedIn != nil && a.ProbeNotLoggedIn.Match(out.b) {
			return ProbeReport{Ran: true, LoggedIn: boolPtr(false), Reason: "the probe exited 0 but its output says the agent is not logged in"}
		}
		return ProbeReport{Ran: true, LoggedIn: boolPtr(true), Reason: "the probe exited 0"}
	case errors.As(err, &exit) && pctx.Err() == nil:
		return ProbeReport{Ran: true, LoggedIn: boolPtr(false), Reason: fmt.Sprintf("the probe exited with status %d", exit.ExitCode())}
	case pctx.Err() != nil:
		return ProbeReport{Ran: true, Reason: "the probe timed out"}
	}
	return ProbeReport{Ran: true, Reason: "the probe could not be started"}
}

// capped keeps the first 64 KiB written to it.
type capped struct{ b []byte }

func (c *capped) Write(p []byte) (int, error) {
	if room := 64<<10 - len(c.b); room > 0 {
		c.b = append(c.b, p[:min(len(p), room)]...)
	}
	return len(p), nil
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

// ProbeReport is the outcome of one login probe, for diagnostics.
type ProbeReport struct {
	// Ran is false when there is no probe or the agent is not available.
	Ran bool `json:"ran"`
	// LoggedIn is nil when the probe was inconclusive or did not run.
	LoggedIn *bool `json:"logged_in"`
	// Reason says what happened, never including the probe's output.
	Reason string `json:"reason"`
}

// ProbeNow runs the login probe once, synchronously, and says why it came out
// as it did. Used by `harness doctor`; the server never calls it on a request.
func (a Agent) ProbeNow(ctx context.Context) ProbeReport {
	switch {
	case a.ProbeCommand == "":
		return ProbeReport{Reason: "this agent has no login probe"}
	case !a.Available:
		return ProbeReport{Reason: "not run: the agent is not available"}
	}
	return probeOnce(ctx, a)
}

// LastProbe describes the cached background result, without running anything.
func (a Agent) LastProbe() ProbeReport {
	switch {
	case a.ProbeCommand == "":
		return ProbeReport{Reason: "this agent has no login probe"}
	case a.LoggedIn == nil:
		return ProbeReport{Reason: "no result yet or inconclusive"}
	case *a.LoggedIn:
		return ProbeReport{Ran: true, LoggedIn: a.LoggedIn, Reason: "the last probe exited 0"}
	}
	return ProbeReport{Ran: true, LoggedIn: a.LoggedIn, Reason: "the last probe exited non-zero"}
}
