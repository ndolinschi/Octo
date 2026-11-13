package orchestrator

import (
	"context"
	goruntime "runtime"
	"strings"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/acp"
	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
	"github.com/ndolinschi/Octo/apps/harness/internal/usererr"
)

// An agent whose launch command the CLI rejects exits with a usage error
// before `initialize`: the turn error names the command and quotes the first
// stderr line, never the raw connection chain.
func TestRejectedLaunchArgumentsAreExplained(t *testing.T) {
	if goruntime.GOOS == "windows" {
		t.Skip("uses sh")
	}
	script := `echo 'Error: unexpected argument "acp". Prompts are read only from -p/--print' >&2; echo 'Usage: fake [OPTIONS]' >&2; exit 2`
	ag := plugins.Agent{ID: "fake", Label: "Fake CLI", Launch: plugins.Launch{Command: "sh", Args: []string{"-c", script}}}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_, err := acp.Start(ctx, acp.Spec{Command: ag.Command, Args: ag.ArgsFor(""), Name: ag.ID})
	if err == nil {
		t.Fatal("start succeeded")
	}
	got := describe(startFailure(acpTarget{agent: ag}, err))
	if got.Message != "Fake CLI did not start the way Octo asked." || got.Command != "sh --help" || got.Action != usererr.ActionUpdateAgent {
		t.Fatalf("got %+v", got)
	}
	if !strings.Contains(got.Details, "`sh -c ") || !strings.Contains(got.Details, `Error: unexpected argument "acp". Prompts are read only from -p/--print`) {
		t.Fatalf("details = %q", got.Details)
	}
	for _, raw := range []string{"acp initialize", "connection closed", "agent exited"} {
		if strings.Contains(got.Message, raw) || strings.Contains(got.Hint, raw) || strings.Contains(got.Details, raw) {
			t.Errorf("raw chain %q leaked: %+v", raw, got)
		}
	}
}

// A crash that is not an argument error keeps the old wording, and a long
// stderr line is cut.
func TestOtherStartFailuresAreNotMistakenForUsageErrors(t *testing.T) {
	ag := plugins.Agent{ID: "fake", Label: "Fake CLI", Launch: plugins.Launch{Command: "/usr/bin/fake"}}
	crash := &testErr{"acp initialize: acp: connection closed: agent exited: exit status 1 (stderr: Segmentation fault)"}
	if u := launchRejection(ag, crash); u != nil {
		t.Fatalf("a crash was called a rejection: %v", u)
	}
	long := &testErr{"acp initialize: acp: connection closed: agent exited: exit status 2 (stderr: unknown option " + strings.Repeat("x", 500) + ")"}
	u := launchRejection(ag, long)
	if u == nil || len([]rune(u.Details)) > 700 || !strings.Contains(u.Details, "`fake`") {
		t.Fatalf("long line: %v", u)
	}
}

func TestStartHintLeadsTheHint(t *testing.T) {
	ag := plugins.Agent{ID: "agy", Label: "Antigravity", StartHint: "Your agy version may predate ACP support. Update it (`agy update`) and check `agy acp --help`.",
		Launch: plugins.Launch{Command: "/usr/bin/agy", Args: []string{"acp"}}}
	err := &testErr{"acp initialize: acp: connection closed: agent exited: exit status 2 (stderr: error: unrecognized subcommand 'acp')"}
	u := launchRejection(ag, err)
	if u == nil || !strings.HasPrefix(u.Details, ag.StartHint) || !strings.Contains(u.Details, "`agy acp`") {
		t.Fatalf("got %+v", u)
	}
}

type testErr struct{ s string }

func (e *testErr) Error() string { return e.s }
