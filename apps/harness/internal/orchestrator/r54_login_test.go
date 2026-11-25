package orchestrator_test

import (
	"sync"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/mockllm"
	"github.com/ndolinschi/Octo/apps/harness/internal/orchestrator"
)

// R5-4: what a real session finds about an ACP agent's login is reported, so an
// agent without a reliable login probe (Copilot, Grok) stops reading "Ready"
// once a turn of it was refused for a missing login; a turn that ran marks it
// logged in again. Orchestrator and sub-agent paths both report.
func TestACPRunReportsTheAgentsLogin(t *testing.T) {
	for _, c := range []struct {
		name, orch, prompt string
		want               []string
	}{
		{"orchestrator refused", "acp:fake", "[auth-required] hi", []string{"fake=false"}},
		{"orchestrator ran", "acp:fake", "[live] go", []string{"fake=true"}},
		{"sub-agent refused", "", "[acp] [auth-required] hi", []string{"fake=false"}},
	} {
		t.Run(c.name, func(t *testing.T) {
			var mu sync.Mutex
			var got []string
			r := newACPRigOpts(t, mockllm.New(0), func(o *orchestrator.Options) {
				o.OnAgentLogin = func(id string, ok bool) {
					mu.Lock()
					defer mu.Unlock()
					v := "false"
					if ok {
						v = "true"
					}
					got = append(got, id+"="+v)
				}
			}, fakeAgent("fake", true))
			pid := r.supervisedProject(t, t.TempDir(), c.orch)
			r.runCollect(t, pid, c.prompt, nil)
			mu.Lock()
			defer mu.Unlock()
			if len(got) != len(c.want) || got[0] != c.want[0] {
				t.Fatalf("reported %v, want %v", got, c.want)
			}
		})
	}
}
