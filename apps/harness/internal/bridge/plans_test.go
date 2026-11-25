package bridge_test

import (
	"net/http"
	"testing"
)

// A project without a plan answers 200 {"plan": null}, not a 404 the browser logs (parity B3).
func TestLatestPlanIsNullWithoutOne(t *testing.T) {
	e := newEnv(t, nil)
	pid, _ := e.v7Project(t, "full")
	var out map[string]any
	e.into(t, "GET", "/v1/projects/"+pid+"/plans/latest", nil, http.StatusOK, &out)
	if v, ok := out["plan"]; !ok || v != nil {
		t.Fatalf("body = %v, want {\"plan\": null}", out)
	}
}
