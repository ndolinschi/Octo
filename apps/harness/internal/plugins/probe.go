package plugins

import (
	"context"
	"sync"
	"time"
)

// Probe pacing: a probe for one agent runs at most once per ProbeInterval (a
// "not logged in" result is looked at again after NegativeProbeInterval, since
// the user is probably about to log in) and is killed after ProbeTimeout. A
// synchronous check before a refusal (Registry.Fresh) reuses a result younger
// than FreshProbeAge.
const (
	ProbeInterval         = time.Minute
	NegativeProbeInterval = 15 * time.Second
	FreshProbeAge         = 5 * time.Second
	ProbeTimeout          = 5 * time.Second
)

// prober caches login probe results. Background refreshes never block a
// caller; they run in their own goroutines and readers see the last result.
type prober struct {
	now func() time.Time
	run func(ctx context.Context, a Agent) ProbeReport

	mu       sync.Mutex
	ctx      context.Context // nil until StartProbes; background probing is off before that
	state    map[string]*probeState
	onChange func() // called, unlocked, when a probe's outcome differs from the last one
}

type probeState struct {
	at      time.Time // when the last probe started
	running bool
	wait    chan struct{} // closed when the running probe has stored its result
	result  *bool
	report  ProbeReport
}

func newProber() *prober {
	return &prober{now: time.Now, run: probeOnce, state: map[string]*probeState{}}
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

// lastReport is the report of the last finished probe of id.
func (p *prober) lastReport(id string) ProbeReport {
	p.mu.Lock()
	defer p.mu.Unlock()
	if st := p.state[id]; st != nil {
		return st.report
	}
	return ProbeReport{}
}

// done reports whether a probe of id has finished at least once and none is
// running now.
func (p *prober) done(id string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	st := p.state[id]
	return st != nil && !st.at.IsZero() && !st.running
}

func (p *prober) stateOf(id string) *probeState {
	st := p.state[id]
	if st == nil {
		st = &probeState{}
		p.state[id] = st
	}
	return st
}

// stale reports whether the last result is old enough to be asked again.
func (p *prober) stale(st *probeState) bool {
	if st.at.IsZero() {
		return true
	}
	every := ProbeInterval
	if st.result != nil && !*st.result {
		every = NegativeProbeInterval
	}
	return p.now().Sub(st.at) >= every
}

// refresh starts a background probe for each agent whose last result is stale
// and is not already running. Callers are the requests that show logins, so a
// "not logged in" result is re-probed every NegativeProbeInterval while
// anything is looking.
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
		st := p.stateOf(a.ID)
		if st.running || !p.stale(st) {
			continue
		}
		p.begin(st)
		go p.finish(p.ctx, a, st)
	}
}

// begin marks st as running. The caller holds p.mu and then calls finish.
func (p *prober) begin(st *probeState) {
	st.running, st.at, st.wait = true, p.now(), make(chan struct{})
}

// finish runs the probe, stores its outcome and wakes the waiters.
func (p *prober) finish(ctx context.Context, a Agent, st *probeState) {
	rep := p.run(ctx, a)
	rep.At = p.now().UTC().Format(time.RFC3339)
	p.mu.Lock()
	changed := !sameResult(st.result, rep.LoggedIn)
	st.result, st.report, st.running = rep.LoggedIn, rep, false
	close(st.wait)
	notify := p.onChange
	p.mu.Unlock()
	if changed && notify != nil {
		notify()
	}
}

// sync probes a now unless the last probe started less than minAge ago (0
// forces one). A probe already running is joined. It returns when a result is
// stored or ctx ends.
func (p *prober) sync(ctx context.Context, a Agent, minAge time.Duration) {
	if !a.probeable() {
		return
	}
	p.mu.Lock()
	st := p.stateOf(a.ID)
	if st.running {
		w := st.wait
		p.mu.Unlock()
		select {
		case <-w:
		case <-ctx.Done():
		}
		return
	}
	if minAge > 0 && !st.at.IsZero() && p.now().Sub(st.at) < minAge {
		p.mu.Unlock()
		return
	}
	p.begin(st)
	p.mu.Unlock()
	// The probe has its own timeout; a client that goes away does not leave a
	// half-run probe behind as the stored result.
	p.finish(context.WithoutCancel(ctx), a, st)
}

func sameResult(a, b *bool) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}
