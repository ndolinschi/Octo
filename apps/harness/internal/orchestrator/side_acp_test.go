package orchestrator_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/config"
	"github.com/ndolinschi/Octo/apps/harness/internal/events"
	"github.com/ndolinschi/Octo/apps/harness/internal/fakeacp"
	"github.com/ndolinschi/Octo/apps/harness/internal/orchestrator"
	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
	"github.com/ndolinschi/Octo/apps/harness/internal/project"
)

// sideAgent is a fake agent with its own session ids and modes.
func sideAgent() plugins.Agent {
	a := fakeAgent("fake", true)
	a.Launch.Env[fakeacp.EnvUniqueSessions] = "1"
	a.Launch.Env[fakeacp.EnvModes] = "1"
	return a
}

type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *fakeClock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *fakeClock) advance(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

type sideRig struct {
	*rig
	pid   string
	clock *fakeClock
	up    *upstreamCounter
	dir   string
}

// newSideRig is a project whose orchestrator is the fake ACP agent, with no
// API key (the built-in loop is unavailable), like the owner's Copilot project.
func newSideRig(t *testing.T, models *config.Models) *sideRig {
	t.Helper()
	up := &upstreamCounter{}
	clock := &fakeClock{t: time.Date(2026, 11, 12, 9, 0, 0, 0, time.UTC)}
	r := newRigWith(t, up, orchestrator.Options{
		Agents: []plugins.Agent{sideAgent()}, BuiltinUnavailable: config.NoBuiltinLoopMessage,
		SideIdle: 15 * time.Minute, Clock: clock.now,
	})
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("# hello\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	name := "p"
	in := project.Input{Name: &name, Folders: &[]project.FolderInput{{Path: dir}}, Models: models}
	p, err := r.svcWithAgents(t, sideAgent()).Create(context.Background(), in)
	if err != nil {
		t.Fatal(err)
	}
	return &sideRig{rig: r, pid: p.ID, clock: clock, up: up, dir: dir}
}

type sideRun struct {
	final  sideEvent
	events []events.Event
}

func (s sideRun) types(typ string) []map[string]any {
	var out []map[string]any
	for _, e := range s.events {
		if e.Type == typ {
			var m map[string]any
			_ = json.Unmarshal(e.Data, &m)
			out = append(out, m)
		}
	}
	return out
}

// ask posts a side question through the bridge and waits for its end.
func (s *sideRig) ask(t *testing.T, text string) sideRun {
	t.Helper()
	ch, cancel := s.hub.Subscribe(s.pid)
	defer cancel()
	status, id := s.api(t).ask(s.pid, text)
	if status != 202 {
		t.Fatalf("ask = %d", status)
	}
	return s.await(t, ch, id)
}

func (s *sideRig) await(t *testing.T, ch <-chan events.Event, id string) sideRun {
	t.Helper()
	var out sideRun
	timeout := time.After(30 * time.Second)
	for {
		select {
		case ev := <-ch:
			if !strings.HasPrefix(ev.Type, "side.") {
				continue
			}
			out.events = append(out.events, ev)
			if ev.Type == events.SideDone || ev.Type == events.SideError {
				if err := json.Unmarshal(ev.Data, &out.final); err != nil {
					t.Fatal(err)
				}
				return out
			}
		case <-timeout:
			t.Fatal("timed out waiting for the side answer")
		}
	}
}

var pidRe = regexp.MustCompile(`pid=(\d+) session=(\S+)`)

func answerOf(r sideRun) string {
	if r.final.Msg != nil {
		return r.final.Msg.Text
	}
	return ""
}

func pidOf(t *testing.T, text string) (string, string) {
	t.Helper()
	m := pidRe.FindStringSubmatch(text)
	if m == nil {
		t.Fatalf("no pid in %q", text)
	}
	return m[1], m[2]
}

func TestSideOnACPOrchestratorWithoutAPIKey(t *testing.T) {
	s := newSideRig(t, &config.Models{Orchestrator: "acp:fake"})
	// The orchestrator's own session, for comparison.
	got := s.runCollect(t, s.pid, "[echo] hi", nil)
	if got.status != "completed" {
		t.Fatalf("turn = %s", got.status)
	}
	orchText := s.echoOf(t, s.pid, got)
	orchPID, orchSess := pidOf(t, orchText)

	run := s.ask(t, "[echo] what is this?")
	if run.final.Msg == nil {
		t.Fatalf("side failed: %q", run.final.Error)
	}
	sidePID, sideSess := pidOf(t, answerOf(run))
	if sidePID == orchPID || sideSess == orchSess {
		t.Fatalf("side shares the orchestrator's agent: pid %s/%s session %s/%s", sidePID, orchPID, sideSess, orchSess)
	}
	if !strings.Contains(answerOf(run), "You answer side questions") || !strings.Contains(answerOf(run), "Side question: [echo] what is this?") {
		t.Fatalf("first prompt = %q", answerOf(run))
	}
	if n := s.up.n.Load(); n != 0 {
		t.Fatalf("%d upstream requests, want 0", n)
	}
	if len(run.types(events.SideDelta)) == 0 || len(run.types(events.SideActivity)) == 0 {
		t.Fatalf("no live events: %v", run.events)
	}
	// The orchestrator's conversation is untouched, and the answer is stored.
	if list := s.api(t).sideList(s.pid); len(list) != 2 {
		t.Fatalf("side messages = %d", len(list))
	}
	// Usage rows carry role side.
	var side int
	for _, u := range s.usageLog(t, s.pid) {
		if u.Role == "side" {
			side++
			if u.Source != "acp" {
				t.Fatalf("side usage source = %q", u.Source)
			}
		}
	}
	if side == 0 {
		t.Fatal("no usage row with role side")
	}
}

func TestSideFollowUpReusesSessionAndClearCloses(t *testing.T) {
	s := newSideRig(t, &config.Models{Orchestrator: "acp:fake"})
	first := s.ask(t, "[echo] one")
	pid1, sess1 := pidOf(t, answerOf(first))
	second := s.ask(t, "[echo] two")
	pid2, sess2 := pidOf(t, answerOf(second))
	if pid1 != pid2 || sess1 != sess2 {
		t.Fatalf("follow-up opened another agent: %s/%s %s/%s", pid1, pid2, sess1, sess2)
	}
	if strings.Contains(answerOf(second), "You answer side questions") {
		t.Fatalf("follow-up repeated the briefing: %q", answerOf(second))
	}
	if !s.orch.SideSessionOpen(s.pid) {
		t.Fatal("side session not open")
	}
	if st, _ := s.api(t).do("DELETE", "/v1/projects/"+s.pid+"/side", nil); st != 204 {
		t.Fatalf("clear = %d", st)
	}
	if s.orch.SideSessionOpen(s.pid) {
		t.Fatal("clear left the side agent running")
	}
	third := s.ask(t, "[echo] three")
	pid3, _ := pidOf(t, answerOf(third))
	if pid3 == pid1 {
		t.Fatal("a cleared side conversation reused the old agent")
	}
	if !strings.Contains(answerOf(third), "You answer side questions") || strings.Contains(answerOf(third), "[echo] one") {
		t.Fatalf("fresh conversation prompt = %q", answerOf(third))
	}
}

func TestSideIdleClose(t *testing.T) {
	s := newSideRig(t, &config.Models{Orchestrator: "acp:fake"})
	first := s.ask(t, "[echo] one")
	pid1, _ := pidOf(t, answerOf(first))
	s.clock.advance(14 * time.Minute)
	s.orch.ReapSideForTest()
	if !s.orch.SideSessionOpen(s.pid) {
		t.Fatal("closed before the idle limit")
	}
	s.clock.advance(2 * time.Minute)
	s.orch.ReapSideForTest()
	if s.orch.SideSessionOpen(s.pid) {
		t.Fatal("still open after 16 idle minutes")
	}
	second := s.ask(t, "[echo] two")
	pid2, _ := pidOf(t, answerOf(second))
	if pid1 == pid2 {
		t.Fatal("the idle-closed agent was reused")
	}
	// The earlier exchange is carried into the new session's first prompt.
	if !strings.Contains(answerOf(second), "Earlier in this side conversation") {
		t.Fatalf("no earlier exchanges in %q", answerOf(second))
	}
}

func TestSideWritesAndCommandsDenied(t *testing.T) {
	s := newSideRig(t, &config.Models{Orchestrator: "acp:fake"})
	run := s.ask(t, "[fswrite] write it")
	if _, err := os.Stat(filepath.Join(s.dir, fakeacp.WriteFile)); err == nil {
		t.Fatal("the side agent wrote a file")
	}
	if !strings.Contains(answerOf(run), "refused") {
		t.Fatalf("answer = %q", answerOf(run))
	}
	run = s.ask(t, "[perm] run it")
	if !strings.Contains(answerOf(run), "chosen=p-reject") {
		t.Fatalf("permission answer = %q", answerOf(run))
	}
	if _, err := os.Stat(filepath.Join(s.dir, fakeacp.PermFile)); err == nil {
		t.Fatal("the side agent ran a command")
	}
}

func TestSideUsesTheAgentsReadOnlyMode(t *testing.T) {
	s := newSideRig(t, &config.Models{Orchestrator: "acp:fake"})
	run := s.ask(t, "[mode]")
	if !strings.Contains(answerOf(run), "mode=ask") {
		t.Fatalf("answer = %q", answerOf(run))
	}
	// The orchestrator's session is not touched by the side mode.
	s.runCollect(t, s.pid, "[mode]", nil)
	if txt := s.lastOrchestratorText(t, s.pid); !strings.Contains(txt, "mode=default") {
		t.Fatalf("orchestrator mode = %q", txt)
	}
}

func TestSideRunsWhileTheOrchestratorTurnRuns(t *testing.T) {
	s := newSideRig(t, &config.Models{Orchestrator: "acp:fake"})
	ch, cancel := s.hub.Subscribe(s.pid)
	defer cancel()
	if _, err := s.orch.Start(context.Background(), s.pid, "[hang] stuck"); err != nil {
		t.Fatal(err)
	}
	waitUntil(t, "the turn to run", func() bool { return s.orch.Running(s.pid) })
	time.Sleep(300 * time.Millisecond)
	run := s.ask(t, "[echo] meanwhile")
	if run.final.Msg == nil {
		t.Fatalf("side failed while the turn ran: %q", run.final.Error)
	}
	if !s.orch.Running(s.pid) {
		t.Fatal("the side question ended the orchestrator's turn")
	}
	s.orch.Cancel(s.pid)
	for ev := range ch {
		if ev.Type == events.TurnFinished {
			return
		}
	}
}

func TestSideStopKeepsTheSession(t *testing.T) {
	s := newSideRig(t, &config.Models{Orchestrator: "acp:fake"})
	first := s.ask(t, "[echo] one")
	pid1, _ := pidOf(t, answerOf(first))
	ch, cancel := s.hub.Subscribe(s.pid)
	defer cancel()
	_, id := s.api(t).ask(s.pid, "[hang] stuck")
	for hanging := false; !hanging; {
		select {
		case ev := <-ch:
			hanging = ev.Type == events.SideTool
		case <-time.After(20 * time.Second):
			t.Fatal("the side agent never started its tool call")
		}
	}
	if st, _ := s.api(t).do("POST", "/v1/projects/"+s.pid+"/side/stop", nil); st != 204 {
		t.Fatalf("stop = %d", st)
	}
	run := s.await(t, ch, id)
	if run.final.Type != events.SideError || run.final.Error != "cancelled" {
		t.Fatalf("final = %+v", run.final)
	}
	again := s.ask(t, "[echo] again")
	if pid2, _ := pidOf(t, answerOf(again)); pid2 != pid1 {
		t.Fatalf("stop closed the session: %s then %s", pid1, pid2)
	}
}

func TestSideModelSettingOverridesTheOrchestrator(t *testing.T) {
	// The orchestrator is an API model with no key; models.side names the agent.
	s := newSideRig(t, &config.Models{Side: "acp:fake"})
	run := s.ask(t, "[echo] hi")
	if run.final.Msg == nil {
		t.Fatalf("side failed: %q", run.final.Error)
	}
}

func TestSideModelSettingValidation(t *testing.T) {
	s := newSideRig(t, nil)
	svc := s.svcWithAgents(t, sideAgent())
	if _, err := svc.Update(context.Background(), s.pid, project.Input{Models: &config.Models{Side: "acp:fake"}}); err != nil {
		t.Fatalf("side acp:fake: %v", err)
	}
	if _, err := svc.Update(context.Background(), s.pid, project.Input{Models: &config.Models{Side: "acp:nope"}}); err == nil {
		t.Fatal("side acp:nope accepted")
	}
}

func TestSideNoProviderIsATypedError(t *testing.T) {
	s := newSideRig(t, nil) // API orchestrator, no key, no side model
	status, body := s.api(t).do("POST", "/v1/projects/"+s.pid+"/side", map[string]string{"text": "hello?"})
	e, _ := body["error"].(map[string]any)
	if status != 409 || e["code"] != "no_provider" {
		t.Fatalf("status %d body %v", status, body)
	}
	if msg, _ := e["message"].(string); strings.Contains(msg, "ANTHROPIC_API_KEY") || strings.Contains(msg, "environment") {
		t.Fatalf("message tells about environment variables: %q", msg)
	}
	if list := s.api(t).sideList(s.pid); len(list) != 0 {
		t.Fatalf("a refused question was stored: %v", list)
	}
	if n := s.up.n.Load(); n != 0 {
		t.Fatalf("%d upstream requests", n)
	}
}
