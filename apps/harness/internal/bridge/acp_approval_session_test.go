package bridge_test

import (
	"net/http"
	"testing"
	"time"
)

// An ACP orchestrator's permission request is a card of the turn's main session, like a built-in card: a client
// that reloads reads it back with GET /approvals?session= and the session counts it in needs_you.
func TestACPApprovalBelongsToItsMainSession(t *testing.T) {
	e := newACPEnv(t, nil, nil)
	var p projectJSON
	e.into(t, "POST", "/v1/projects", map[string]any{
		"name": "acp", "folders": []map[string]string{{"path": e.dir}}, "access": "supervised",
		"models": map[string]string{"orchestrator": "acp:scripted"},
	}, http.StatusCreated, &p)
	var sent struct {
		Message struct {
			SessionID string `json:"session_id"`
		} `json:"message"`
	}
	e.into(t, "POST", "/v1/projects/"+p.ID+"/messages", map[string]string{"text": "Please read README.md and summarise it"}, http.StatusAccepted, &sent)
	sid := sent.Message.SessionID
	if sid == "" {
		t.Fatal("the message names no session")
	}
	all := e.waitApprovals(t, p.ID, 1)
	if all[0].Kind != "acp" || all[0].SessionID != sid {
		t.Fatalf("approval = %+v, want kind acp in session %s", all[0], sid)
	}
	var scoped approvalsResp
	e.into(t, "GET", "/v1/projects/"+p.ID+"/approvals?session="+sid, nil, http.StatusOK, &scoped)
	if len(scoped.Approvals) != 1 || scoped.Approvals[0].ID != all[0].ID {
		t.Fatalf("GET /approvals?session=%s = %+v, want the ACP card", sid, scoped.Approvals)
	}
	var sessions struct {
		Sessions []struct {
			ID               string `json:"id"`
			NeedsYou         bool   `json:"needs_you"`
			PendingApprovals int    `json:"pending_approvals"`
		} `json:"sessions"`
	}
	e.into(t, "GET", "/v1/projects/"+p.ID+"/sessions", nil, http.StatusOK, &sessions)
	found := false
	for _, s := range sessions.Sessions {
		if s.ID == sid {
			found = true
			if !s.NeedsYou || s.PendingApprovals != 1 {
				t.Fatalf("session %s: needs_you=%v pending_approvals=%d, want true/1", sid, s.NeedsYou, s.PendingApprovals)
			}
		}
	}
	if !found {
		t.Fatalf("session %s not listed: %+v", sid, sessions.Sessions)
	}
	e.answer(t, p.ID, all[0].ID, map[string]string{"decision": "allow"})
	deadline := time.Now().Add(20 * time.Second)
	for {
		var got approvalsResp
		e.into(t, "GET", "/v1/projects/"+p.ID+"/approvals", nil, http.StatusOK, &got)
		if len(got.Approvals) == 0 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("approvals still pending: %+v", got.Approvals)
		}
		time.Sleep(20 * time.Millisecond)
	}
}
