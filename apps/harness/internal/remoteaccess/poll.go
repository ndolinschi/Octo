package remoteaccess

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"math"
	"net/http"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/events"
	"github.com/ndolinschi/Octo/apps/harness/internal/usererr"
)

// MaxStreamsPerDevice bounds the poll streams one device may hold; the oldest goes when it opens another.
const MaxStreamsPerDevice = 8

// maxBatch bounds the events one poll answer carries; the rest wait for the next poll.
const maxBatch = 500

// PollAnswer is GET /v1/projects/{pid}/events/poll's answer.
type PollAnswer struct {
	Stream string            `json:"stream"`
	Events []json.RawMessage `json:"events"`
}

type pollStream struct {
	id, device, pid string
	ch              <-chan events.Event
	cancel          func()
	mu              sync.Mutex   // one poll at a time reads the channel
	last            atomic.Int64 // unix nanoseconds of the last poll's end
}

// polls are the long-poll event streams: the tunnel's replacement for SSE (quick tunnels do not carry SSE).
type polls struct {
	mu        sync.Mutex
	m         map[string]*pollStream
	subscribe func(ctx context.Context, pid string) (<-chan events.Event, func(), error)
	now       func() time.Time
}

func newPolls(sub func(ctx context.Context, pid string) (<-chan events.Event, func(), error), now func() time.Time) *polls {
	return &polls{m: map[string]*pollStream{}, subscribe: sub, now: now}
}

func (m *Manager) poll(w http.ResponseWriter, r *http.Request) {
	d, _ := deviceOf(r)
	pid := split(r.URL.Path)[2]
	q := r.URL.Query()
	wait := m.o.PollWait
	if v := q.Get("wait"); v != "" {
		if n, err := strconv.ParseFloat(v, 64); err == nil && !math.IsNaN(n) && !math.IsInf(n, 0) && n >= 0 && time.Duration(n*float64(time.Second)) < wait {
			wait = time.Duration(n * float64(time.Second))
		}
	}
	p := m.polls
	id := q.Get("stream")
	if id == "" {
		s, err := p.open(r.Context(), d.ID, pid)
		if err != nil {
			writeProblem(w, http.StatusNotFound, usererr.Generic("not_found", err.Error()))
			return
		}
		writeJSON(w, http.StatusOK, PollAnswer{Stream: s.id, Events: []json.RawMessage{}})
		return
	}
	s := p.get(id, d.ID, pid)
	if s == nil {
		writeProblem(w, http.StatusGone, usererr.Remote("stream_gone"))
		return
	}
	evs, open := s.collect(r.Context(), wait, p.now)
	if !open {
		p.close(id)
		writeProblem(w, http.StatusGone, usererr.Remote("stream_gone"))
		return
	}
	writeJSON(w, http.StatusOK, PollAnswer{Stream: id, Events: evs})
}

func (p *polls) open(ctx context.Context, device, pid string) (*pollStream, error) {
	if p.subscribe == nil {
		return nil, errNoEvents
	}
	ch, cancel, err := p.subscribe(ctx, pid)
	if err != nil {
		return nil, err
	}
	b := make([]byte, 12)
	_, _ = rand.Read(b)
	s := &pollStream{id: "ps_" + hex.EncodeToString(b), device: device, pid: pid, ch: ch, cancel: cancel}
	s.last.Store(p.now().UnixNano())
	p.mu.Lock()
	var mine []*pollStream
	for _, o := range p.m {
		if o.device == device {
			mine = append(mine, o)
		}
	}
	for len(mine) >= MaxStreamsPerDevice {
		oldest := 0
		for i, o := range mine {
			if o.lastSeen().Before(mine[oldest].lastSeen()) {
				oldest = i
			}
		}
		mine[oldest].cancel()
		delete(p.m, mine[oldest].id)
		mine = append(mine[:oldest], mine[oldest+1:]...)
	}
	p.m[s.id] = s
	p.mu.Unlock()
	return s, nil
}

type pollError string

func (e pollError) Error() string { return string(e) }

const errNoEvents = pollError("no event source")

func (s *pollStream) lastSeen() time.Time { return time.Unix(0, s.last.Load()) }

// get returns the stream when it exists and belongs to that device and project.
func (p *polls) get(id, device, pid string) *pollStream {
	p.mu.Lock()
	defer p.mu.Unlock()
	s := p.m[id]
	if s == nil || s.device != device || s.pid != pid {
		return nil
	}
	return s
}

// collect waits for at least one event (or wait, or the request's end) and returns what is there. open is false
// when the hub dropped the subscriber (it lagged): the client must re-read.
func (s *pollStream) collect(ctx context.Context, wait time.Duration, now func() time.Time) (evs []json.RawMessage, open bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	defer func() { s.last.Store(now().UnixNano()) }()
	evs = []json.RawMessage{}
	timer := time.NewTimer(wait)
	defer timer.Stop()
	select {
	case ev, ok := <-s.ch:
		if !ok {
			return nil, false
		}
		evs = append(evs, json.RawMessage(ev.Data))
	case <-timer.C:
		return evs, true
	case <-ctx.Done():
		return evs, true
	}
	for len(evs) < maxBatch {
		select {
		case ev, ok := <-s.ch:
			if !ok {
				return evs, true // deliver what came; the next poll reports the end
			}
			evs = append(evs, json.RawMessage(ev.Data))
		default:
			return evs, true
		}
	}
	return evs, true
}

func (p *polls) close(id string) {
	p.mu.Lock()
	s := p.m[id]
	delete(p.m, id)
	p.mu.Unlock()
	if s != nil {
		s.cancel()
	}
}

func (p *polls) closeDevice(device string) {
	p.mu.Lock()
	var gone []*pollStream
	for id, s := range p.m {
		if s.device == device {
			gone = append(gone, s)
			delete(p.m, id)
		}
	}
	p.mu.Unlock()
	for _, s := range gone {
		s.cancel()
	}
}

func (p *polls) closeAll() {
	p.mu.Lock()
	all := p.m
	p.m = map[string]*pollStream{}
	p.mu.Unlock()
	for _, s := range all {
		s.cancel()
	}
}

// reap drops streams nobody polled for idle (a poll in progress counts as polling).
func (p *polls) reap(idle time.Duration) {
	p.mu.Lock()
	var gone []*pollStream
	for id, s := range p.m {
		if !s.mu.TryLock() {
			continue // being polled now
		}
		stale := p.now().Sub(s.lastSeen()) > idle
		s.mu.Unlock()
		if stale {
			gone = append(gone, s)
			delete(p.m, id)
		}
	}
	p.mu.Unlock()
	for _, s := range gone {
		s.cancel()
	}
}
