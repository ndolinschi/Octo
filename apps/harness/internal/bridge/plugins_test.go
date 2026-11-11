package bridge_test

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/events"
	"github.com/ndolinschi/Octo/apps/harness/internal/fakeacp"
	"github.com/ndolinschi/Octo/apps/harness/internal/fakelsp"
	"github.com/ndolinschi/Octo/apps/harness/internal/mcprelay"
	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

func TestMain(m *testing.M) {
	// The stdio MCP relay is this test binary started as `mcp-relay ...`; it
	// must win over the fake-agent mode its parent's environment is still in.
	if len(os.Args) > 1 && os.Args[1] == "mcp-relay" {
		os.Exit(mcprelay.Main(os.Args[2:]))
	}
	if fakeacp.ChildMode() {
		os.Exit(fakeacp.Main())
	}
	if fakelsp.ChildMode() {
		os.Exit(fakelsp.Main())
	}
	os.Exit(m.Run())
}

func writeManifest(t *testing.T, dataDir, name string, manifest map[string]any) {
	t.Helper()
	dir := filepath.Join(dataDir, "plugins", name)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, plugins.ManifestName), raw, 0o644); err != nil {
		t.Fatal(err)
	}
}

func fakeACPRegistry(t *testing.T) *plugins.Registry {
	t.Helper()
	data := t.TempDir()
	writeManifest(t, data, "fake-acp", map[string]any{
		"name": "fake-acp", "version": "0.1.0", "description": "scripted agent",
		"agents": []map[string]any{{
			"id": "fake", "label": "Fake ACP", "command": os.Args[0],
			"env": map[string]string{fakeacp.EnvChild: "1", "GORACE": "atexit_sleep_ms=0"},
		}},
		"languageServers": []map[string]any{{"id": "gopls", "languages": []string{"go"}, "command": "definitely-not-installed-xyz"}},
	})
	writeManifest(t, data, "broken", map[string]any{"name": "Broken"})
	return plugins.Load(context.Background(), data, nil, nil)
}

func TestPluginsEndpoint(t *testing.T) {
	e := newEnvWith(t, nil, fakeACPRegistry(t))
	status, raw := e.do(t, "GET", "/v1/plugins", nil)
	if status != http.StatusOK {
		t.Fatalf("status = %d: %s", status, raw)
	}
	var body struct {
		Plugins []struct {
			Name            string `json:"name"`
			Version         string `json:"version"`
			Description     string `json:"description"`
			LanguageServers []struct {
				ID        string   `json:"id"`
				Label     string   `json:"label"`
				Languages []string `json:"languages"`
				Available bool     `json:"available"`
			} `json:"language_servers"`
			Agents []struct {
				ID        string `json:"id"`
				Label     string `json:"label"`
				Available bool   `json:"available"`
			} `json:"agents"`
			ToolServers []struct{ URL string } `json:"tool_servers"`
			Errors      []string               `json:"errors"`
		} `json:"plugins"`
	}
	if err := json.Unmarshal(raw, &body); err != nil || len(body.Plugins) != 2 {
		t.Fatalf("body = %s (%v)", raw, err)
	}
	good, bad := body.Plugins[0], body.Plugins[1]
	if bad.Name == "fake-acp" {
		good, bad = bad, good
	}
	if good.Name != "fake-acp" || good.Version != "0.1.0" || len(good.Errors) != 0 ||
		len(good.Agents) != 1 || good.Agents[0].ID != "fake" || !good.Agents[0].Available || good.Agents[0].Label != "Fake ACP" {
		t.Fatalf("good plugin = %+v", good)
	}
	if len(good.LanguageServers) != 1 || good.LanguageServers[0].Available || good.LanguageServers[0].Languages[0] != "go" {
		t.Fatalf("language servers = %+v", good.LanguageServers)
	}
	if len(bad.Errors) == 0 || len(bad.Agents) != 0 {
		t.Fatalf("broken plugin = %+v", bad)
	}
	for _, leak := range []string{`"command"`, `"args"`, `"env"`, os.Args[0]} {
		if strings.Contains(string(raw), leak) {
			t.Fatalf("response leaks %s: %s", leak, raw)
		}
	}
	// arrays are never null; logged_in is null when an agent has no probe
	if strings.Contains(strings.ReplaceAll(string(raw), `"logged_in":null`, ""), "null") {
		t.Fatalf("null in response: %s", raw)
	}
}

func TestPluginsEndpointEmptyAndReadOnly(t *testing.T) {
	e := newEnv(t, nil)
	var out struct{ Plugins []any }
	e.into(t, "GET", "/v1/plugins", nil, http.StatusOK, &out)
	if out.Plugins == nil || len(out.Plugins) != 0 {
		t.Fatalf("plugins = %#v", out.Plugins)
	}
	for _, m := range []string{"POST", "PUT", "PATCH", "DELETE"} {
		for _, path := range []string{"/v1/plugins", "/v1/plugins/x"} {
			status, _ := e.do(t, m, path, map[string]string{"name": "x"})
			if status < 400 {
				t.Errorf("%s %s = %d, want an error: plugins are read-only", m, path, status)
			}
		}
	}
	req, err := http.NewRequest(http.MethodGet, e.url+"/v1/plugins", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Origin", "http://localhost:1420")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.Header.Get("Access-Control-Allow-Origin") != "http://localhost:1420" {
		t.Errorf("CORS header missing on /v1/plugins")
	}
}

func TestACPSubAgentOverHTTP(t *testing.T) {
	e := newEnvWith(t, nil, fakeACPRegistry(t))
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("# Bridge demo\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	var p struct{ ID string }
	e.into(t, "POST", "/v1/projects", map[string]any{"name": "acp", "folders": []map[string]string{{"path": dir}}}, http.StatusCreated, &p)
	stream := e.subscribe(t, p.ID)
	e.into(t, "POST", "/v1/projects/"+p.ID+"/messages", map[string]string{"text": "[acp] summarize this repo"}, http.StatusAccepted, nil)
	evs := collectUntilTurnFinished(t, stream)
	if count(evs, events.FileChanged) != 1 || count(evs, events.ToolStarted) < 2 {
		t.Errorf("events: file.changed=%d tool.started=%d", count(evs, events.FileChanged), count(evs, events.ToolStarted))
	}

	var agents struct{ Agents []projectstore.Agent }
	e.into(t, "GET", "/v1/projects/"+p.ID+"/agents", nil, http.StatusOK, &agents)
	var child *projectstore.Agent
	for i, a := range agents.Agents {
		if a.Model == "acp:fake" {
			child = &agents.Agents[i]
		}
	}
	if child == nil || child.Status != projectstore.StatusCompleted {
		t.Fatalf("agents = %+v", agents.Agents)
	}
	var msgs struct{ Messages []projectstore.Message }
	e.into(t, "GET", "/v1/projects/"+p.ID+"/agents/"+child.ID+"/messages", nil, http.StatusOK, &msgs)
	names := map[string]bool{}
	results := 0
	for _, m := range msgs.Messages {
		for _, b := range m.Content {
			if b.Type == "tool_use" {
				names[*b.Name] = true
			}
			if b.Type == "tool_result" {
				results++
			}
		}
	}
	if !names["read"] || !names["edit"] || results != 2 {
		t.Fatalf("transcript tool names = %v results = %d", names, results)
	}
	if _, err := os.Stat(filepath.Join(dir, fakeacp.NoteFile)); err != nil {
		t.Fatalf("note not written: %v", err)
	}
}
