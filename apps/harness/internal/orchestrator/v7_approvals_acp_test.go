package orchestrator_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/approval"
	"github.com/ndolinschi/Octo/apps/harness/internal/config"
	"github.com/ndolinschi/Octo/apps/harness/internal/events"
	"github.com/ndolinschi/Octo/apps/harness/internal/fakeacp"
	"github.com/ndolinschi/Octo/apps/harness/internal/mockllm"
	"github.com/ndolinschi/Octo/apps/harness/internal/project"
)

func (r *rig) supervisedProject(t *testing.T, dir string, orchestrator string) string {
	t.Helper()
	name, access := "p", "supervised"
	in := project.Input{Name: &name, Folders: &[]project.FolderInput{{Path: dir}}, Access: &access}
	if orchestrator != "" {
		in.Models = &config.Models{Orchestrator: orchestrator}
	}
	svc := r.svc
	if orchestrator != "" {
		svc = r.svcWithAgents(t, fakeAgent("fake", true))
	}
	p, err := svc.Create(context.Background(), in)
	if err != nil {
		t.Fatal(err)
	}
	return p.ID
}

// approver answers every approval of a project with answer and records them.
type approver struct {
	mu   sync.Mutex
	seen []approval.Approval
}

func (r *rig) approver(t *testing.T, pid string, answer func(approval.Approval) approval.Resolution) *approver {
	t.Helper()
	ap := &approver{}
	ch, cancel := r.hub.Subscribe(pid)
	t.Cleanup(cancel)
	go func() {
		for ev := range ch {
			if ev.Type != "approval.requested" {
				continue
			}
			var m struct{ Approval approval.Approval }
			if err := json.Unmarshal(ev.Data, &m); err != nil {
				t.Error(err)
				return
			}
			ap.mu.Lock()
			ap.seen = append(ap.seen, m.Approval)
			ap.mu.Unlock()
			if err := r.orch.ResolveApproval(pid, m.Approval.ID, answer(m.Approval)); err != nil {
				t.Error(err)
			}
		}
	}()
	return ap
}

func (a *approver) all() []approval.Approval {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]approval.Approval(nil), a.seen...)
}

func allowAll(approval.Approval) approval.Resolution {
	return approval.Resolution{Decision: approval.Allow}
}

func TestACPPermissionRequestBecomesAnApprovalAndAllowReachesTheAgent(t *testing.T) {
	r := newACPRig(t, mockllm.New(0), fakeAgent("fake", true))
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("# Octo demo\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	pid := r.supervisedProject(t, dir, "")
	ap := r.approver(t, pid, allowAll)
	got := r.runCollect(t, pid, "[acp] summarize", nil)
	if got.status != "completed" {
		t.Fatalf("turn = %s", got.status)
	}
	// One card for the edit; the fs/write_text_file that carries it out is covered by it.
	seen := ap.all()
	if len(seen) != 1 {
		t.Fatalf("approvals = %+v", seen)
	}
	a := seen[0]
	child := r.acpChild(t, pid)
	if a.Kind != "acp" || a.Title != "Write "+fakeacp.NoteFile || a.AgentLabel != "fake" || a.AgentID != child.ID || a.TurnID == 0 ||
		len(a.Detail.Options) != 3 || a.Detail.Path != fakeacp.NoteFile {
		t.Fatalf("approval = %+v", a)
	}
	// The card names its main session, like a built-in card: GET /approvals?session= (a client's reload) and the
	// session's needs_you count it.
	if a.SessionID == "" || a.SessionID != child.SessionID {
		t.Fatalf("approval session = %q, want the turn's main session %q", a.SessionID, child.SessionID)
	}
	if _, err := os.Stat(filepath.Join(dir, fakeacp.NoteFile)); err != nil {
		t.Fatalf("allowed write missing: %v", err)
	}
}

func TestACPDenyIsReturnedAsRejectAndNothingIsWritten(t *testing.T) {
	r := newACPRig(t, mockllm.New(0), fakeAgent("fake", true))
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("# demo\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	pid := r.supervisedProject(t, dir, "")
	r.approver(t, pid, func(approval.Approval) approval.Resolution {
		return approval.Resolution{Decision: approval.Deny, Note: "no"}
	})
	r.runCollect(t, pid, "[acp] summarize", nil)
	child := r.acpChild(t, pid)
	if child.Result == nil || !strings.Contains(*child.Result, "Permission was not granted.") {
		t.Fatalf("agent result = %v", child.Result)
	}
	if _, err := os.Stat(filepath.Join(dir, fakeacp.NoteFile)); err == nil {
		t.Fatal("a denied write happened")
	}
}

func TestACPOptionsMapToTheAnswer(t *testing.T) {
	cases := []struct {
		name string
		res  approval.Resolution
		want string
		ran  bool
	}{
		{"allow picks allow_once", approval.Resolution{Decision: approval.Allow}, "p-allow-once", true},
		{"allow with an option", approval.Resolution{Decision: approval.Allow, OptionID: "p-allow-always"}, "p-allow-always", true},
		{"allow with a reject option falls back to allow_once", approval.Resolution{Decision: approval.Allow, OptionID: "p-reject-once"}, "p-allow-once", true},
		{"allow for the turn is allow_once", approval.Resolution{Decision: approval.AllowForTurn}, "p-allow-once", true},
		{"deny picks reject_once", approval.Resolution{Decision: approval.Deny}, "p-reject-once", false},
		{"deny with an option", approval.Resolution{Decision: approval.Deny, OptionID: "p-reject-always"}, "p-reject-always", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := newACPRig(t, mockllm.New(0), fakeAgent("fake", true))
			dir := t.TempDir()
			pid := r.supervisedProject(t, dir, "")
			ap := r.approver(t, pid, func(approval.Approval) approval.Resolution { return c.res })
			r.runCollect(t, pid, "[acp] [perm] run the tests", nil)
			child := r.acpChild(t, pid)
			if child.Result == nil || !strings.Contains(*child.Result, "permission chosen="+c.want) {
				t.Fatalf("result = %v, want chosen=%s", child.Result, c.want)
			}
			_, err := os.Stat(filepath.Join(dir, fakeacp.PermFile))
			if (err == nil) != c.ran {
				t.Fatalf("command ran = %v, want %v", err == nil, c.ran)
			}
			seen := ap.all()
			if len(seen) != 1 || seen[0].Detail.Command != "npm test" || seen[0].Detail.Path != "package.json" || len(seen[0].Detail.Options) != 4 ||
				seen[0].Title != "Run npm test" {
				t.Fatalf("approval = %+v", seen)
			}
		})
	}
}

func TestACPFullAccessIsUnchanged(t *testing.T) {
	r := newACPRig(t, mockllm.New(0), fakeAgent("fake", true))
	dir := t.TempDir()
	pid := r.projectAt(t, dir) // full: the default of the library
	r.runCollect(t, pid, "[acp] [perm] run the tests", nil)
	child := r.acpChild(t, pid)
	if child.Result == nil || !strings.Contains(*child.Result, "permission chosen=p-allow-once") {
		t.Fatalf("result = %v", child.Result)
	}
	if n, _ := r.orch.Attention(pid); n != 0 {
		t.Fatalf("pending approvals under full access: %d", n)
	}
}

func TestACPOrchestratorPermissionApproval(t *testing.T) {
	r := newACPRig(t, mockllm.New(0), fakeAgent("fake", true))
	dir := t.TempDir()
	pid := r.supervisedProject(t, dir, "acp:fake")
	ap := r.approver(t, pid, allowAll)
	got := r.runCollect(t, pid, "[perm] run the tests", nil)
	if got.status != "completed" {
		t.Fatalf("turn = %s", got.status)
	}
	seen := ap.all()
	if len(seen) != 1 || seen[0].AgentLabel != "fake" {
		t.Fatalf("approvals = %+v", seen)
	}
	root, err := r.store.Get(context.Background(), pid)
	if err != nil {
		t.Fatal(err)
	}
	orch, _ := root.Orchestrator(context.Background())
	if seen[0].AgentID != orch.ID {
		t.Fatalf("approval agent = %s, want the orchestrator %s", seen[0].AgentID, orch.ID)
	}
}

func TestACPPendingApprovalIsDeniedWhenTheTurnIsCancelled(t *testing.T) {
	r := newACPRig(t, mockllm.New(0), fakeAgent("fake", true))
	pid := r.supervisedProject(t, t.TempDir(), "acp:fake")
	got := r.runCollect(t, pid, "[perm] run the tests", func(ch <-chan events.Event) {
		for ev := range ch {
			if ev.Type == "approval.requested" {
				break
			}
		}
		if n, _ := r.orch.Attention(pid); n != 1 {
			t.Errorf("pending = %d", n)
		}
		r.orch.Cancel(pid)
	})
	if got.status != "cancelled" {
		t.Fatalf("turn = %s", got.status)
	}
	if n, _ := r.orch.Attention(pid); n != 0 {
		t.Fatalf("approvals left after cancel: %d", n)
	}
	res := got.of("approval.resolved")
	if len(res) != 1 || res[0]["decision"] != "deny" {
		t.Fatalf("resolved events = %+v", res)
	}
}

func TestACPAcceptEditsApprovesEditsAndAsksForCommands(t *testing.T) {
	r := newACPRig(t, mockllm.New(0), fakeAgent("fake", true))
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("# demo\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	name, access := "p", "accept_edits"
	svc := r.svcWithAgents(t, fakeAgent("fake", true))
	p, err := svc.Create(context.Background(), project.Input{
		Name: &name, Folders: &[]project.FolderInput{{Path: dir}}, Access: &access,
	})
	if err != nil {
		t.Fatal(err)
	}
	// Edits under accept_edits auto-approve without an approval card.
	if got := r.runCollect(t, p.ID, "[acp] summarize", nil); got.status != "completed" {
		t.Fatalf("edit turn = %s", got.status)
	}
	if _, err := os.Stat(filepath.Join(dir, fakeacp.NoteFile)); err != nil {
		t.Fatalf("edit did not write: %v", err)
	}
	// Commands still ask.
	ap := r.approver(t, p.ID, allowAll)
	if got := r.runCollect(t, p.ID, "[acp] [perm] run the tests", nil); got.status != "completed" {
		t.Fatalf("command turn = %s", got.status)
	}
	seen := ap.all()
	if len(seen) != 1 || seen[0].Detail.Command != "npm test" {
		t.Fatalf("expected 1 command approval, got %+v", seen)
	}
}
