package bridge_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/anthropicclient"
	"github.com/ndolinschi/Octo/apps/harness/internal/bridge"
	"github.com/ndolinschi/Octo/apps/harness/internal/childenv"
	"github.com/ndolinschi/Octo/apps/harness/internal/config"
	"github.com/ndolinschi/Octo/apps/harness/internal/events"
	"github.com/ndolinschi/Octo/apps/harness/internal/orchestrator"
	"github.com/ndolinschi/Octo/apps/harness/internal/project"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
	"github.com/ndolinschi/Octo/apps/harness/internal/settings"
)

const apiSecret = "sk-ant-api03-TOPSECRETTOPSECRET-abcdef123456"

type settingsEnv struct {
	*env
	dir     string
	handler http.Handler
	orch    *orchestrator.Orchestrator
}

// newSettingsEnv wires the stack the way serve does: the settings manager
// applies models to the service and the orchestrator and announces on the hub.
func newSettingsEnv(t *testing.T, loopbackBind bool) *settingsEnv {
	t.Helper()
	t.Cleanup(func() { childenv.SetAllow("") })
	dir := t.TempDir()
	store, err := projectstore.Open(filepath.Join(dir, "db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	hub := events.NewHub()
	notes := project.NewNotes(store, hub)
	orch := orchestrator.New(store, hub, notes, orchestrator.Options{
		Client: anthropicclient.New("k", "http://127.0.0.1:1", ""), MaxTurns: 4, Stream: true,
		DefaultOrchestrator: config.BuiltinModels().Orchestrator,
	})
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = orch.Shutdown(ctx)
	})
	svc := project.NewService(store, hub, orch, project.Defaults{Models: config.BuiltinModels(), MaxDepth: config.DefaultMaxDepth})
	mgr := settings.New(settings.Options{
		DataDir: dir, ValidateModels: svc.ValidateModels,
		Lookup: func(string) (string, bool) { return "", false },
		Apply: settings.Applier{
			Models: func(o, f, b, d string) {
				svc.SetDefaultTiers(o, f, b, d)
				orch.SetDefaultOrchestrator(o)
			},
			ChildEnvAllow: childenv.SetAllow,
		},
		Notify: func(ids []string) { hub.PublishAll(events.SettingsChanged, map[string]any{"ids": ids}) },
	})
	h := bridge.New(svc, notes, project.NewFiles(store, hub), bridge.WithSettings(mgr, loopbackBind))
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return &settingsEnv{env: &env{url: srv.URL}, dir: dir, handler: h, orch: orch}
}

// captureLogs routes slog into a buffer for the length of the test.
func captureLogs(t *testing.T) *syncBuf {
	t.Helper()
	b := &syncBuf{}
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(b, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(prev) })
	return b
}

type syncBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuf) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuf) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

func TestSettingsGetAndPutRoundTrip(t *testing.T) {
	e := newSettingsEnv(t, true)
	var v settings.View
	e.into(t, "GET", "/v1/settings", nil, http.StatusOK, &v)
	if len(v.Settings) != len(settings.IDs()) || len(v.RestartRequired) != 0 {
		t.Fatalf("view = %+v", v)
	}

	e.into(t, "PUT", "/v1/settings", map[string]any{
		"set": map[string]any{
			"ANTHROPIC_API_KEY": apiSecret, "OCTO_ROUTER_ENABLED": true, "HARNESS_MODEL_FAST": "my-fast-model",
		},
	}, http.StatusOK, &v)
	if len(v.RestartRequired) != 2 || v.RestartRequired[0] != "ANTHROPIC_API_KEY" || v.RestartRequired[1] != "OCTO_ROUTER_ENABLED" {
		t.Fatalf("restart_required = %v", v.RestartRequired)
	}
	_, raw := e.do(t, "GET", "/v1/settings", nil)
	if strings.Contains(string(raw), "TOPSECRET") {
		t.Fatalf("GET leaked the secret: %s", raw)
	}
	if !strings.Contains(string(raw), `"hint":"…3456"`) {
		t.Fatalf("no last-4 hint: %s", raw)
	}
	b, err := os.ReadFile(filepath.Join(e.dir, config.EnvFileName))
	if err != nil || !strings.Contains(string(b), "ANTHROPIC_API_KEY="+apiSecret+"\n") {
		t.Fatalf("file = %q, %v", b, err)
	}
	if runtime.GOOS != "windows" {
		if fi, _ := os.Stat(filepath.Join(e.dir, config.EnvFileName)); fi.Mode().Perm() != 0o600 {
			t.Fatalf("mode = %v", fi.Mode())
		}
	}
}

func TestSettingsErrors(t *testing.T) {
	e := newSettingsEnv(t, true)
	e.wantError(t, "PUT", "/v1/settings", map[string]any{"set": map[string]any{"NOPE": "x"}}, http.StatusBadRequest, "unknown_setting")
	e.wantError(t, "PUT", "/v1/settings", map[string]any{"set": map[string]any{"ANTHROPIC_API_KEY": "a\nb"}}, http.StatusBadRequest, "invalid_value")
	e.wantError(t, "PUT", "/v1/settings", map[string]any{"set": map[string]any{"HARNESS_MODEL_DEEP": "acp:ghost"}}, http.StatusBadRequest, "invalid_value")
	e.wantError(t, "PUT", "/v1/settings", map[string]any{"bogus": 1}, http.StatusBadRequest, "invalid_request")
	e.wantError(t, "PUT", "/v1/settings", map[string]any{}, http.StatusBadRequest, "invalid_request")
	status, raw := e.do(t, "PUT", "/v1/settings", "not an object")
	if status != http.StatusBadRequest {
		t.Fatalf("string body = %d %s", status, raw)
	}
	if _, err := os.Stat(filepath.Join(e.dir, config.EnvFileName)); err == nil {
		t.Fatal("a refused request created the file")
	}
}

func TestSettingsInvalidJSONErrorDoesNotEchoTheBody(t *testing.T) {
	e := newSettingsEnv(t, true)
	req, _ := http.NewRequest("PUT", e.url+"/v1/settings", strings.NewReader(`{"set": {"ANTHROPIC_API_KEY": sk-ant-TOPSECRET}}`))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusBadRequest || strings.Contains(string(body), "TOPSECRET") || strings.Contains(string(body), "sk-") {
		t.Fatalf("%d %s", resp.StatusCode, body)
	}
}

// The security rules: remote bind, non-loopback peer, foreign Host or Origin.
func TestSettingsAccessRules(t *testing.T) {
	remote := newSettingsEnv(t, false)
	remote.wantError(t, "GET", "/v1/settings", nil, http.StatusForbidden, "forbidden")
	remote.wantError(t, "PUT", "/v1/settings", map[string]any{"set": map[string]any{"HARNESS_MODEL_FAST": "x"}}, http.StatusForbidden, "forbidden")

	e := newSettingsEnv(t, true)
	call := func(method, remoteAddr, host, origin string) int {
		req := httptest.NewRequest(method, "/v1/settings", strings.NewReader(`{"set":{"HARNESS_MODEL_FAST":"x"}}`))
		req.RemoteAddr = remoteAddr
		if host != "" {
			req.Host = host
		}
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		rec := httptest.NewRecorder()
		e.handler.ServeHTTP(rec, req)
		return rec.Code
	}
	for name, tc := range map[string]struct {
		remote, host, origin string
		want                 int
	}{
		"loopback v4":           {"127.0.0.1:5000", "127.0.0.1:8790", "", 200},
		"loopback v6":           {"[::1]:5000", "[::1]:8790", "", 200},
		"localhost + origin":    {"127.0.0.1:5000", "localhost:8790", "http://localhost:1420", 200},
		"tauri origin":          {"127.0.0.1:5000", "127.0.0.1:8790", "tauri://localhost", 200},
		"lan peer":              {"192.168.1.20:5000", "127.0.0.1:8790", "", 403},
		"foreign host (rebind)": {"127.0.0.1:5000", "evil.example:8790", "", 403},
		"foreign origin":        {"127.0.0.1:5000", "127.0.0.1:8790", "https://evil.example", 403},
		"null origin":           {"127.0.0.1:5000", "127.0.0.1:8790", "null", 403},
	} {
		for _, method := range []string{"GET", "PUT"} {
			if got := call(method, tc.remote, tc.host, tc.origin); got != tc.want {
				t.Errorf("%s %s: %s = %d, want %d", name, tc.remote, method, got, tc.want)
			}
		}
	}
}

// Values never reach logs, error bodies or events.
func TestSettingsValuesNeverAppearInLogsEventsOrErrors(t *testing.T) {
	logs := captureLogs(t)
	e := newSettingsEnv(t, true)
	var p struct{ ID string }
	e.into(t, "POST", "/v1/projects", map[string]any{"name": "p"}, http.StatusCreated, &p)
	stream := e.subscribe(t, p.ID)

	var bodies [][]byte
	for _, u := range []map[string]any{
		{"set": map[string]any{"ANTHROPIC_API_KEY": apiSecret, "OCTO_ROUTER_UPSTREAM_KEY": apiSecret + "-up", "HARNESS_MODEL_FAST": "fast-x"}},
		{"set": map[string]any{"ANTHROPIC_API_KEY": apiSecret + "\nINJECT=1"}}, // refused
		{"set": map[string]any{"ANTHROPIC_API_KEY": strings.Repeat("S", 600)}}, // refused
	} {
		_, raw := e.do(t, "PUT", "/v1/settings", u)
		bodies = append(bodies, raw)
	}
	_, raw := e.do(t, "GET", "/v1/settings", nil)
	bodies = append(bodies, raw)

	deadline := time.After(10 * time.Second)
	var changed sseEvent
	for changed.Type == "" {
		select {
		case ev := <-stream:
			if ev.Type == events.SettingsChanged {
				changed = ev
			}
		case <-deadline:
			t.Fatal("no settings.changed event")
		}
	}
	evRaw, _ := json.Marshal(changed.Data)
	ids, _ := changed.Data["ids"].([]any)
	if len(ids) != 3 || changed.Data["type"] != events.SettingsChanged {
		t.Fatalf("event = %s", evRaw)
	}
	bodies = append(bodies, evRaw)

	for i, b := range bodies {
		if s := string(b); strings.Contains(s, "TOPSECRET") || strings.Contains(s, strings.Repeat("S", 20)) {
			t.Errorf("response/event %d leaks a secret: %s", i, s)
		}
	}
	if l := logs.String(); strings.Contains(l, "TOPSECRET") || strings.Contains(l, strings.Repeat("S", 20)) || strings.Contains(l, "fast-x") {
		t.Fatalf("logs contain a value:\n%s", l)
	}
}

// Models apply at once: GET /v1/config, new projects and the child allow list.
func TestSettingsApplyNowWithoutRestart(t *testing.T) {
	e := newSettingsEnv(t, true)
	var v settings.View
	e.into(t, "PUT", "/v1/settings", map[string]any{"set": map[string]any{
		"HARNESS_MODEL_ORCHESTRATOR": "orch-x", "HARNESS_MODEL_FAST": "fast-x", "HARNESS_MODEL_BALANCED": "bal-x", "HARNESS_MODEL_DEEP": "deep-x",
		"HARNESS_CHILD_ENV_ALLOW": []string{"MY_TOOL_*"},
	}}, http.StatusOK, &v)
	if len(v.RestartRequired) != 0 {
		t.Fatalf("restart_required = %v", v.RestartRequired)
	}
	var cfg struct {
		DefaultModels struct{ Orchestrator, Fast, Balanced, Deep string } `json:"default_models"`
	}
	e.into(t, "GET", "/v1/config", nil, http.StatusOK, &cfg)
	if cfg.DefaultModels.Orchestrator != "orch-x" || cfg.DefaultModels.Fast != "fast-x" ||
		cfg.DefaultModels.Balanced != "bal-x" || cfg.DefaultModels.Deep != "deep-x" {
		t.Fatalf("default_models = %+v", cfg.DefaultModels)
	}
	var p struct {
		Models struct{ Orchestrator, Fast string } `json:"models"`
	}
	e.into(t, "POST", "/v1/projects", map[string]any{"name": "new"}, http.StatusCreated, &p)
	if p.Models.Orchestrator != "orch-x" || p.Models.Fast != "fast-x" {
		t.Fatalf("new project models = %+v", p.Models)
	}
	if got := childenv.Scrub([]string{"MY_TOOL_HOME=/x", "PATH=/bin"}); len(got) != 2 {
		t.Fatalf("allow list not applied: %v", got)
	}
	if got := e.orchestratorDefault(); got != "orch-x" {
		t.Fatalf("orchestrator default = %q", got)
	}

	e.into(t, "PUT", "/v1/settings", map[string]any{"unset": []string{"HARNESS_MODEL_ORCHESTRATOR", "HARNESS_CHILD_ENV_ALLOW"}}, http.StatusOK, &v)
	e.into(t, "GET", "/v1/config", nil, http.StatusOK, &cfg)
	if cfg.DefaultModels.Orchestrator != config.BuiltinModels().Orchestrator || cfg.DefaultModels.Fast != "fast-x" {
		t.Fatalf("after unset: %+v", cfg.DefaultModels)
	}
	if got := childenv.Scrub([]string{"MY_TOOL_HOME=/x", "PATH=/bin"}); len(got) != 1 {
		t.Fatalf("allow list not cleared: %v", got)
	}
}

func (e *settingsEnv) orchestratorDefault() string { return e.orch.DefaultOrchestrator() }

// Concurrent PUTs, config reads and project creation (go test -race).
func TestSettingsConcurrentWithRequests(t *testing.T) {
	e := newSettingsEnv(t, true)
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(3)
		go func(i int) {
			defer wg.Done()
			for j := 0; j < 10; j++ {
				status, raw := e.do(t, "PUT", "/v1/settings", map[string]any{"set": map[string]any{
					"HARNESS_MODEL_ORCHESTRATOR": "o" + string(rune('a'+i)), "HARNESS_MODEL_FAST": "f" + string(rune('a'+j)),
				}})
				if status != 200 {
					t.Errorf("put = %d %s", status, raw)
					return
				}
			}
		}(i)
		go func() {
			defer wg.Done()
			for j := 0; j < 10; j++ {
				e.do(t, "GET", "/v1/config", nil)
				e.do(t, "GET", "/v1/settings", nil)
			}
		}()
		go func() {
			defer wg.Done()
			for j := 0; j < 5; j++ {
				e.do(t, "POST", "/v1/projects", map[string]any{"name": "c"})
			}
		}()
	}
	wg.Wait()
}

func TestSettingsRoutesAbsentWithoutStore(t *testing.T) {
	e := newEnv(t, nil)
	e.wantError(t, "GET", "/v1/settings", nil, http.StatusNotFound, "not_found")
}
