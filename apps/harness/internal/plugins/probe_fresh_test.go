package plugins

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"sync/atomic"
	"testing"
	"time"
)

// markerRegistry loads an agent whose probe succeeds while the marker file
// exists and exits 1 (listed as logged out) while it does not.
func markerRegistry(t *testing.T) (*Registry, string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("uses sh")
	}
	data := t.TempDir()
	marker := filepath.Join(data, "logged-in")
	dir := filepath.Join(data, "plugins", "p")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	manifest := `{"name":"p","version":"1","agents":[{"id":"a","command":"sh","auth":{"probe":["sh","-c","test -f ` + marker + `"],"notLoggedInExit":[1],"hint":"login"}}]}`
	if err := os.WriteFile(filepath.Join(dir, ManifestName), []byte(manifest), 0o644); err != nil {
		t.Fatal(err)
	}
	return Load(context.Background(), data, nil, nil), marker
}

// Rule 1 and 3: a request about to be refused re-probes, a probe younger than
// FreshProbeAge stands, and Recheck always probes.
func TestFreshAndRecheckSeeALoginMadeSinceTheLastProbe(t *testing.T) {
	r, marker := markerRegistry(t)
	var clock atomic.Int64
	clock.Store(time.Date(2026, 11, 12, 12, 0, 0, 0, time.UTC).UnixNano())
	r.probes.now = func() time.Time { return time.Unix(0, clock.Load()) }
	var runs atomic.Int32
	real := r.probes.run
	r.probes.run = func(ctx context.Context, a Agent) ProbeReport { runs.Add(1); return real(ctx, a) }
	var changes atomic.Int32
	r.OnProbeChange(func() { changes.Add(1) })

	a, ok := r.Fresh(context.Background(), "a") // works before StartProbes
	if !ok || a.LoggedIn == nil || *a.LoggedIn || a.LastReport.Rule != RuleExitStatus {
		t.Fatalf("first fresh = %+v ok=%v", a.LastReport, ok)
	}
	if err := os.WriteFile(marker, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	// Younger than 5 s: the old answer stands, nothing runs.
	clock.Add(int64(2 * time.Second))
	if a, _ = r.Fresh(context.Background(), "a"); *a.LoggedIn || runs.Load() != 1 {
		t.Fatalf("a 2 s old result must stand: runs=%d", runs.Load())
	}
	// Older than 5 s: probed again, and the login shows.
	clock.Add(int64(4 * time.Second))
	if a, _ = r.Fresh(context.Background(), "a"); a.LoggedIn == nil || !*a.LoggedIn || runs.Load() != 2 {
		t.Fatalf("fresh after 6 s: %v runs=%d", a.LoggedIn, runs.Load())
	}
	if changes.Load() != 2 {
		t.Fatalf("changes = %d, want 2 (the first result, then the login)", changes.Load())
	}
	// Recheck ignores the age.
	if err := os.Remove(marker); err != nil {
		t.Fatal(err)
	}
	if a, _ = r.Recheck(context.Background(), "a"); *a.LoggedIn || runs.Load() != 3 {
		t.Fatalf("recheck: %v runs=%d", a.LoggedIn, runs.Load())
	}
	if _, ok := r.Recheck(context.Background(), "nope"); ok {
		t.Fatal("unknown agent")
	}
}

// Rule 2: a "not logged in" result is looked at again after 15 s, a positive
// one only after a minute.
func TestNegativeResultsExpireFast(t *testing.T) {
	r, marker := markerRegistry(t)
	var clock atomic.Int64
	clock.Store(time.Date(2026, 11, 12, 12, 0, 0, 0, time.UTC).UnixNano())
	r.probes.now = func() time.Time { return time.Unix(0, clock.Load()) }
	var runs atomic.Int32
	real := r.probes.run
	r.probes.run = func(ctx context.Context, a Agent) ProbeReport { runs.Add(1); return real(ctx, a) }
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	r.StartProbes(ctx)
	waitFor(t, "first probe", func() bool { v := loggedIn(t, r, "a"); return v != nil && !*v })

	clock.Add(int64(10 * time.Second))
	r.Agents()
	time.Sleep(50 * time.Millisecond)
	if runs.Load() != 1 {
		t.Fatalf("re-probed after 10 s: runs=%d", runs.Load())
	}
	if err := os.WriteFile(marker, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	clock.Add(int64(6 * time.Second))
	r.Agents()
	waitFor(t, "the login to show", func() bool { v := loggedIn(t, r, "a"); return v != nil && *v })

	clock.Add(int64(20 * time.Second))
	r.Agents()
	time.Sleep(50 * time.Millisecond)
	if runs.Load() != 2 {
		t.Fatalf("a positive result was re-probed after 20 s: runs=%d", runs.Load())
	}
}

// Rule 5: the report says which rule decided, the exit status, the duration and
// the names (not the values) of the variables; the output is kept out of JSON.
func TestProbeReportExplainsItself(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	a := fakeProbe(t, "You are not authenticated.", 1)
	a.ProbeNotLoggedInExit = []int{1}
	rep := a.ProbeNow(context.Background())
	if rep.Rule != RuleExitStatus || rep.ExitStatus == nil || *rep.ExitStatus != 1 || rep.LoggedIn == nil || *rep.LoggedIn {
		t.Fatalf("report = %+v", rep)
	}
	if rep.Dir != home {
		t.Fatalf("a built-in agent's probe runs in the user's home like a terminal: dir = %q", rep.Dir)
	}
	if !slices.Contains(rep.EnvNames, "HOME") || !slices.Contains(rep.EnvNames, "PATH") {
		t.Fatalf("env names = %v", rep.EnvNames)
	}
	if len(rep.Output) != 1 || rep.Output[0] != "You are not authenticated." {
		t.Fatalf("output = %q", rep.Output)
	}
	ok := fakeProbe(t, "fine", 0)
	if r := ok.ProbeNow(context.Background()); r.Rule != RuleExit0 || r.ExitStatus == nil || *r.ExitStatus != 0 {
		t.Fatalf("exit 0 report = %+v", r)
	}
}
