package main

import (
	"os"
	"os/exec"
	"strings"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/buildinfo"
)

func TestHelperMain(t *testing.T) {
	if os.Getenv("HARNESS_TEST_HELPER_MAIN") != "1" {
		t.Skip("helper process")
	}
	os.Args = append([]string{"harness"}, strings.Fields(os.Getenv("HARNESS_TEST_ARGS"))...)
	main()
}

// `harness --version` and `harness version` print the version and exit 0; they never start anything.
func TestVersionFlag(t *testing.T) {
	for _, arg := range []string{"--version", "version", "-v"} {
		cmd := exec.Command(os.Args[0], "-test.run=^TestHelperMain$")
		cmd.Env = append(os.Environ(), "HARNESS_TEST_HELPER_MAIN=1", "HARNESS_TEST_ARGS="+arg)
		out, err := cmd.CombinedOutput()
		if err != nil || !strings.Contains(string(out), "harness "+buildinfo.Version) {
			t.Fatalf("harness %s: %v\n%s", arg, err, out)
		}
	}
}
