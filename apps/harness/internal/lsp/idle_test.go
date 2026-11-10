package lsp_test

import (
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/lsp"
)

type fakeTimers struct {
	mu     sync.Mutex
	timers []*fakeTimer
}

type fakeTimer struct {
	d       time.Duration
	f       func()
	stopped bool
}

func (ft *fakeTimers) after(d time.Duration, f func()) func() bool {
	t := &fakeTimer{d: d, f: f}
	ft.mu.Lock()
	ft.timers = append(ft.timers, t)
	ft.mu.Unlock()
	return func() bool {
		ft.mu.Lock()
		defer ft.mu.Unlock()
		was := !t.stopped
		t.stopped = true
		return was
	}
}

func (ft *fakeTimers) last(t *testing.T) *fakeTimer {
	t.Helper()
	ft.mu.Lock()
	defer ft.mu.Unlock()
	if len(ft.timers) == 0 {
		t.Fatal("no timers armed")
	}
	return ft.timers[len(ft.timers)-1]
}

func (ft *fakeTimers) count() int {
	ft.mu.Lock()
	defer ft.mu.Unlock()
	return len(ft.timers)
}

func (ft *fakeTimers) fire(t *testing.T, tm *fakeTimer) {
	t.Helper()
	tm.f()
}

func TestIdleReapingWithoutSubscriber(t *testing.T) {
	ft := &fakeTimers{}
	m := newManager(t, lsp.Options{IdleTimeout: 30 * time.Second, After: ft.after})
	s := start(t, m, "p1")
	tm := ft.last(t)
	if tm.d != 30*time.Second {
		t.Fatalf("idle duration = %v", tm.d)
	}
	pid := s.PID()
	ft.fire(t, tm)
	waitPidGone(t, pid)
	if _, err := m.Get("p1", s.ID); !errors.Is(err, lsp.ErrNotFound) {
		t.Fatalf("get after reap: %v", err)
	}
	if info := exitInfo(t, s); info.Reason == "" {
		t.Fatalf("exit = %+v, want a reason", info)
	}
}

func TestSubscribeCancelsIdleTimerAndDisconnectRearms(t *testing.T) {
	ft := &fakeTimers{}
	m := newManager(t, lsp.Options{After: ft.after})
	s := start(t, m, "p1")
	first := ft.last(t)

	_, release, err := s.Subscribe()
	if err != nil {
		t.Fatal(err)
	}
	ft.fire(t, first)
	if _, err := m.Get("p1", s.ID); err != nil {
		t.Fatalf("stale idle timer reaped a subscribed session: %v", err)
	}

	release()
	if ft.count() != 2 {
		t.Fatalf("timers = %d, want 2 after disconnect", ft.count())
	}
	second := ft.last(t)
	_, release2, err := s.Subscribe()
	if err != nil {
		t.Fatal(err)
	}
	ft.fire(t, second)
	if _, err := m.Get("p1", s.ID); err != nil {
		t.Fatalf("stale timer reaped a resubscribed session: %v", err)
	}
	release2()
	third := ft.last(t)
	pid := s.PID()
	ft.fire(t, third)
	waitPidGone(t, pid)
	if _, err := m.Get("p1", s.ID); !errors.Is(err, lsp.ErrNotFound) {
		t.Fatalf("get after reap: %v", err)
	}
}
