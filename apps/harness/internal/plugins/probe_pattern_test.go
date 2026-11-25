package plugins

import (
	"context"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// fakeProbe writes a script that prints text and exits with code.
func fakeProbe(t *testing.T, text string, code int) Agent {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "probe.sh")
	script := "#!/bin/sh\nprintf '%s\\n' '" + text + "'\nexit " + string(rune('0'+code)) + "\n"
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return Agent{ID: "x", Available: true, ProbeCommand: path}
}

func TestProbeOutputPatternAppliesToNonZeroExitsOnly(t *testing.T) {
	pat := regexp.MustCompile(`(?i)not authenticated`)
	for _, tc := range []struct {
		name    string
		text    string
		code    int
		pattern *regexp.Regexp
		want    bool
	}{
		{"logged in, pattern does not match", "grok 1.0.77: model list", 0, pat, true},
		{"exit 0 always wins, whatever the output says", "You are not authenticated.", 0, pat, true},
		{"without a pattern exit 0 is logged in", "You are not authenticated.", 0, nil, true},
		{"non-zero exit that prints the signal is logged out", "You are not authenticated.", 1, pat, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a := fakeProbe(t, tc.text, tc.code)
			a.ProbeNotLoggedIn = tc.pattern
			got := a.Probe(context.Background())
			if got == nil || *got != tc.want {
				t.Fatalf("probe = %v, want %v", got, tc.want)
			}
			rep := a.ProbeNow(context.Background())
			if rep.LoggedIn == nil || *rep.LoggedIn != tc.want {
				t.Fatalf("ProbeNow = %+v", rep)
			}
		})
	}
}

// A probe that fails or prints something unexpected does not make the agent
// unavailable: the login is unchecked (nil), with the reason kept for diagnostics.
func TestUnexpectedProbeOutcomesLeaveLoginUnchecked(t *testing.T) {
	pat := regexp.MustCompile(`(?i)not authenticated`)
	for _, tc := range []struct {
		name  string
		text  string
		code  int
		exits []int
	}{
		{"unexpected output, exit 0 is fine", "grok 1.0.77", 0, nil},
		{"unexpected non-zero exit", "Segmentation fault", 3, nil},
		{"exit 1 that is not documented", "boom", 1, nil},
		{"exit 3 with only 1 documented", "boom", 3, []int{1}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a := fakeProbe(t, tc.text, tc.code)
			a.ProbeNotLoggedIn, a.ProbeNotLoggedInExit = pat, tc.exits
			rep := a.ProbeNow(context.Background())
			if tc.code == 0 {
				if rep.LoggedIn == nil || !*rep.LoggedIn {
					t.Fatalf("exit 0 = %+v, want logged in", rep)
				}
				return
			}
			if rep.LoggedIn != nil || !strings.Contains(rep.Reason, "login not checked") || strings.Contains(rep.Reason, tc.text) {
				t.Fatalf("report = %+v, want unchecked with a reason that does not quote the output", rep)
			}
		})
	}
	// A listed exit status is a positive "logged out".
	a := fakeProbe(t, "boom", 1)
	a.ProbeNotLoggedInExit = []int{1}
	if got := a.Probe(context.Background()); got == nil || *got {
		t.Fatalf("listed exit = %v, want false", got)
	}
}
