package orchestrator_test

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/bridge"
	"github.com/ndolinschi/Octo/apps/harness/internal/project"
)

// api serves the rig through the real bridge handler.
type api struct {
	url string
	t   *testing.T
}

func (r *rig) api(t *testing.T) *api {
	t.Helper()
	srv := httptest.NewServer(bridge.New(r.svc, r.notes, project.NewFiles(r.store, r.hub)))
	t.Cleanup(srv.Close)
	return &api{url: srv.URL, t: t}
}

// do sends one request and returns the status and the decoded JSON object.
func (a *api) do(method, path string, body any) (int, map[string]any) {
	a.t.Helper()
	var rdr io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			a.t.Fatal(err)
		}
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, a.url+path, rdr)
	if err != nil {
		a.t.Fatal(err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		a.t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	out := map[string]any{}
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &out); err != nil {
			a.t.Fatalf("%s %s: bad JSON %q", method, path, raw)
		}
	}
	return resp.StatusCode, out
}

func remarshal(in map[string]any, out any) error {
	raw, err := json.Marshal(in)
	if err != nil {
		return err
	}
	return json.Unmarshal(raw, out)
}
