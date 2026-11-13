package bridge_test

import (
	"net/http"
	"strings"
	"testing"
)

func TestCompleteEndpoint(t *testing.T) {
	e := newEnv(t, nil)
	var proj struct{ ID string }
	e.into(t, "POST", "/v1/projects", map[string]any{"name": "p", "folders": []map[string]string{{"path": t.TempDir()}}}, 201, &proj)
	url := "/v1/projects/" + proj.ID + "/complete"
	body := map[string]any{"path": "main.go", "language": "go", "prefix": "func f() {\n\t[complete: return 42]", "suffix": "\n}\n"}

	// Off until a model is chosen.
	e.wantError(t, "POST", url, body, http.StatusConflict, "completion_off")
	e.wantError(t, "POST", "/v1/projects/prj_missing/complete", body, http.StatusNotFound, "not_found")

	// Settings: an ACP agent is refused, a tier is accepted.
	e.wantError(t, "PATCH", "/v1/projects/"+proj.ID, map[string]any{"models": map[string]string{"completion": "acp:claude-code"}}, http.StatusBadRequest, "invalid_request")
	var p struct {
		Models struct{ Completion string } `json:"models"`
	}
	e.into(t, "PATCH", "/v1/projects/"+proj.ID, map[string]any{"models": map[string]string{"completion": "fast"}}, 200, &p)
	if p.Models.Completion != "fast" {
		t.Fatalf("models.completion = %q", p.Models.Completion)
	}

	var out struct {
		Text, Model string
		MS          *int64
	}
	e.into(t, "POST", url, body, 200, &out)
	if out.Text != "return 42" || out.Model == "" || out.MS == nil {
		t.Fatalf("response = %+v", out)
	}

	// Bad requests.
	e.wantError(t, "POST", url, map[string]any{"path": "", "prefix": "x"}, http.StatusBadRequest, "invalid_request")
	e.wantError(t, "POST", url, map[string]any{"path": "a.go", "prefix": strings.Repeat("x", 6001)}, http.StatusBadRequest, "invalid_request")
	e.wantError(t, "POST", url, map[string]any{"path": "a.go", "prefix": "x", "max_lines": 99}, http.StatusBadRequest, "invalid_request")

	// Never-sent file: 204 with the reason in a header, no model call.
	status, raw := e.do(t, "POST", url, map[string]any{"path": ".env", "prefix": "TOKEN="})
	if status != http.StatusNoContent || len(raw) != 0 {
		t.Fatalf(".env = %d %q", status, raw)
	}

	// Nothing to suggest: 204.
	status, _ = e.do(t, "POST", url, map[string]any{"path": "a.go", "prefix": "x := 1\n[complete: ]"})
	if status != http.StatusNoContent {
		t.Fatalf("empty suggestion = %d, want 204", status)
	}

	// "off" turns it off again.
	p.Models.Completion = ""
	e.into(t, "PATCH", "/v1/projects/"+proj.ID, map[string]any{"models": map[string]string{"completion": "off"}}, 200, &p)
	var got struct {
		Models map[string]any `json:"models"`
	}
	e.into(t, "GET", "/v1/projects/"+proj.ID, nil, 200, &got)
	if _, has := got.Models["completion"]; has || p.Models.Completion != "" {
		t.Fatalf("after off = %q", p.Models.Completion)
	}
	e.wantError(t, "POST", url, body, http.StatusConflict, "completion_off")
}
