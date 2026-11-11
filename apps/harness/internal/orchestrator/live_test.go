package orchestrator_test

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/approval"
	"github.com/ndolinschi/Octo/apps/harness/internal/config"
	"github.com/ndolinschi/Octo/apps/harness/internal/events"
	"github.com/ndolinschi/Octo/apps/harness/internal/fakeacp"
	"github.com/ndolinschi/Octo/apps/harness/internal/mockllm"
	"github.com/ndolinschi/Octo/apps/harness/internal/orchestrator"
	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
	"github.com/ndolinschi/Octo/apps/harness/internal/project"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
	"github.com/ndolinschi/Octo/apps/harness/internal/secrets"
)

// stamped is an event with the time the subscriber received it.
type stamped struct {
	typ  string
	data map[string]any
	at   time.Time
}

// liveRun runs one turn and returns every event with its arrival time.
func (r *rig) liveRun(t *testing.T, pid, text string) ([]stamped, string) {
	t.Helper()
	ch, cancel := r.hub.Subscribe(pid)
	defer cancel()
	if _, err := r.orch.Start(context.Background(), pid, text); err != nil {
		t.Fatal(err)
	}
	var out []stamped
	timeout := time.After(30 * time.Second)
	for {
		select {
		case ev, ok := <-ch:
			if !ok {
				t.Fatal("event stream closed")
			}
			s := stamped{typ: ev.Type, at: time.Now()}
			if err := json.Unmarshal(ev.Data, &s.data); err != nil {
				t.Fatal(err)
			}
			out = append(out, s)
			if ev.Type == events.TurnFinished {
				return out, s.data["status"].(string)
			}
		case <-timeout:
			t.Fatal("timed out waiting for turn.finished")
		}
	}
}

func ofType(evs []stamped, typ string) []stamped {
	var out []stamped
	for _, e := range evs {
		if e.typ == typ {
			out = append(out, e)
		}
	}
	return out
}

func liveIndex(evs []stamped, typ string, match func(map[string]any) bool) int {
	for i, e := range evs {
		if e.typ == typ && (match == nil || match(e.data)) {
			return i
		}
	}
	return -1
}

// sentAt parses the "<ns>;" or "t=<ns>;" prefix the scripted agent puts on a chunk.
func sentAt(t *testing.T, text string) time.Time {
	t.Helper()
	text = strings.TrimPrefix(text, "t=")
	head, _, ok := strings.Cut(text, ";")
	ns, err := strconv.ParseInt(head, 10, 64)
	if !ok || err != nil {
		t.Fatalf("chunk %q has no send time", text)
	}
	return time.Unix(0, ns)
}

func liveRigWith(t *testing.T, quiet time.Duration) *rig {
	t.Helper()
	return newRigWith(t, mockllm.New(0), orchestrator.Options{Agents: []plugins.Agent{fakeAgent("fake", true)}, ACPQuietAfter: quiet})
}

func (r *rig) acpOrchProject(t *testing.T) string {
	t.Helper()
	name := "p"
	p, err := r.svcWithAgents(t, fakeAgent("fake", true)).Create(context.Background(), project.Input{
		Name: &name, Folders: &[]project.FolderInput{{Path: t.TempDir()}}, Models: &config.Models{Orchestrator: "acp:fake"},
	})
	if err != nil {
		t.Fatal(err)
	}
	return p.ID
}

func activities(evs []stamped) []string {
	var out []string
	for _, e := range ofType(evs, events.AgentActivity) {
		out = append(out, e.data["kind"].(string)+":"+e.data["label"].(string))
	}
	return out
}

func hasActivity(evs []stamped, want string) bool {
	for _, a := range activities(evs) {
		if a == want {
			return true
		}
	}
	return false
}

func checkLiveTurn(t *testing.T, r *rig, pid, agentID string, evs []stamped) {
	t.Helper()
	// Thinking: published, first chunk fast, never stored.
	th := ofType(evs, events.ThinkingDelta)
	if len(th) < 2 || th[0].data["agent_id"] != agentID {
		t.Fatalf("thinking deltas = %v", th)
	}
	if lat := th[0].at.Sub(sentAt(t, th[0].data["text"].(string))); lat > 100*time.Millisecond {
		t.Fatalf("first thought took %v to reach a subscriber", lat)
	}
	// Tool row published at the start, updated while it runs, finished later.
	started := liveIndex(evs, events.ToolStarted, func(m map[string]any) bool { return m["tool_use_id"] == "call-live" })
	finished := liveIndex(evs, events.ToolFinished, func(m map[string]any) bool { return m["tool_use_id"] == "call-live" })
	if started < 0 || finished < 0 || started >= finished {
		t.Fatalf("tool.started at %d, tool.finished at %d", started, finished)
	}
	// Published at the announcement, not at the end: the row and its start precede
	// the in-progress update the agent sent 150 ms before it finished the call (an
	// order in one stream, so a slow machine cannot blur it the way a clock can).
	running := liveIndex(evs, events.ToolUpdated, func(m map[string]any) bool {
		return m["tool_use_id"] == "call-live" && m["status"] == "in_progress"
	})
	if running < 0 || started >= running || running >= finished {
		t.Fatalf("tool.started at %d, in-progress update at %d, tool.finished at %d", started, running, finished)
	}
	row := -1
	for i, e := range evs {
		if e.typ == events.MessageCreated {
			if m, _ := e.data["message"].(map[string]any); m != nil && strings.Contains(asJSON(m["content"]), `"call-live"`) {
				row = i
				break
			}
		}
	}
	if row < 0 || row >= running {
		t.Fatalf("the tool_use message was published at %d, after the tool finished at %d", row, finished)
	}
	var sawRunning, sawDone bool
	for _, e := range ofType(evs, events.ToolUpdated) {
		if e.data["tool_use_id"] != "call-live" {
			continue
		}
		if e.data["status"] == "in_progress" && e.data["title"] == "Read README.md" {
			if locs, _ := e.data["locations"].([]any); len(locs) != 1 {
				t.Fatalf("locations = %v", e.data["locations"])
			}
			sawRunning = true
		}
		if e.data["status"] == "completed" && e.data["summary"] == "read 12 bytes" {
			sawDone = true
		}
	}
	if !sawRunning || !sawDone {
		t.Fatalf("tool.updated running=%v done=%v", sawRunning, sawDone)
	}
	// The plan: published whole each time, the latest stored on the agent row.
	plans := ofType(evs, events.AgentPlan)
	if len(plans) != 2 {
		t.Fatalf("agent.plan events = %d", len(plans))
	}
	last := plans[1].data["entries"].([]any)
	if len(last) != 2 || last[0].(map[string]any)["status"] != "completed" || last[1].(map[string]any)["status"] != "in_progress" {
		t.Fatalf("last plan = %v", last)
	}
	// Activity: thinking, the tool with its label, writing; idle at the end.
	for _, want := range []string{"thinking:Thinking", "tool:Reading README.md", "text:Writing"} {
		if !hasActivity(evs, want) {
			t.Fatalf("no activity %q in %v", want, activities(evs))
		}
	}
	var acts []stamped
	for _, e := range ofType(evs, events.AgentActivity) {
		if e.data["agent_id"] == agentID {
			acts = append(acts, e)
		}
	}
	if i := liveIndex(evs, events.AgentActivity, func(m map[string]any) bool { return m["kind"] == "tool" && m["agent_id"] == agentID }); i < 0 || evs[i].data["tool_use_id"] != "call-live" {
		t.Fatalf("tool activity lacks the tool id: %v", acts)
	}
	if lastAct := acts[len(acts)-1]; lastAct.data["kind"] != "idle" {
		t.Fatalf("last activity = %v", lastAct.data)
	}
	// Text arrives incrementally: 20 chunks over ~400 ms, each soon after it was sent.
	var deltas []stamped
	for _, e := range ofType(evs, events.MessageDelta) {
		if e.data["agent_id"] == agentID && strings.Contains(e.data["text"].(string), ";c") {
			deltas = append(deltas, e)
		}
	}
	if len(deltas) != 20 {
		t.Fatalf("text deltas = %d, want 20 (one per chunk, not one lump)", len(deltas))
	}
	if spread := deltas[19].at.Sub(deltas[0].at); spread < 300*time.Millisecond {
		t.Fatalf("20 chunks sent over 400 ms reached the subscriber within %v: not incremental", spread)
	}
	for i, d := range deltas {
		if lat := d.at.Sub(sentAt(t, d.data["text"].(string))); lat > 100*time.Millisecond {
			t.Fatalf("chunk %d took %v", i, lat)
		}
	}
	// Reasoning is not part of the transcript.
	for _, m := range r.transcript(t, pid, agentID) {
		if b, _ := json.Marshal(m.Content); strings.Contains(string(b), "Let me look at the project") || strings.Contains(string(b), "Now I can answer") {
			t.Fatalf("a thought was stored: %s", b)
		}
	}
	a := r.agentByID(t, pid, agentID)
	if len(a.Plan) != 2 || a.Plan[0].Status != "completed" || a.Plan[1].Content != "Summarise it" || a.Plan[1].Priority != "medium" {
		t.Fatalf("stored plan = %+v", a.Plan)
	}
}

func asJSON(v any) string { b, _ := json.Marshal(v); return string(b) }

func TestLiveACPOrchestratorStreamsThoughtPlanToolAndText(t *testing.T) {
	r := liveRigWith(t, 0)
	pid := r.acpOrchProject(t)
	evs, status := r.liveRun(t, pid, "[live] go")
	if status != "completed" {
		t.Fatalf("status = %s", status)
	}
	orch := r.agents(t, pid)[0]
	checkLiveTurn(t, r, pid, orch.ID, evs)

	// The next turn starts without the previous turn's plan.
	if _, status := r.liveRun(t, pid, "[echo] again"); status != "completed" {
		t.Fatalf("second turn = %s", status)
	}
	if a := r.agentByID(t, pid, orch.ID); len(a.Plan) != 0 {
		t.Fatalf("plan survived into the next turn: %+v", a.Plan)
	}
}

func TestLiveACPSubAgentStreamsThoughtPlanToolAndText(t *testing.T) {
	r := liveRigWith(t, 0)
	pid := r.project(t, 1)
	evs, status := r.liveRun(t, pid, "[acp] [live] go")
	if status != "completed" {
		t.Fatalf("status = %s", status)
	}
	checkLiveTurn(t, r, pid, r.acpChild(t, pid).ID, evs)
}

func TestLiveACPSlowToolIsVisibleWhileItRuns(t *testing.T) {
	r := liveRigWith(t, 0)
	pid := r.acpOrchProject(t)
	evs, status := r.liveRun(t, pid, "[slow-tool] go")
	if status != "completed" {
		t.Fatalf("status = %s", status)
	}
	s := liveIndex(evs, events.ToolStarted, nil)
	f := liveIndex(evs, events.ToolFinished, nil)
	if s < 0 || f < 0 || evs[f].at.Sub(evs[s].at) < 200*time.Millisecond { // the agent held it 400 ms
		t.Fatalf("tool row visible for %v, want ~400 ms", evs[f].at.Sub(evs[s].at))
	}
	if !hasActivity(evs, "tool:Running `pnpm test`") {
		t.Fatalf("activity = %v", activities(evs))
	}
}

func TestLiveACPRunningToolIsNotQuiet(t *testing.T) {
	r := liveRigWith(t, 100*time.Millisecond)
	pid := r.acpOrchProject(t)
	evs, status := r.liveRun(t, pid, "[slow-tool] go") // a tool silent for 400 ms
	if status != "completed" {
		t.Fatalf("status = %s", status)
	}
	if n := len(activitiesOfKind(evs, "quiet")); n != 0 {
		t.Fatalf("a running tool was reported quiet: %v", activities(evs))
	}
	if !hasActivity(evs, "tool:Running `pnpm test`") {
		t.Fatalf("activity = %v", activities(evs))
	}
}

func TestLiveACPQuietAgentIsReported(t *testing.T) {
	r := liveRigWith(t, 120*time.Millisecond)
	pid := r.acpOrchProject(t)
	evs, status := r.liveRun(t, pid, "[quiet] go")
	if status != "completed" {
		t.Fatalf("status = %s", status)
	}
	q := liveIndex(evs, events.AgentActivity, func(m map[string]any) bool { return m["kind"] == "quiet" })
	text := liveIndex(evs, events.MessageDelta, func(m map[string]any) bool { return m["text"] == "Done thinking." })
	if q < 0 || text < 0 || q > text || evs[q].data["label"] != "fake" {
		t.Fatalf("quiet at %d, text at %d, activity %v", q, text, activities(evs))
	}
	if n := len(activitiesOfKind(evs, "quiet")); n != 1 {
		t.Fatalf("quiet reported %d times for one silence", n)
	}
	// A talkative agent is never called quiet.
	r2 := liveRigWith(t, 500*time.Millisecond)
	evs2, _ := r2.liveRun(t, r2.acpOrchProject(t), "[live] go")
	if n := len(activitiesOfKind(evs2, "quiet")); n != 0 {
		t.Fatalf("quiet during a chatty turn: %v", activities(evs2))
	}
}

func activitiesOfKind(evs []stamped, kind string) []stamped {
	var out []stamped
	for _, e := range ofType(evs, events.AgentActivity) {
		if e.data["kind"] == kind {
			out = append(out, e)
		}
	}
	return out
}

func TestLiveACPThoughtsAndPlanAreScrubbedOfSecrets(t *testing.T) {
	r := liveRigWith(t, 0)
	pid := r.acpOrchProject(t)
	const value = "sk-live-0123456789abcdef"
	if err := r.svc.PutSecret(context.Background(), pid, "api_key", value); err != nil {
		t.Fatal(err)
	}
	evs, status := r.liveRun(t, pid, "[secret-thought:"+value+"] go")
	if status != "completed" {
		t.Fatalf("status = %s", status)
	}
	var thought strings.Builder
	for _, e := range ofType(evs, events.ThinkingDelta) {
		thought.WriteString(e.data["text"].(string))
	}
	if !strings.Contains(thought.String(), secrets.Mask) || !strings.Contains(thought.String(), "and I will not repeat it") {
		t.Fatalf("thought = %q", thought.String())
	}
	for _, e := range evs {
		if m, _ := e.data["message"].(map[string]any); m != nil && m["role"] == "user" {
			continue // the user's own words are stored as typed
		}
		if b, _ := json.Marshal(e.data); strings.Contains(string(b), value) || strings.Contains(string(b), value[:12]) {
			t.Fatalf("secret (or its first half) in %s: %s", e.typ, b)
		}
	}
	orch := r.agents(t, pid)[0]
	if len(orch.Plan) != 1 || strings.Contains(orch.Plan[0].Content, value) || !strings.Contains(orch.Plan[0].Content, secrets.Mask) {
		t.Fatalf("stored plan = %+v", orch.Plan)
	}
}

func TestStreamHoldsBackOnlyTheLongestSecret(t *testing.T) {
	dir := t.TempDir()
	m := secrets.New(func(string) string { return dir })
	s := m.NewStream("p")
	// No secrets: nothing is held back, not even without a newline.
	if got := s.Write("no newline here"); got != "no newline here" {
		t.Fatalf("held back with no secrets: %q", got)
	}
	if err := m.Put("p", "k", "0123456789"); err != nil {
		t.Fatal(err)
	}
	got := s.Write("abcdefghijklmnopqrstuvwxyz")
	if hold := len("abcdefghijklmnopqrstuvwxyz") - len(got); hold > 9 {
		t.Fatalf("held back %d bytes, more than the longest secret minus one (9)", hold)
	}
	if rest := s.Flush(); len(got)+len(rest) != 26 {
		t.Fatalf("got %q + %q", got, rest)
	}
}

func (r *rig) agentByID(t *testing.T, pid, id string) projectstore.Agent {
	t.Helper()
	for _, a := range r.agents(t, pid) {
		if a.ID == id {
			return a
		}
	}
	t.Fatalf("no agent %s", id)
	return projectstore.Agent{}
}

func TestLiveBuiltinLoopPublishesActivity(t *testing.T) {
	r := newRigWith(t, mockllm.New(0), orchestrator.Options{Stream: true})
	dir := t.TempDir()
	pid := r.projectAt(t, dir)
	evs, status := r.liveRun(t, pid, "build it [write:notes/{role}.md]")
	if status != "completed" {
		t.Fatalf("status = %s", status)
	}
	acts := activities(evs)
	var delegating, writing, thinking, text bool
	for _, a := range acts {
		delegating = delegating || strings.HasPrefix(a, "tool:Delegating")
		writing = writing || strings.HasPrefix(a, "tool:Writing notes/")
		thinking = thinking || a == "thinking:Thinking"
		text = text || a == "text:Writing"
	}
	if !delegating || !writing || !thinking || !text {
		t.Fatalf("delegating=%v writing=%v thinking=%v text=%v in %v", delegating, writing, thinking, text, acts)
	}
	// Every agent that had an activity ends idle.
	last := map[string]string{}
	for _, e := range ofType(evs, events.AgentActivity) {
		last[e.data["agent_id"].(string)] = e.data["kind"].(string)
	}
	for id, k := range last {
		if k != "idle" {
			t.Fatalf("agent %s ends %q, want idle", id, k)
		}
	}
}

func TestLiveWaitingForApprovalIsAnActivity(t *testing.T) {
	r := newRigWith(t, mockllm.New(0), orchestrator.Options{})
	pid := r.supervisedProject(t, t.TempDir(), "")
	r.approver(t, pid, allowAll)
	evs, status := r.liveRun(t, pid, "build it [write:a/{role}.md]")
	if status != "completed" {
		t.Fatalf("status = %s", status)
	}
	w := liveIndex(evs, events.AgentActivity, func(m map[string]any) bool { return m["kind"] == "waiting_approval" })
	a := liveIndex(evs, "approval.requested", nil)
	if w < 0 || a < 0 || w > a {
		t.Fatalf("waiting_approval at %d, approval.requested at %d (%v)", w, a, activities(evs))
	}
}

func TestLiveACPWaitingForApprovalIsAnActivityAndNotQuiet(t *testing.T) {
	r := liveRigWith(t, 60*time.Millisecond)
	pid := r.supervisedProject(t, t.TempDir(), "")
	// Answer the card only after a while: longer than the quiet threshold.
	ch, cancel := r.hub.Subscribe(pid)
	defer cancel()
	go func() {
		for ev := range ch {
			if ev.Type != "approval.requested" {
				continue
			}
			var m struct{ Approval approval.Approval }
			_ = json.Unmarshal(ev.Data, &m)
			time.Sleep(300 * time.Millisecond)
			_ = r.orch.ResolveApproval(pid, m.Approval.ID, approval.Resolution{Decision: approval.Allow})
		}
	}()
	evs, status := r.liveRun(t, pid, "[acp] go")
	if status != "completed" {
		t.Fatalf("status = %s", status)
	}
	if !hasActivity(evs, "waiting_approval:Waiting for your approval") {
		t.Fatalf("activity = %v", activities(evs))
	}
	w := liveIndex(evs, events.AgentActivity, func(m map[string]any) bool { return m["kind"] == "waiting_approval" })
	end := liveIndex(evs, "approval.resolved", nil)
	for i := w; i < end && i >= 0; i++ {
		if evs[i].typ == events.AgentActivity && evs[i].data["kind"] == "quiet" {
			t.Fatalf("an agent waiting for the user was reported quiet: %v", activities(evs))
		}
	}
}

func TestAdvertisedModelsAreExposedWithACallback(t *testing.T) {
	for _, via := range []string{"", "config"} {
		agent := modelAgent(map[string]string{fakeacp.EnvModels: "alpha,beta", fakeacp.EnvModelsVia: via}, nil)
		r := newRigWith(t, mockllm.New(0), orchestrator.Options{Agents: []plugins.Agent{agent}})
		var mu sync.Mutex
		var changed []string
		r.orch.OnAdvertisedModels(func(id string) { mu.Lock(); changed = append(changed, id); mu.Unlock() })
		if _, ok := r.orch.AdvertisedModels("fake"); ok {
			t.Fatal("advertised before any session")
		}
		pid := r.project(t, 1)
		if got := r.runCollect(t, pid, "[acp] go", nil); got.status != "completed" {
			t.Fatalf("status %s", got.status)
		}
		a, ok := r.orch.AdvertisedModels("fake")
		if !ok || len(a.Models) != 2 || a.Models[0].ID != "alpha" || a.Models[1].Label != "beta" || a.Current == "" || time.Since(a.SeenAt) > time.Minute {
			t.Fatalf("via=%q advertised = %+v", via, a)
		}
		mu.Lock()
		if len(changed) != 1 || changed[0] != "fake" {
			t.Fatalf("callbacks = %v, want one for fake", changed)
		}
		mu.Unlock()
		// A second session with the same list is not a change.
		r.runCollect(t, pid, "[acp] again", nil)
		mu.Lock()
		if len(changed) != 1 {
			t.Fatalf("callbacks after an unchanged list = %v", changed)
		}
		mu.Unlock()
	}
}

// Output tokens: an agent that reports them with the end of its prompt is
// recorded as reported; one that does not gets an estimate from what it wrote,
// marked as estimated. (They were 0 for every Claude Code turn.)
func TestACPOutputTokensAreRecorded(t *testing.T) {
	outOf := func(r *rig, pid string) (out int64, estimated bool) {
		for _, e := range r.usageLog(t, pid) {
			out += e.OutputTokens
			estimated = estimated || e.TokensEstimated
		}
		return
	}
	t.Run("reported", func(t *testing.T) {
		r := newACPRig(t, mockllm.New(0), modelAgent(map[string]string{fakeacp.EnvPromptUsage: "321"}, nil))
		pid := r.supervisedProject(t, t.TempDir(), "acp:fake")
		if got := r.runCollect(t, pid, "[live] go", nil); got.status != "completed" {
			t.Fatalf("turn = %s", got.status)
		}
		out, est := outOf(r, pid)
		if out != 321 || est {
			t.Fatalf("output tokens = %d estimated=%v, want 321 reported", out, est)
		}
		if a := r.agents(t, pid)[0]; a.OutputTokens != 321 {
			t.Fatalf("agent row output_tokens = %d", a.OutputTokens)
		}
	})
	t.Run("estimated", func(t *testing.T) {
		r := newACPRig(t, mockllm.New(0), modelAgent(nil, nil))
		pid := r.supervisedProject(t, t.TempDir(), "acp:fake")
		if got := r.runCollect(t, pid, "[live] go", nil); got.status != "completed" {
			t.Fatalf("turn = %s", got.status)
		}
		out, est := outOf(r, pid)
		// 20 chunks of about 25 characters, plus two short thoughts.
		if out < 100 || out > 400 || !est {
			t.Fatalf("output tokens = %d estimated=%v, want an estimate", out, est)
		}
		rep, err := r.svc.Usage(context.Background(), project.UsageQuery{ProjectID: pid, Group: "project"})
		if err != nil || !rep.Total.TokensEstimated || rep.Total.OutputTokens != out {
			t.Fatalf("usage total = %+v (%v)", rep.Total, err)
		}
	})
	t.Run("nothing written, nothing recorded", func(t *testing.T) {
		r := newACPRig(t, mockllm.New(0), modelAgent(nil, nil))
		pid := r.supervisedProject(t, t.TempDir(), "acp:fake")
		r.runCollect(t, pid, "[silent] go", nil)
		if out, _ := outOf(r, pid); out != 0 {
			t.Fatalf("output tokens = %d for a silent agent", out)
		}
	})
}

func waitFor(t *testing.T, ch <-chan events.Event, typ string) {
	t.Helper()
	deadline := time.After(20 * time.Second)
	for {
		select {
		case ev := <-ch:
			if ev.Type == typ {
				return
			}
		case <-deadline:
			t.Fatalf("no %s event", typ)
		}
	}
}

func lastAssistant(t *testing.T, r *rig, pid, agentID string) projectstoreMessage {
	t.Helper()
	msgs := r.transcript(t, pid, agentID)
	for i := len(msgs) - 1; i >= 0; i-- {
		if msgs[i].Role == "assistant" {
			return msgs[i]
		}
	}
	t.Fatal("no assistant message")
	return projectstoreMessage{}
}

type projectstoreMessage = projectstore.Message

// A cancelled turn keeps the text the agent had written, flagged stopped, and
// turn.finished says cancelled.
func TestCancelledTurnKeepsItsPartialTextFlaggedStopped(t *testing.T) {
	t.Run("ACP orchestrator", func(t *testing.T) {
		r := liveRigWith(t, 0)
		pid := r.acpOrchProject(t)
		got := r.runCollect(t, pid, "[say-hang] go", func(ch <-chan events.Event) {
			waitFor(t, ch, events.MessageDelta)
			r.orch.Cancel(pid)
		})
		if got.status != "cancelled" {
			t.Fatalf("status = %s", got.status)
		}
		orch := r.agents(t, pid)[0]
		m := lastAssistant(t, r, pid, orch.ID)
		if !m.Stopped || len(m.Content) == 0 || m.Content[0].Text == nil || !strings.Contains(*m.Content[0].Text, "Working on it") {
			t.Fatalf("last assistant message = %+v", m)
		}
		// The announcement carried the flag too.
		var flagged bool
		for _, e := range got.of(events.MessageCreated) {
			if msg, _ := e["message"].(map[string]any); msg != nil && msg["role"] == "assistant" && msg["stopped"] == true {
				flagged = true
			}
		}
		if !flagged {
			t.Fatal("the message.created of the stopped message lacks stopped: true")
		}
	})
	t.Run("built-in loop", func(t *testing.T) {
		r := newRigWith(t, mockllm.New(60*time.Millisecond), orchestrator.Options{Stream: true})
		pid := r.projectAt(t, t.TempDir())
		got := r.runCollect(t, pid, "quick: tell me a long story about the repository layout", func(ch <-chan events.Event) {
			waitFor(t, ch, events.MessageDelta)
			time.Sleep(80 * time.Millisecond)
			r.orch.Cancel(pid)
		})
		if got.status != "cancelled" {
			t.Fatalf("status = %s", got.status)
		}
		orch := r.agents(t, pid)[0]
		m := lastAssistant(t, r, pid, orch.ID)
		if !m.Stopped || len(m.Content) == 0 || m.Content[0].Text == nil || strings.TrimSpace(*m.Content[0].Text) == "" {
			t.Fatalf("last assistant message = %+v", m)
		}
	})
	t.Run("a finished turn is not stopped", func(t *testing.T) {
		r := liveRigWith(t, 0)
		pid := r.acpOrchProject(t)
		r.runCollect(t, pid, "[live] go", nil)
		orch := r.agents(t, pid)[0]
		if m := lastAssistant(t, r, pid, orch.ID); m.Stopped {
			t.Fatalf("a completed turn's message is flagged stopped: %+v", m)
		}
	})
}

// A tool call announced with no input and given it in a tool_call_update keeps
// its input in the stored row (spawn_agent rows of an ACP orchestrator were "").
func TestACPToolInputThatArrivesLateIsStored(t *testing.T) {
	r := liveRigWith(t, 0)
	pid := r.acpOrchProject(t)
	got := r.runCollect(t, pid, "[late-input] go", nil)
	if got.status != "completed" {
		t.Fatalf("status = %s", got.status)
	}
	orch := r.agents(t, pid)[0]
	var found bool
	for _, m := range r.transcript(t, pid, orch.ID) {
		b, _ := json.Marshal(m.Content)
		if strings.Contains(string(b), `"call-late"`) && m.Role == "assistant" {
			found = true
			if !strings.Contains(string(b), "check the diff") || !strings.Contains(string(b), "Review the change") {
				t.Fatalf("the tool_use row lost its input: %s", b)
			}
		}
	}
	if !found {
		t.Fatal("no tool row")
	}
	updated := got.of(events.MessageUpdated)
	if len(updated) != 1 {
		t.Fatalf("message.updated events = %d, want one for the late input", len(updated))
	}
}
