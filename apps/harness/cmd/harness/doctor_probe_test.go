package main

import (
	"os"
	"os/exec"
	"strings"
	"testing"
)

// Decision 2026-11-12 rule 5: doctor says which rule decided, the exit status,
// the duration and the variable names; the probe's output only with
// --show-probe-output, and never in JSON.
func TestDoctorExplainsTheProbeAndShowsOutputOnlyOnRequest(t *testing.T) {
	plugins := fakePlugins(t)
	run := func(extra string) string {
		cmd := exec.Command(os.Args[0], "-test.run=^TestHelperDoctor$")
		cmd.Env = []string{
			"HARNESS_TEST_HELPER_DOCTOR=1", "HARNESS_NO_BUILTIN_PLUGINS=1", "PATH=/bin:/usr/bin", "HOME=/home/secret-home-value",
			"HARNESS_TEST_ARGS=--data-dir " + t.TempDir() + " --plugins-dir " + plugins + " " + extra,
		}
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("doctor: %v\n%s", err, out)
		}
		return string(out)
	}
	plain := run("")
	for _, want := range []string{"probe decided by: exit_status; exit status: 1; took ", "probe environment (names only): ", "HOME", "PATH"} {
		if !strings.Contains(plain, want) {
			t.Errorf("doctor output lacks %q:\n%s", want, plain)
		}
	}
	for _, not := range []string{"PROBE-OUTPUT-MARKER", "secret-home-value"} {
		if strings.Contains(plain, not) {
			t.Errorf("doctor output contains %q without being asked", not)
		}
	}
	shown := run("--show-probe-output")
	if !strings.Contains(shown, "| PROBE-OUTPUT-MARKER") || strings.Contains(shown, "secret-home-value") {
		t.Errorf("--show-probe-output:\n%s", shown)
	}
	if js := run("--json --show-probe-output"); strings.Contains(js, "PROBE-OUTPUT-MARKER") || !strings.Contains(js, `"rule": "exit_status"`) {
		t.Errorf("json must carry the rule and never the output:\n%s", js)
	}
}
