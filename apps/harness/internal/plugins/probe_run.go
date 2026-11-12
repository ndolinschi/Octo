package plugins

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/childenv"
)

// Rules that can decide a probe (ProbeReport.Rule).
const (
	RulePattern    = "pattern"     // non-zero exit and the output matched notLoggedInPattern: logged out
	RuleExitStatus = "exit_status" // a status the manifest lists in notLoggedInExit: logged out
	RuleExit0      = "exit_0"      // exit 0: logged in, whatever the output says
	RuleOtherExit  = "other_exit"  // non-zero exit nothing documents: unknown
	RuleTimeout    = "timeout"     // killed after ProbeTimeout: unknown
	RuleNotStarted = "not_started" // the command could not be started: unknown
	RuleNone       = "none"        // no probe, or not run
)

// outputLines is how many lines of a probe's output a report keeps for
// `harness doctor --show-probe-output`.
const outputLines = 20

// runProbe executes the manifest's probe command. Exit 0 is logged in, always:
// output is never read on a successful exit. Only a non-zero exit can say
// "logged out": its output matches the agent's notLoggedInPattern, or its status
// is one the manifest lists in auth.notLoggedInExit. Any other outcome (another
// exit status, a timeout, a probe that cannot start) is unknown (nil): the agent
// stays usable with its login "unchecked".
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
	env := childenv.Build(os.Environ(), a.ResolvedEnv())
	cmd := exec.CommandContext(pctx, a.ProbeCommand, a.ProbeArgs...)
	cmd.Dir = probeDir(a)
	cmd.Env = env
	cmd.WaitDelay = time.Second
	var out capped
	cmd.Stdout, cmd.Stderr = &out, &out
	start := time.Now()
	err := cmd.Run()
	rep := ProbeReport{Ran: true, Rule: RuleNone, DurationMS: time.Since(start).Milliseconds(), Dir: cmd.Dir,
		EnvNames: envNames(env), Output: firstLines(out.b, outputLines)}
	var exit *exec.ExitError
	switch {
	case err == nil:
		code := 0
		rep.LoggedIn, rep.Rule, rep.ExitStatus, rep.Reason = boolPtr(true), RuleExit0, &code, "the probe exited 0"
	case errors.As(err, &exit) && pctx.Err() == nil:
		code := exit.ExitCode()
		rep.ExitStatus = &code
		switch {
		case a.ProbeNotLoggedIn != nil && a.ProbeNotLoggedIn.Match(out.b):
			rep.LoggedIn, rep.Rule = boolPtr(false), RulePattern
			rep.Reason = fmt.Sprintf("the probe exited with status %d and its output says the agent is not logged in", code)
		case slices.Contains(a.ProbeNotLoggedInExit, code):
			rep.LoggedIn, rep.Rule = boolPtr(false), RuleExitStatus
			rep.Reason = fmt.Sprintf("the probe exited with status %d, which the manifest lists as logged out", code)
		default:
			rep.Rule = RuleOtherExit
			rep.Reason = fmt.Sprintf("the probe exited with status %d, which the manifest does not list as logged out: login not checked", code)
		}
	case pctx.Err() != nil:
		rep.Rule, rep.Reason = RuleTimeout, "the probe timed out: login not checked"
	default:
		rep.Rule, rep.Reason = RuleNotStarted, "the probe could not be started: login not checked"
	}
	return rep
}

// probeDir is the plugin's directory, or for a built-in agent (no directory) the
// user's home, where a terminal starts: the harness's own working directory is
// whatever the desktop app was started in (often "/").
func probeDir(a Agent) string {
	if a.Launch.Dir != "" {
		return a.Launch.Dir
	}
	home, err := os.UserHomeDir()
	if fi, serr := os.Stat(home); err != nil || serr != nil || !fi.IsDir() {
		return ""
	}
	return home
}

func envNames(env []string) []string {
	names := make([]string, 0, len(env))
	for _, kv := range env {
		if name, _, ok := strings.Cut(kv, "="); ok {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	return slices.Compact(names)
}

func firstLines(b []byte, n int) []string {
	var out []string
	sc := bufio.NewScanner(bytes.NewReader(b))
	for len(out) < n && sc.Scan() {
		out = append(out, sc.Text())
	}
	return out
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
	// Rule says which rule decided: pattern, exit_status, exit_0, other_exit,
	// timeout, not_started or none.
	Rule string `json:"rule"`
	// ExitStatus is the probe's exit status (nil when it did not exit: timeout,
	// not started, not run).
	ExitStatus *int `json:"exit_status"`
	// DurationMS is how long the probe ran.
	DurationMS int64 `json:"duration_ms"`
	// Dir is the working directory the probe ran in.
	Dir string `json:"dir,omitempty"`
	// EnvNames are the names (never the values) of the environment variables the
	// probe was given.
	EnvNames []string `json:"env_names"`
	// At is when the probe finished (RFC 3339; background results only).
	At string `json:"at,omitempty"`
	// Output is the first lines of the probe's output. It never leaves the
	// process in JSON: only `harness doctor --show-probe-output` prints it.
	Output []string `json:"-"`
}

// ProbeNow runs the login probe once, synchronously, and says why it came out
// as it did. Used by `harness doctor`; the server never calls it on a request.
func (a Agent) ProbeNow(ctx context.Context) ProbeReport {
	switch {
	case a.ProbeCommand == "":
		return ProbeReport{Rule: RuleNone, Reason: "this agent has no login probe", EnvNames: []string{}}
	case !a.Available:
		return ProbeReport{Rule: RuleNone, Reason: "not run: the agent is not available", EnvNames: []string{}}
	}
	return probeOnce(ctx, a)
}

// LastProbe describes the cached background result, without running anything.
func (a Agent) LastProbe() ProbeReport {
	switch {
	case a.ProbeCommand == "":
		return ProbeReport{Rule: RuleNone, Reason: "this agent has no login probe", EnvNames: []string{}}
	case a.LastReport.Ran:
		return a.LastReport
	}
	return ProbeReport{Rule: RuleNone, Reason: "no result yet", EnvNames: []string{}}
}
