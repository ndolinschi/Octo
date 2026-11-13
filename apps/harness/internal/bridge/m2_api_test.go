package bridge_test

import (
	"net/http"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/orchestrator"
	"github.com/ndolinschi/Octo/apps/harness/internal/project"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

func TestMemorySettingAndTurnReceiptOverHTTP(t *testing.T) {
	e := newEnv(t, nil)
	folder := t.TempDir()
	var p project.Project
	e.into(t, "POST", "/v1/projects", map[string]any{"name": "m", "folders": []map[string]string{{"path": folder}}}, http.StatusCreated, &p)
	if p.Memory.Context != "full" || p.Memory.RecentExchanges != 5 {
		t.Fatalf("default memory setting = %+v: full stays the default", p.Memory)
	}
	e.into(t, "PATCH", "/v1/projects/"+p.ID, map[string]any{"memory": map[string]any{"context": "window"}}, http.StatusOK, &p)
	if p.Memory.Context != "window" || p.Memory.RecentExchanges != 5 {
		t.Fatalf("after PATCH = %+v", p.Memory)
	}
	e.into(t, "PATCH", "/v1/projects/"+p.ID, map[string]any{"memory": map[string]any{"recent_exchanges": 3}}, http.StatusOK, &p)
	if p.Memory.Context != "window" || p.Memory.RecentExchanges != 3 {
		t.Fatalf("a partial PATCH must keep the other field: %+v", p.Memory)
	}
	for _, bad := range []map[string]any{{"context": "everything"}, {"recent_exchanges": 99}, {"recent_exchanges": -1}} {
		e.wantError(t, "PATCH", "/v1/projects/"+p.ID, map[string]any{"memory": bad}, http.StatusBadRequest, "invalid_request")
	}
	var created project.Project
	e.into(t, "POST", "/v1/projects", map[string]any{"name": "w", "memory": map[string]any{"context": "window", "recent_exchanges": 7}}, http.StatusCreated, &created)
	if created.Memory.Context != "window" || created.Memory.RecentExchanges != 7 {
		t.Fatalf("created with = %+v", created.Memory)
	}

	// A turn leaves its context receipt, readable by the id of its user message.
	stream := e.subscribe(t, p.ID)
	var posted struct{ Message projectstore.Message }
	e.into(t, "POST", "/v1/projects/"+p.ID+"/messages", map[string]string{"text": "quick: hello"}, http.StatusAccepted, &posted)
	collectUntilTurnFinished(t, stream)
	var rc orchestrator.Receipt
	e.into(t, "GET", "/v1/projects/"+p.ID+"/turns/"+itoa(posted.Message.ID)+"/context", nil, http.StatusOK, &rc)
	if rc.TurnID != posted.Message.ID || rc.Mode != "window" || rc.RecentExchanges != 3 || len(rc.Blocks) != 4 || rc.Blocks[len(rc.Blocks)-1].Name != "current_turn" {
		t.Fatalf("receipt = %+v", rc)
	}
	e.wantError(t, "GET", "/v1/projects/"+p.ID+"/turns/999999/context", nil, http.StatusNotFound, "not_found")
	e.wantError(t, "GET", "/v1/projects/"+p.ID+"/turns/abc/context", nil, http.StatusNotFound, "not_found")
	e.wantError(t, "GET", "/v1/projects/prj_nope/turns/1/context", nil, http.StatusNotFound, "not_found")
}
