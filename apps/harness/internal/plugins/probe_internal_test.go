package plugins

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"sync/atomic"
	"testing"
	"time"
)

func loadProbeRegistry(t *testing.T, probe string) *Registry {
	t.Helper()
	data := t.TempDir()
	dir := filepath.Join(data, "plugins", "p")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	manifest := `{"name":"p","version":"1","agents":[{"id":"a","command":"sh","auth":{"probe":` + probe + `,"hint":"login"}},` +
		`{"id":"plain","command":"sh"}]}`
	if err := os.WriteFile(filepath.Join(dir, ManifestName), []byte(manifest), 0o644); err != nil {
		t.Fatal(err)
	}
	return Load(context.Background(), data, nil, nil)
}

func loggedIn(t *testing.T, r *Registry, id string) *bool {
	t.Helper()
	a, ok := r.Agent(id)
	if !ok {
		t.Fatalf("agent %s missing", id)
	}
	return a.LoggedIn
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestProbeRunsOffPathAtMostOncePerMinute(t *testing.T) {
	r := loadProbeRegistry(t, `["sh","-c","true"]`)
	var calls atomic.Int32
	var clock atomic.Int64
	clock.Store(time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC).UnixNano())
	verdict := true
	release := make(chan struct{})
	r.probes.now = func() time.Time { return time.Unix(0, clock.Load()) }
	r.probes.run = func(_ context.Context, a Agent) ProbeReport {
		calls.Add(1)
		<-release
		v := verdict
		return ProbeReport{Ran: true, LoggedIn: &v}
	}

	r.Plugins() // no StartProbes yet: nothing runs
	if calls.Load() != 0 || loggedIn(t, r, "a") != nil {
		t.Fatalf("probing before StartProbes: calls=%d", calls.Load())
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	r.StartProbes(ctx)
	// The probe blocks; requests must still answer immediately with null.
	done := make(chan struct{})
	go func() {
		defer close(done)
		for _, p := range r.Plugins() {
			for _, a := range p.Agents {
				if a.LoggedIn != nil {
					t.Errorf("agent %s has a result before the probe finished", a.ID)
				}
			}
		}
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Plugins blocked on a running probe")
	}
	close(release)
	waitFor(t, "first probe", func() bool { v := loggedIn(t, r, "a"); return v != nil && *v })
	if loggedIn(t, r, "plain") != nil {
		t.Error("an agent without a probe must report null")
	}

	verdict = false
	for range 3 {
		r.Plugins()
	}
	clock.Add(int64(30 * time.Second))
	r.Plugins()
	time.Sleep(20 * time.Millisecond)
	if calls.Load() != 1 {
		t.Fatalf("probe ran %d times within a minute, want 1", calls.Load())
	}
	clock.Add(int64(31 * time.Second))
	r.Plugins()
	waitFor(t, "second probe", func() bool { v := loggedIn(t, r, "a"); return v != nil && !*v })
	if calls.Load() != 2 {
		t.Fatalf("calls = %d, want 2", calls.Load())
	}
}

func TestRunProbeOutcomes(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses sh")
	}
	old := probeTimeout
	probeTimeout = 300 * time.Millisecond
	t.Cleanup(func() { probeTimeout = old })
	tests := []struct {
		name  string
		probe string
		exits []int // the manifest's notLoggedInExit
		want  *bool
	}{
		{"exit 0", `["sh","-c","exit 0"]`, nil, boolPtr(true)},
		{"exit 1 the manifest lists as logged out", `["sh","-c","exit 1"]`, []int{1}, boolPtr(false)},
		{"exit 1 nobody documented: login not checked", `["sh","-c","exit 1"]`, nil, nil},
		{"exit 2 when only 1 is listed: login not checked", `["sh","-c","exit 2"]`, []int{1}, nil},
		{"not startable", `["definitely-not-a-command-xyz"]`, nil, nil},
		{"timeout", `["sh","-c","sleep 5"]`, []int{1}, nil},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			r := loadProbeRegistry(t, tc.probe)
			a, _ := r.Agent("a")
			a.ProbeNotLoggedInExit = tc.exits
			start := time.Now()
			got := runProbe(context.Background(), a)
			if time.Since(start) > 3*time.Second {
				t.Errorf("probe took %v", time.Since(start))
			}
			if (got == nil) != (tc.want == nil) || (got != nil && *got != *tc.want) {
				t.Fatalf("runProbe = %v, want %v", deref(got), deref(tc.want))
			}
		})
	}
}

func TestProbeSeesResolvedEnv(t *testing.T) {
	t.Setenv("OCTO_PROBE_SRC", "yes")
	data := t.TempDir()
	dir := filepath.Join(data, "plugins", "p")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	manifest := `{"name":"p","version":"1","agents":[{"id":"a","command":"sh","env":{"OCTO_PROBE_DST":"${OCTO_PROBE_SRC}"},
	  "auth":{"probe":["sh","-c","test \"$OCTO_PROBE_DST\" = yes"]}}]}`
	if err := os.WriteFile(filepath.Join(dir, ManifestName), []byte(manifest), 0o644); err != nil {
		t.Fatal(err)
	}
	a, _ := Load(context.Background(), data, nil, nil).Agent("a")
	if got := runProbe(context.Background(), a); got == nil || !*got {
		t.Fatalf("probe = %v, want logged in", deref(got))
	}
}

func deref(b *bool) any {
	if b == nil {
		return nil
	}
	return *b
}

func TestProbeEnvironmentIsScrubbed(t *testing.T) {
	t.Setenv("ANTHROPIC_API_KEY", "mock")
	t.Setenv("XAI_API_KEY", "declared")
	data := t.TempDir()
	dir := filepath.Join(data, "plugins", "p")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	manifest := `{"name":"p","version":"1","agents":[{"id":"a","command":"sh","env":{"XAI_API_KEY":"${XAI_API_KEY}"},
	  "auth":{"probe":["sh","-c","test -z \"$ANTHROPIC_API_KEY\" && test \"$XAI_API_KEY\" = declared"]}}]}`
	if err := os.WriteFile(filepath.Join(dir, ManifestName), []byte(manifest), 0o644); err != nil {
		t.Fatal(err)
	}
	a, _ := Load(context.Background(), data, nil, nil).Agent("a")
	if got := runProbe(context.Background(), a); got == nil || !*got {
		t.Fatalf("probe = %v, want logged in (scrubbed, declared key kept)", deref(got))
	}
}

// A probe or version check for an id that no longer exists (an account removed
// while a refresh still held the old agent list) starts nothing and leaves no state.
func TestProbesAndVersionChecksSkipRemovedIDs(t *testing.T) {
	ctx := context.Background()
	gone := Agent{ID: "cc@gone", Available: true, ProbeCommand: "sh", VersionCommand: "sh", VersionArgs: []string{"-c", "true"}, commandFound: true}
	p := newProber()
	p.ctx, p.alive = ctx, func(string) bool { return false }
	p.refresh([]Agent{gone})
	p.sync(ctx, gone, 0)
	v := newVersioner()
	v.ctx, v.alive = ctx, func(string) bool { return false }
	v.refresh([]Agent{gone})
	v.sync(ctx, gone)
	if len(p.state) != 0 || len(v.state) != 0 {
		t.Fatalf("state made for a removed id: %v %v", p.state, v.state)
	}
}
