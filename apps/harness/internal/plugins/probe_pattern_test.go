package plugins

import (
	"context"
	"os"
	"path/filepath"
	"regexp"
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

func TestProbeOutputPatternTurnsExitZeroIntoLoggedOut(t *testing.T) {
	pat := regexp.MustCompile(`(?i)not authenticated`)
	for _, tc := range []struct {
		name    string
		text    string
		code    int
		pattern *regexp.Regexp
		want    bool
	}{
		{"logged in, pattern does not match", "grok 1.0.77: model list", 0, pat, true},
		{"exit 0 but says not authenticated", "You are not authenticated.", 0, pat, false},
		{"without a pattern exit 0 is logged in", "You are not authenticated.", 0, nil, true},
		{"non-zero exit is logged out whatever it prints", "all good", 1, pat, false},
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
