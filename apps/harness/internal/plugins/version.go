package plugins

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/childenv"
)

// Version check pacing: a CLI's version is read at most once per
// VersionInterval in the background (a recheck forces it) and the command is
// killed after VersionTimeout.
const (
	VersionInterval = 10 * time.Minute
	VersionTimeout  = 5 * time.Second
)

// versionTimeout is VersionTimeout; tests shorten it.
var versionTimeout = VersionTimeout

// versionNumber finds the first dotted version (1.5, 1.5.0, 2026.11.05) in a
// command's output; a leading "v" is allowed.
var versionNumber = regexp.MustCompile(`(?:^|[^0-9A-Za-z.])v?(\d+)\.(\d+)(?:\.(\d+))?`)

// manifestVersion is a manifest's `version`: a command that prints the CLI's
// version (it must not log in or start a session) and the lowest version the
// launch command works with.
type manifestVersion struct {
	Command []string `json:"command"`
	Min     string   `json:"min"`
}

func (v manifestVersion) validate() error {
	switch {
	case len(v.Command) == 0 || strings.TrimSpace(v.Command[0]) == "":
		return fmt.Errorf("version.command must name a command")
	case strings.TrimSpace(v.Min) == "":
		return fmt.Errorf("version.min is required")
	}
	if _, ok := ParseVersion(v.Min); !ok {
		return fmt.Errorf("version.min %q is not a dotted version such as 1.5.0", v.Min)
	}
	return nil
}

// ParseVersion reads the first dotted version in s as up to three numbers
// (a missing patch is 0). False when s holds none.
func ParseVersion(s string) ([3]int, bool) {
	m := versionNumber.FindStringSubmatch(s)
	if m == nil {
		return [3]int{}, false
	}
	var v [3]int
	for i := 0; i < 3; i++ {
		if m[i+1] == "" {
			continue
		}
		n, err := strconv.Atoi(m[i+1])
		if err != nil {
			return [3]int{}, false
		}
		v[i] = n
	}
	return v, true
}

// versionLess reports a < b.
func versionLess(a, b [3]int) bool {
	for i := 0; i < 3; i++ {
		if a[i] != b[i] {
			return a[i] < b[i]
		}
	}
	return false
}

func versionString(v [3]int) string { return fmt.Sprintf("%d.%d.%d", v[0], v[1], v[2]) }

// VersionReport is the outcome of one version check, for diagnostics and for
// telling the user that the installed CLI is too old before it is started.
type VersionReport struct {
	// Ran is false when the agent has no version check or it did not run yet.
	Ran bool `json:"ran"`
	// Version is the version read from the command's output ("" when none was found).
	Version string `json:"version,omitempty"`
	// Min is the manifest's lowest working version.
	Min string `json:"min,omitempty"`
	// TooOld: Version was read and is lower than Min. Never true on a guess:
	// an output without a version, a failure or a timeout leave it false.
	TooOld bool `json:"too_old"`
	// Reason says what happened, never quoting the output beyond the version.
	Reason string `json:"reason"`
	// At is when the check finished (RFC 3339).
	At string `json:"at,omitempty"`
}

// HasVersionCheck reports whether the manifest gives a version command.
func (a Agent) HasVersionCheck() bool { return a.VersionCommand != "" && a.MinVersion != "" }

// CheckVersion runs the agent's version command once, synchronously, with the
// child environment, and compares what it prints with the manifest's minimum.
// Used by the registry (background, cached) and by `harness doctor`.
func (a Agent) CheckVersion(ctx context.Context) VersionReport {
	switch {
	case !a.HasVersionCheck():
		return VersionReport{Reason: "this agent has no version check"}
	case a.Unsupported != "":
		return VersionReport{Reason: "not run: the agent is not supported"}
	}
	rep := VersionReport{Ran: true, Min: a.MinVersion}
	vctx, cancel := context.WithTimeout(ctx, versionTimeout)
	defer cancel()
	cmd := exec.CommandContext(vctx, a.VersionCommand, a.VersionArgs...)
	cmd.Dir = probeDir(a)
	cmd.Env = childenv.Build(os.Environ(), a.ResolvedEnv())
	cmd.WaitDelay = time.Second
	var out capped
	cmd.Stdout, cmd.Stderr = &out, &out
	err := cmd.Run()
	label := strings.Join(append([]string{baseName(a.VersionCommand)}, a.VersionArgs...), " ")
	switch {
	case vctx.Err() != nil && ctx.Err() == nil:
		rep.Reason = fmt.Sprintf("`%s` timed out: version not checked", label)
		return rep
	case err != nil && out.b == nil:
		rep.Reason = fmt.Sprintf("`%s` could not be run: version not checked", label)
		return rep
	}
	have, ok := ParseVersion(string(out.b))
	if !ok {
		rep.Reason = fmt.Sprintf("`%s` printed no version number: version not checked", label)
		return rep
	}
	min, _ := ParseVersion(a.MinVersion)
	rep.Version = versionString(have)
	if versionLess(have, min) {
		rep.TooOld = true
		rep.Reason = fmt.Sprintf("version %s is older than %s, the lowest that works with Octo", rep.Version, a.MinVersion)
		return rep
	}
	rep.Reason = fmt.Sprintf("version %s (needs %s or newer)", rep.Version, a.MinVersion)
	return rep
}

func baseName(p string) string {
	if i := strings.LastIndexAny(p, `/\`); i >= 0 {
		return p[i+1:]
	}
	return p
}

// versioner caches version checks the way prober caches login probes:
// background refreshes never block a reader; a recheck runs one now.
type versioner struct {
	now func() time.Time
	run func(ctx context.Context, a Agent) VersionReport

	mu       sync.Mutex
	ctx      context.Context
	state    map[string]*versionState
	onChange func()
	alive    func(id string) bool // as prober.alive
}

type versionState struct {
	at      time.Time
	running bool
	wait    chan struct{}
	report  VersionReport
}

func newVersioner() *versioner {
	return &versioner{now: time.Now, run: func(ctx context.Context, a Agent) VersionReport { return a.CheckVersion(ctx) }, state: map[string]*versionState{}}
}

func (v *versioner) stateOf(id string) *versionState {
	st := v.state[id]
	if st == nil {
		st = &versionState{}
		v.state[id] = st
	}
	return st
}

func (v *versioner) report(id string) VersionReport {
	v.mu.Lock()
	defer v.mu.Unlock()
	if st := v.state[id]; st != nil {
		return st.report
	}
	return VersionReport{}
}

// checkable: an agent whose program was found and that has a version check.
func checkable(a Agent) bool { return a.HasVersionCheck() && a.Unsupported == "" && a.commandFound }

func (v *versioner) refresh(agents []Agent) {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.ctx == nil || v.ctx.Err() != nil {
		return
	}
	for _, a := range agents {
		if !checkable(a) || (v.alive != nil && !v.alive(a.ID)) {
			continue
		}
		st := v.stateOf(a.ID)
		if st.running || (!st.at.IsZero() && v.now().Sub(st.at) < VersionInterval) {
			continue
		}
		st.running, st.at, st.wait = true, v.now(), make(chan struct{})
		go v.finish(v.ctx, a, st)
	}
}

func (v *versioner) finish(ctx context.Context, a Agent, st *versionState) {
	rep := v.run(ctx, a)
	rep.At = v.now().UTC().Format(time.RFC3339)
	v.mu.Lock()
	changed := st.report.TooOld != rep.TooOld || st.report.Version != rep.Version
	st.report, st.running = rep, false
	close(st.wait)
	notify := v.onChange
	v.mu.Unlock()
	if changed && notify != nil {
		notify()
	}
}

// sync checks a now, joining a check already running.
func (v *versioner) sync(ctx context.Context, a Agent) {
	if !checkable(a) {
		return
	}
	v.mu.Lock()
	if v.alive != nil && !v.alive(a.ID) {
		v.mu.Unlock()
		return
	}
	st := v.stateOf(a.ID)
	if st.running {
		w := st.wait
		v.mu.Unlock()
		select {
		case <-w:
		case <-ctx.Done():
		}
		return
	}
	st.running, st.at, st.wait = true, v.now(), make(chan struct{})
	v.mu.Unlock()
	v.finish(context.WithoutCancel(ctx), a, st)
}
