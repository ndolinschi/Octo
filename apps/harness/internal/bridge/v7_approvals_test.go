package bridge_test

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/approval"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

type approvalsResp struct {
	Approvals []approval.Approval `json:"approvals"`
}

// waitApprovals polls until n approvals are pending.
func (e *env) waitApprovals(t *testing.T, pid string, n int) []approval.Approval {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for {
		var got approvalsResp
		e.into(t, "GET", "/v1/projects/"+pid+"/approvals", nil, http.StatusOK, &got)
		if len(got.Approvals) >= n {
			return got.Approvals
		}
		if time.Now().After(deadline) {
			t.Fatalf("only %d approvals pending, want %d", len(got.Approvals), n)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func (e *env) answer(t *testing.T, pid, id string, body map[string]string) {
	t.Helper()
	e.into(t, "POST", "/v1/projects/"+pid+"/approvals/"+id, body, http.StatusNoContent, nil)
}

func TestSupervisedWriteApprovals(t *testing.T) {
	e := newEnv(t, nil)
	pid, folder := e.v7Project(t, "supervised")
	stream := e.subscribe(t, pid)
	e.into(t, "POST", "/v1/projects/"+pid+"/messages", map[string]string{"text": "Go [write:{role}.md]"}, http.StatusAccepted, nil)

	pending := e.waitApprovals(t, pid, 3)
	for _, a := range pending {
		if a.Kind != "write" || a.Detail.Diff == nil || a.Detail.Diff.Added != 3 || a.Detail.Diff.Removed != 0 ||
			!strings.HasSuffix(a.Detail.Path, ".md") || a.AgentLabel == "" || a.AgentID == "" || a.TurnID == 0 ||
			a.Title != "Write "+a.Detail.Path || a.Detail.Folder == "" {
			t.Fatalf("approval = %+v", a)
		}
	}
	var proj struct {
		NeedsYou         bool `json:"needs_you"`
		PendingApprovals int  `json:"pending_approvals"`
	}
	e.into(t, "GET", "/v1/projects/"+pid, nil, http.StatusOK, &proj)
	if !proj.NeedsYou || proj.PendingApprovals != 3 {
		t.Fatalf("project = %+v", proj)
	}
	e.wantError(t, "POST", "/v1/projects/"+pid+"/approvals/"+pending[0].ID, map[string]string{"decision": "maybe"}, http.StatusBadRequest, "invalid_request")
	e.wantError(t, "POST", "/v1/projects/"+pid+"/approvals/apr_nope", map[string]string{"decision": "allow"}, http.StatusNotFound, "not_found")

	e.answer(t, pid, pending[0].ID, map[string]string{"decision": "allow"})
	e.answer(t, pid, pending[1].ID, map[string]string{"decision": "deny", "note": "not this one"})
	e.answer(t, pid, pending[2].ID, map[string]string{"decision": "allow_for_turn"})
	e.wantError(t, "POST", "/v1/projects/"+pid+"/approvals/"+pending[0].ID, map[string]string{"decision": "allow"}, http.StatusNotFound, "not_found")
	evs := collectUntilTurnFinished(t, stream)

	if count(evs, "approval.requested") != 3 || count(evs, "approval.resolved") != 3 {
		t.Errorf("events: requested=%d resolved=%d", count(evs, "approval.requested"), count(evs, "approval.resolved"))
	}
	wrote := 0
	for _, a := range pending {
		_, err := os.Stat(filepath.Join(folder, a.Detail.Path))
		if a.ID == pending[1].ID {
			if err == nil {
				t.Errorf("denied write happened: %s", a.Detail.Path)
			}
			// The denied agent got an error result with the note.
			var msgs struct{ Messages []projectstore.Message }
			e.into(t, "GET", "/v1/projects/"+pid+"/agents/"+a.AgentID+"/messages", nil, http.StatusOK, &msgs)
			found := false
			for _, m := range msgs.Messages {
				for _, b := range m.Content {
					if b.Type == "tool_result" && b.IsError != nil && *b.IsError && b.Content != nil && strings.Contains(*b.Content, "Denied by the user: not this one") {
						found = true
					}
				}
			}
			if !found {
				t.Errorf("the denied agent did not receive the denial with the note")
			}
		} else if err != nil {
			t.Errorf("allowed write missing: %v", err)
		} else {
			wrote++
		}
	}
	if wrote != 2 {
		t.Errorf("wrote %d files", wrote)
	}
	e.waitApprovals(t, pid, 0)
}

func TestAllowForTurnStopsFurtherPrompts(t *testing.T) {
	e := newEnv(t, nil)
	pid, _ := e.v7Project(t, "supervised")
	stream := e.subscribe(t, pid)
	e.into(t, "POST", "/v1/projects/"+pid+"/messages", map[string]string{"text": "Go [rewrite:{role}.txt]"}, http.StatusAccepted, nil)
	answered := map[string]bool{}
	var evs []sseEvent
	deadline := time.After(30 * time.Second)
loop:
	for {
		select {
		case ev := <-stream:
			evs = append(evs, ev)
			switch ev.Type {
			case "approval.requested":
				a := ev.Data["approval"].(map[string]any)
				id := a["id"].(string)
				if !answered[id] {
					answered[id] = true
					e.answer(t, pid, id, map[string]string{"decision": "allow_for_turn"})
				}
			case "turn.finished":
				break loop
			}
		case <-deadline:
			t.Fatal("timed out")
		}
	}
	// Three agents write twice each; each is asked once.
	if n := count(evs, "approval.requested"); n != 3 {
		t.Fatalf("approval.requested = %d, want 3", n)
	}
	if n := count(evs, "change.recorded"); n != 6 {
		t.Fatalf("change.recorded = %d, want 6", n)
	}
	// The grant lasts one turn: the next turn asks again.
	stream2 := e.subscribe(t, pid)
	e.into(t, "POST", "/v1/projects/"+pid+"/messages", map[string]string{"text": "Again [write:{role}-2.txt]"}, http.StatusAccepted, nil)
	e.waitApprovals(t, pid, 3)
	e.into(t, "POST", "/v1/projects/"+pid+"/cancel", nil, http.StatusAccepted, nil)
	evs = collectUntilTurnFinished(t, stream2)
	if count(evs, "approval.resolved") != 3 {
		t.Fatalf("cancelling did not resolve the pending approvals: %d", count(evs, "approval.resolved"))
	}
	for _, ev := range evs {
		if ev.Type == "approval.resolved" && ev.Data["decision"] != "deny" {
			t.Errorf("cancelled approval resolved as %v", ev.Data["decision"])
		}
	}
	e.waitApprovals(t, pid, 0)
}

func TestSupervisedBashAndFullAccess(t *testing.T) {
	e := newEnv(t, nil)
	pid, folder := e.v7Project(t, "supervised")
	e.into(t, "POST", "/v1/projects/"+pid+"/messages", map[string]string{"text": "Go [bash:echo hi > bash-out.txt]"}, http.StatusAccepted, nil)
	pending := e.waitApprovals(t, pid, 3)
	a := pending[0]
	if a.Kind != "command" || a.Detail.Command != "echo hi > bash-out.txt" || a.Title != a.Detail.Command {
		t.Fatalf("approval = %+v", a)
	}
	// Switching to full access mid-turn does not resolve what is pending, but nothing new asks.
	var proj struct{ Access string }
	e.into(t, "PATCH", "/v1/projects/"+pid, map[string]string{"access": "full"}, http.StatusOK, &proj)
	if proj.Access != "full" {
		t.Fatalf("access = %q", proj.Access)
	}
	e.wantError(t, "PATCH", "/v1/projects/"+pid, map[string]string{"access": "root"}, http.StatusBadRequest, "invalid_request")
	for _, p := range pending {
		e.answer(t, pid, p.ID, map[string]string{"decision": "deny"})
	}
	e.waitApprovals(t, pid, 0)
	deadline := time.Now().Add(20 * time.Second)
	for {
		var p struct{ Status string }
		e.into(t, "GET", "/v1/projects/"+pid, nil, http.StatusOK, &p)
		if p.Status == "idle" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("turn did not finish")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if _, err := os.Stat(filepath.Join(folder, "bash-out.txt")); err == nil {
		t.Fatal("a denied command ran")
	}
	// Full access: no card, the command runs.
	e.runTurn(t, pid, "Again [bash:echo hi > bash-out.txt]")
	if _, err := os.Stat(filepath.Join(folder, "bash-out.txt")); err != nil {
		t.Fatalf("command did not run under full access: %v", err)
	}
	var left approvalsResp
	e.into(t, "GET", "/v1/projects/"+pid+"/approvals", nil, http.StatusOK, &left)
	if len(left.Approvals) != 0 {
		t.Fatalf("approvals under full access: %+v", left.Approvals)
	}
}

func TestAcceptEditsAutoApprovesWritesAndAsksForBash(t *testing.T) {
	e := newEnv(t, nil)
	pid, folder := e.v7Project(t, "accept_edits")
	// Writes auto-approve under accept_edits.
	e.runTurn(t, pid, "Go [write:{role}.md]")
	var left approvalsResp
	e.into(t, "GET", "/v1/projects/"+pid+"/approvals", nil, http.StatusOK, &left)
	if len(left.Approvals) != 0 {
		t.Fatalf("unexpected approvals for writes under accept_edits: %+v", left.Approvals)
	}
	// Commands still ask. `v7Project` runs three sub-agents that each ask for bash; drain every approval until idle.
	seen := e.turnWithApprovals(t, pid, "Go [bash:echo ok > cmd.txt]", allow)
	if len(seen) == 0 {
		t.Fatal("expected command approvals, got none")
	}
	for _, a := range seen {
		if a.Kind != "command" {
			t.Fatalf("expected command approval, got %+v", a)
		}
	}
	if _, err := os.Stat(filepath.Join(folder, "cmd.txt")); err != nil {
		t.Fatalf("approved bash did not run: %v", err)
	}
}
