package providers_test

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/config"
	"github.com/ndolinschi/Octo/apps/harness/internal/providers"
	"github.com/ndolinschi/Octo/apps/harness/internal/usererr"
)

// fakeReach answers reachability probes from a table and counts them.
type fakeReach struct {
	mu    sync.Mutex
	down  map[string]bool
	calls map[string]int
}

func (f *fakeReach) probe(_ context.Context, url string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls[url]++
	if f.down[url] {
		return errors.New("dial tcp: connect: connection refused")
	}
	return nil
}

func (f *fakeReach) set(url string, down bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.down[url] = down
}

func (f *fakeReach) n(url string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls[url]
}

const ollamaURL = "http://127.0.0.1:11434"

func reachRig(t *testing.T, apiBase string, now *time.Time) (*providers.Service, *fakeReach) {
	t.Helper()
	f := &fakeReach{down: map[string]bool{}, calls: map[string]int{}}
	opts := providers.Options{
		Builtin:    func() (bool, string) { return apiBase != "", config.NoBuiltinLoopMessage },
		Ollama:     func() (string, string) { return ollamaURL, "qwen2.5-coder:1.5b" },
		Reach:      f.probe,
		APIBaseURL: func() string { return apiBase },
	}
	if now != nil {
		opts.Now = func() time.Time { return *now }
	}
	return providers.New(opts), f
}

// The QA finding: Ollama read "Ready · 4 models" while nothing listened on :11434.
func TestOllamaNotRunningIsNotReady(t *testing.T) {
	svc, f := reachRig(t, "", nil)
	f.set(ollamaURL, true)
	ol := byID(t, svc.Snapshot(), providers.IDOllama)
	if ol.State != providers.StateNotRunning || ol.Reach != providers.ReachNotRunning {
		t.Fatalf("state = %q reach = %q, want not_running", ol.State, ol.Reach)
	}
	p := ol.Problem
	if p == nil || p.Code != usererr.CodeProviderNotRunning || p.Message != "Ollama is not running." || p.Command != "ollama serve" ||
		p.Action != usererr.ActionRecheckProvider || p.Hint == "" || ol.Reason != p.Message {
		t.Fatalf("problem = %+v reason = %q", p, ol.Reason)
	}
	// Its models are listed (the catalogue), but nothing about it is ready.
	if len(ol.Models) == 0 {
		t.Fatal("models dropped")
	}
	if u := svc.Check("small"); u == nil || u.Provider != providers.IDOllama {
		t.Fatalf("Check(small) = %+v, want Ollama not running", u)
	}
	if u := svc.Check("ollama:qwen2.5-coder:3b"); u == nil {
		t.Fatal("Check(ollama:...) let an unreachable Ollama through")
	}
}

func TestOllamaRunningIsReady(t *testing.T) {
	svc, _ := reachRig(t, "", nil)
	ol := byID(t, svc.Snapshot(), providers.IDOllama)
	if ol.State != providers.StateReady || ol.Reach != providers.ReachOK || ol.Problem != nil {
		t.Fatalf("ollama = %+v", ol)
	}
	if u := svc.Check("small"); u != nil {
		t.Fatalf("Check(small) = %+v", u)
	}
}

// Results are cached like the login probe: a negative one for 15 s, a positive one for a minute; a recheck probes now.
func TestReachIsCachedAndRecheckable(t *testing.T) {
	now := time.Date(2026, 11, 18, 12, 0, 0, 0, time.UTC)
	svc, f := reachRig(t, "", &now)
	f.set(ollamaURL, true)
	svc.Snapshot()
	svc.Snapshot()
	if n := f.n(ollamaURL); n != 1 {
		t.Fatalf("probes = %d, want 1 (cached)", n)
	}
	// Ollama was started: "Check again" sees it at once.
	f.set(ollamaURL, false)
	p, err := svc.Recheck(context.Background(), providers.IDOllama)
	if err != nil || p.State != providers.StateReady {
		t.Fatalf("recheck = %+v, %v", p, err)
	}
	// Stopped again: the positive result stands for a minute, then a background probe notices.
	f.set(ollamaURL, true)
	now = now.Add(30 * time.Second)
	if byID(t, svc.Snapshot(), providers.IDOllama).State != providers.StateReady {
		t.Fatal("a fresh positive result was not kept")
	}
	now = now.Add(time.Minute)
	svc.Snapshot() // stale: probes again in the background
	svc.WaitIdle()
	if s := byID(t, svc.Snapshot(), providers.IDOllama).State; s != providers.StateNotRunning {
		t.Fatalf("after the background probe state = %q", s)
	}
}

// The built-in loop on a local base URL (a gateway, LM Studio, the mock model) is probed the same way; the Anthropic
// API and a remote gateway are not.
func TestLocalAPIBaseURLIsProbed(t *testing.T) {
	const local = "http://127.0.0.1:8791"
	svc, f := reachRig(t, local, nil)
	f.set(local, true)
	api := byID(t, svc.Snapshot(), providers.IDAPI)
	if api.State != providers.StateNotRunning || api.Problem == nil || api.Problem.Code != usererr.CodeProviderNotRunning || api.Problem.Command != "" {
		t.Fatalf("api = %+v", api)
	}
	f.set(local, false)
	if p, err := svc.Recheck(context.Background(), providers.IDAPI); err != nil || p.State != providers.StateReady {
		t.Fatalf("recheck api = %+v, %v", p, err)
	}

	remote, rf := reachRig(t, "https://gateway.example.com", nil)
	if s := byID(t, remote.Snapshot(), providers.IDAPI).State; s != providers.StateReady || rf.n("https://gateway.example.com") != 0 {
		t.Fatalf("remote gateway state = %q probes = %d", s, rf.n("https://gateway.example.com"))
	}
}

// Without a probe (library embedders, older tests) nothing changes: Ollama is listed ready, its reach unchecked.
func TestNoReachProbeKeepsTheOldPicture(t *testing.T) {
	svc := providers.New(providers.Options{Ollama: func() (string, string) { return ollamaURL, "" }})
	ol := byID(t, svc.Snapshot(), providers.IDOllama)
	if ol.State != providers.StateReady || ol.Reach != providers.ReachUnchecked {
		t.Fatalf("ollama = %+v", ol)
	}
}
