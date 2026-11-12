package orchestrator

import (
	"errors"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/ndolinschi/Octo/apps/harness/internal/acp"
	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
	"github.com/ndolinschi/Octo/apps/harness/internal/usererr"
)

// usageRejection matches what a CLI prints when it does not know the arguments
// it was started with (a launch command written from documentation).
var usageRejection = regexp.MustCompile(`(?i)unexpected argument|unknown (command|option|flag|subcommand|argument)|unrecognized|invalid (option|flag|argument)|no such (command|option)|\busage:`)

const maxStderrLine = 200

// launchRejection recognises an agent that exited during `initialize` and whose
// stderr is an argument or usage error, and says so in words that name the
// command, instead of the raw "acp initialize: acp: connection closed: ..."
// chain. The stderr tail in err was redacted when it was read.
func launchRejection(ag plugins.Agent, err error) *usererr.Error {
	text := err.Error()
	if !strings.Contains(text, "acp initialize") || !strings.Contains(text, "agent exited") {
		return nil
	}
	_, tail, ok := strings.Cut(text, "(stderr: ")
	if !ok || !usageRejection.MatchString(tail) {
		return nil
	}
	first := strings.TrimSuffix(strings.TrimSpace(tail), ")")
	var exit *acp.ExitError
	if errors.As(err, &exit) && exit.StderrFirst != "" {
		first = exit.StderrFirst
	}
	if r := []rune(first); len(r) > maxStderrLine {
		first = string(r[:maxStderrLine]) + "…"
	}
	cli := filepath.Base(ag.Command)
	cmd := strings.Join(append([]string{cli}, ag.ArgsFor("")...), " ")
	return usererr.AgentLaunchRejected(ag.Label, cli, "`"+cmd+"`: "+first, ag.StartHint).Caused(err)
}
