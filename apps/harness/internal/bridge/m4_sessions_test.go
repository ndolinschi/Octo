package bridge_test

import (
	"net/http"
	"strings"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/memory"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

func TestSessionsAPIOverRealTurns(t *testing.T) {
	e := newEnv(t, nil)
	pid, _ := e.v7Project(t, "full")
	stream := e.subscribe(t, pid)
	var first, second struct{ Message projectstore.Message }
	e.into(t, "POST", "/v1/projects/"+pid+"/messages", map[string]string{"text": "quick: hello there\nsecond line"}, http.StatusAccepted, &first)
	collectUntilTurnFinished(t, stream)
	e.into(t, "POST", "/v1/projects/"+pid+"/messages", map[string]string{"text": "quick: and again"}, http.StatusAccepted, &second)
	collectUntilTurnFinished(t, stream)

	var list struct {
		Sessions []projectstore.Session `json:"sessions"`
	}
	e.into(t, "GET", "/v1/projects/"+pid+"/memory/sessions?limit=5", nil, http.StatusOK, &list)
	if len(list.Sessions) != 1 || list.Sessions[0].Exchanges != 2 || !list.Sessions[0].Open || list.Sessions[0].Title != "quick: hello there" {
		t.Fatalf("sessions = %+v", list.Sessions)
	}
	var d memory.SessionDetail
	e.into(t, "GET", "/v1/projects/"+pid+"/memory/sessions/"+list.Sessions[0].ID, nil, http.StatusOK, &d)
	if len(d.Exchanges) != 2 {
		t.Fatalf("exchanges = %+v", d.Exchanges)
	}
	x := d.Exchanges[0]
	if x.TurnID != first.Message.ID || x.Request != "quick: hello there\nsecond line" || x.Answer == "" || x.Status != "completed" ||
		x.MessageID == 0 || x.Model == "" || x.StartedAt == "" || d.Exchanges[1].TurnID != second.Message.ID {
		t.Fatalf("exchange = %+v", x)
	}
	hits := e.search(t, pid, "again")
	found := false
	for _, h := range hits.Hits {
		found = found || (h.Kind == "exchange" && h.SessionID == list.Sessions[0].ID)
	}
	if !found {
		t.Fatalf("search = %+v", hits)
	}
	e.wantError(t, "GET", "/v1/projects/"+pid+"/memory/sessions/ses_nope", nil, http.StatusNotFound, "not_found")
	e.wantError(t, "GET", "/v1/projects/"+pid+"/memory/sessions?limit=0", nil, http.StatusBadRequest, "invalid_request")

	e.into(t, "DELETE", "/v1/projects/"+pid+"/memory/exchanges/"+x.ID, nil, http.StatusNoContent, nil)
	e.wantError(t, "DELETE", "/v1/projects/"+pid+"/memory/exchanges/exc_nope", nil, http.StatusNotFound, "not_found")
	e.into(t, "GET", "/v1/projects/"+pid+"/memory/sessions/"+list.Sessions[0].ID, nil, http.StatusOK, &d)
	if !d.Exchanges[0].Removed || strings.Contains(d.Exchanges[0].Request, "hello") {
		t.Fatalf("marker = %+v", d.Exchanges[0])
	}
}
