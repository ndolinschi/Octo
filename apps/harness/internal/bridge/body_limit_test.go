package bridge_test

import (
	"net/http"
	"strings"
	"testing"
)

// P2-6: a message body over the bridge's 1 MiB limit is 413 request_too_large
// with the limit in its sentence, not 400 "That request was not valid".
func TestBodyOverTheLimitIs413WithTheLimit(t *testing.T) {
	e := newEnv(t, nil)
	var p struct{ ID string }
	e.into(t, http.MethodPost, "/v1/projects", map[string]any{"name": "big", "folders": []map[string]string{{"path": t.TempDir()}}}, http.StatusCreated, &p)

	var resp struct {
		Error struct{ Code, Message, Hint, Details string } `json:"error"`
	}
	e.into(t, http.MethodPost, "/v1/projects/"+p.ID+"/messages", map[string]string{"text": strings.Repeat("x", 1<<20+10)}, http.StatusRequestEntityTooLarge, &resp)
	if resp.Error.Code != "request_too_large" || !strings.Contains(resp.Error.Message, "1 MB") || resp.Error.Hint == "" || !strings.Contains(resp.Error.Details, "1048576") {
		t.Fatalf("error = %+v", resp.Error)
	}

	// A malformed body under the limit is still 400 invalid_request.
	status, raw := e.do(t, http.MethodPost, "/v1/projects/"+p.ID+"/messages", nil)
	if status != http.StatusBadRequest || !strings.Contains(string(raw), "invalid_request") {
		t.Fatalf("empty body = %d %s", status, raw)
	}
}
