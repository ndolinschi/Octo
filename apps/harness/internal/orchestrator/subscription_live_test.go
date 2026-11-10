//go:build subscription

package orchestrator_test

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/mockllm"
	"github.com/ndolinschi/Octo/apps/harness/internal/orchestrator"
	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

const liveRunLimit = 6 * time.Minute

// TestSubscriptionAgents runs one real sub-agent per vendor CLI on the
// subscription it is logged in to. Each is opt-in (OCTO_TEST_COPILOT=1,
// OCTO_TEST_GROK=1, OCTO_TEST_CODEX=1) and skips, saying why, when the CLI is
// missing or its probe reports logged out. A run uses the plan's quota.
func TestSubscriptionAgents(t *testing.T) {
	cases := []struct{ id, envSwitch string }{
		{"copilot", "OCTO_TEST_COPILOT"},
		{"grok", "OCTO_TEST_GROK"},
		{"codex", "OCTO_TEST_CODEX"},
	}
	for _, tc := range cases {
		t.Run(tc.id, func(t *testing.T) {
			if os.Getenv(tc.envSwitch) != "1" {
				t.Skipf("%s is not 1: live %s run not requested", tc.envSwitch, tc.id)
			}
			ag := liveAgent(t, tc.id)
			runLiveAgent(t, ag)
		})
	}
}

// liveAgent loads the example manifest and returns the agent, or skips.
func liveAgent(t *testing.T, id string) plugins.Agent {
	t.Helper()
	reg := plugins.Load(context.Background(), t.TempDir(), []string{filepath.Join("..", "..", "plugins-examples", "subscription-agents")}, nil)
	ag, ok := reg.Agent(id)
	if !ok {
		t.Fatalf("agent %q is not in plugins-examples/subscription-agents", id)
	}
	if !ag.Available {
		t.Skipf("%s: command %q is not on PATH; install it (see README, Running on subscriptions)", id, ag.Command)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*plugins.ProbeTimeout)
	defer cancel()
	switch v := ag.Probe(ctx); {
	case v == nil:
		t.Logf("%s: no login probe result; assuming it is logged in", id)
	case !*v:
		t.Skipf("%s: logged out. %s", id, ag.Hint)
	}
	return ag
}

func runLiveAgent(t *testing.T, ag plugins.Agent) {
	t.Helper()
	marker := fmt.Sprintf("octo-marker-%d", time.Now().UnixNano())
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "OCTO_MARKER.txt"), []byte(marker+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	r := newACPRig(t, mockllm.New(0), ag)
	pid := r.projectAt(t, dir)
	got := r.runCollectFor(t, liveRunLimit, pid, "[acp] Read OCTO_MARKER.txt in the project folder, then reply with the exact marker string inside it.", nil)
	if got.status != "completed" {
		t.Fatalf("turn = %s", got.status)
	}
	child := r.acpChild(t, pid)
	if child.Status != projectstore.StatusCompleted || child.Result == nil {
		errText := ""
		if child.Error != nil {
			errText = *child.Error
		}
		t.Fatalf("sub-agent status = %s, error = %q", child.Status, errText)
	}
	if !strings.HasPrefix(child.Model, orchestrator.ACPModelPrefix+ag.ID) {
		t.Errorf("recorded model = %q", child.Model)
	}

	assistant, readFile := false, false
	for _, m := range r.transcript(t, pid, child.ID) {
		for _, b := range m.Content {
			switch {
			case m.Role == "assistant" && b.Type == "text" && strings.TrimSpace(*b.Text) != "":
				assistant = true
			case b.Type == "tool_use" && strings.Contains(string(b.Input), "OCTO_MARKER.txt"):
				readFile = true
			}
		}
	}
	if !assistant {
		t.Error("the transcript has no assistant message")
	}
	if !strings.Contains(*child.Result, marker) && !readFile {
		t.Errorf("answer %q does not hold the marker %q and no tool call touched OCTO_MARKER.txt", *child.Result, marker)
	}
	t.Logf("%s answered: %s", ag.ID, strings.TrimSpace(*child.Result))
}
