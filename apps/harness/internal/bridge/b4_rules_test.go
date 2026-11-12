package bridge_test

import (
	"net/http"
	"path/filepath"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/approval"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

type rulesResp struct {
	Rules []projectstore.ApprovalRule `json:"rules"`
}

func (e *env) rules(t *testing.T, pid string) []projectstore.ApprovalRule {
	t.Helper()
	var r rulesResp
	e.into(t, "GET", "/v1/projects/"+pid+"/approval-rules", nil, http.StatusOK, &r)
	return r.Rules
}

// turnWithApprovals posts text and answers every approval the turn raises with
// answer(a); it returns the approvals it saw and waits for the project to go idle.
func (e *env) turnWithApprovals(t *testing.T, pid, text string, answer func(a approval.Approval) map[string]string) []approval.Approval {
	t.Helper()
	e.into(t, "POST", "/v1/projects/"+pid+"/messages", map[string]string{"text": text}, http.StatusAccepted, nil)
	return e.drain(t, pid, answer)
}

// drain answers approvals until the project is idle.
func (e *env) drain(t *testing.T, pid string, answer func(a approval.Approval) map[string]string) []approval.Approval {
	t.Helper()
	var seen []approval.Approval
	for i := 0; i < 400; i++ {
		var got approvalsResp
		e.into(t, "GET", "/v1/projects/"+pid+"/approvals", nil, http.StatusOK, &got)
		for _, a := range got.Approvals {
			seen = append(seen, a)
			e.answer(t, pid, a.ID, answer(a))
		}
		var p struct{ Status string }
		e.into(t, "GET", "/v1/projects/"+pid, nil, http.StatusOK, &p)
		if p.Status == "idle" && len(got.Approvals) == 0 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	e.waitIdle(t, pid)
	return seen
}

func allow(approval.Approval) map[string]string { return map[string]string{"decision": "allow"} }
func deny(approval.Approval) map[string]string {
	return map[string]string{"decision": "deny", "note": "no"}
}

func TestAllowAlwaysSavesACommandPrefixRule(t *testing.T) {
	e := newEnv(t, nil)
	pid, _ := e.v7Project(t, "supervised")

	// 1. The first request is asked about, and carries the rule it would save.
	first := e.turnWithApprovals(t, pid, "Go [bash:git status]", func(a approval.Approval) map[string]string {
		if a.SuggestedRule == nil || a.SuggestedRule.Tool != "bash" || a.SuggestedRule.Match != "git status" || a.SuggestedRule.Exact || a.Tool != "bash" {
			t.Errorf("approval = %+v suggested = %+v", a, a.SuggestedRule)
		}
		return map[string]string{"decision": "allow_always"}
	})
	if len(first) < 1 {
		t.Fatal("no approval was raised")
	}
	rules := e.rules(t, pid)
	if len(rules) != 1 || rules[0].Tool != "bash" || rules[0].Match != "git status" || rules[0].Exact || rules[0].ID == "" || rules[0].CreatedAt == "" {
		t.Fatalf("rules = %+v (several identical answers must save one rule)", rules)
	}

	// 2. The same command, and the same command with more arguments, no longer ask.
	if seen := e.turnWithApprovals(t, pid, "Go [bash:git status]", deny); len(seen) != 0 {
		t.Fatalf("a covered command raised %d approvals", len(seen))
	}
	if seen := e.turnWithApprovals(t, pid, "Go [bash:git status --short]", deny); len(seen) != 0 {
		t.Fatalf("a covered command with arguments raised %d approvals", len(seen))
	}

	// 3. A compound command that merely starts with it is asked about.
	for _, cmd := range []string{"git status && echo hi", "git status; echo hi", "git status | cat", "git statusx", "git log"} {
		seen := e.turnWithApprovals(t, pid, "Go [bash:"+cmd+"]", deny)
		if len(seen) == 0 {
			t.Errorf("%q was allowed by a rule for git status", cmd)
		}
	}

	// 4. Deleting the rule makes the first command ask again.
	e.wantError(t, "DELETE", "/v1/projects/"+pid+"/approval-rules/rul_nope", nil, http.StatusNotFound, "not_found")
	e.into(t, "DELETE", "/v1/projects/"+pid+"/approval-rules/"+rules[0].ID, nil, http.StatusNoContent, nil)
	if got := e.rules(t, pid); len(got) != 0 {
		t.Fatalf("rules after delete = %+v", got)
	}
	if seen := e.turnWithApprovals(t, pid, "Go [bash:git status]", deny); len(seen) == 0 {
		t.Fatal("a deleted rule still allows the command")
	}
	e.wantError(t, "GET", "/v1/projects/prj_nope/approval-rules", nil, http.StatusNotFound, "not_found")
}

func TestAllowAlwaysRefusedWhenNoRuleCanBeSaved(t *testing.T) {
	e := newEnv(t, nil)
	pid, _ := e.v7Project(t, "supervised")
	e.into(t, "POST", "/v1/projects/"+pid+"/messages", map[string]string{"text": "Go [bash:git status && echo hi]"}, http.StatusAccepted, nil)
	pending := e.waitApprovals(t, pid, 1)
	if pending[0].SuggestedRule != nil {
		t.Fatalf("a compound command must carry no suggested rule: %+v", pending[0].SuggestedRule)
	}
	e.wantError(t, "POST", "/v1/projects/"+pid+"/approvals/"+pending[0].ID, map[string]string{"decision": "allow_always"}, http.StatusUnprocessableEntity, "no_rule")
	e.wantError(t, "POST", "/v1/projects/"+pid+"/approvals/"+pending[0].ID, map[string]string{"decision": "allow_always", "match": "git status"}, http.StatusUnprocessableEntity, "no_rule")
	if len(e.rules(t, pid)) != 0 {
		t.Fatal("a refused answer saved a rule")
	}
	// The approval is still pending and can be answered normally.
	still := false
	for _, a := range e.waitApprovals(t, pid, 1) {
		still = still || a.ID == pending[0].ID
	}
	if !still {
		t.Fatal("a refused allow_always resolved the approval")
	}
	e.drain(t, pid, deny)
}

func TestAllowAlwaysMatchOverrideMustCoverTheRequest(t *testing.T) {
	e := newEnv(t, nil)
	pid, _ := e.v7Project(t, "supervised")
	e.into(t, "POST", "/v1/projects/"+pid+"/messages", map[string]string{"text": "Go [bash:git log --oneline -3]"}, http.StatusAccepted, nil)
	pending := e.waitApprovals(t, pid, 1)
	for _, bad := range []string{"npm", "git status", "git log --oneline -3 -4"} {
		e.wantError(t, "POST", "/v1/projects/"+pid+"/approvals/"+pending[0].ID, map[string]string{"decision": "allow_always", "match": bad}, http.StatusBadRequest, "invalid_request")
	}
	e.answer(t, pid, pending[0].ID, map[string]string{"decision": "allow_always", "match": "git"})
	e.drain(t, pid, allow)
	if r := e.rules(t, pid); len(r) != 1 || r[0].Match != "git" {
		t.Fatalf("rules = %+v", r)
	}
}

func TestAllowAlwaysSavesAPathRuleForFileTools(t *testing.T) {
	e := newEnv(t, nil)
	pid, folder := e.v7Project(t, "supervised")
	first := e.turnWithApprovals(t, pid, "Go [write:{role}.md]", func(a approval.Approval) map[string]string {
		if a.Tool != "write_file" || a.SuggestedRule == nil || a.SuggestedRule.Match != a.Detail.Path || a.Detail.Patch == "" {
			t.Errorf("approval = %+v suggested %+v", a, a.SuggestedRule)
		}
		return map[string]string{"decision": "allow_always", "match": "*.md"}
	})
	if len(first) < 1 {
		t.Fatal("no approval")
	}
	if r := e.rules(t, pid); len(r) != 1 || r[0].Tool != "write_file" || r[0].Match != "*.md" {
		t.Fatalf("rules = %+v", r)
	}
	// Another markdown file is written without asking; a file the rule does not cover is asked about.
	if seen := e.turnWithApprovals(t, pid, "Again [write:{role}-two.md]", deny); len(seen) != 0 {
		t.Fatalf("a covered path raised %d approvals", len(seen))
	}
	matches, _ := filepath.Glob(filepath.Join(folder, "*-two.md"))
	if len(matches) != 3 {
		t.Fatalf("covered writes = %v", matches)
	}
	if seen := e.turnWithApprovals(t, pid, "Again [write:{role}.txt]", deny); len(seen) == 0 {
		t.Fatal("a path outside the rule was allowed")
	}
	if m, _ := filepath.Glob(filepath.Join(folder, "*.txt")); len(m) != 0 {
		t.Fatalf("denied writes happened: %v", m)
	}
}
