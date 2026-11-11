package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/config"
	"github.com/ndolinschi/Octo/apps/harness/internal/settings"
)

// startServe runs serve on addr with the data dir's harness.env read the way
// `harness serve` reads it, and returns the base URL once /health answers.
func startServe(t *testing.T, dataDir, bindHost string) string {
	t.Helper()
	cfg, _, err := serveConfig([]string{"--data-dir", dataDir})
	if err != nil {
		t.Fatal(err)
	}
	_, port, _ := strings.Cut(freeAddr(t), ":")
	addr := bindHost + ":" + port
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- serve(ctx, cfg, addr) }()
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(15 * time.Second):
			t.Error("serve did not stop")
		}
	})
	base := "http://127.0.0.1:" + port
	deadline := time.Now().Add(10 * time.Second)
	for {
		resp, err := http.Get(base + "/health")
		if err == nil {
			resp.Body.Close()
			return base
		}
		if time.Now().After(deadline) {
			t.Fatal(err)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func request(t *testing.T, method, url string, body any) (int, []byte) {
	t.Helper()
	var rdr io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rdr = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, url, rdr)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	out, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, out
}

func settingsView(t *testing.T, base string) map[string]settings.Setting {
	t.Helper()
	status, raw := request(t, "GET", base+"/v1/settings", nil)
	if status != 200 {
		t.Fatalf("GET /v1/settings = %d %s", status, raw)
	}
	var v settings.View
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	out := map[string]settings.Setting{}
	for _, s := range v.Settings {
		out[s.ID] = s
	}
	return out
}

// Settings read from harness.env are reported as file, anything the process
// environment holds wins and is locked, and a write is live at once.
func TestServeSettingsEndToEnd(t *testing.T) {
	emptyEnv(t)
	dir := t.TempDir()
	envFile := "# written by hand\nHARNESS_MODEL_FAST=file-fast\nHARNESS_MODEL_DEEP=file-deep\nOCTO_ROUTER_ENABLED=1\nUNRELATED=keep me\n"
	if err := os.WriteFile(filepath.Join(dir, config.EnvFileName), []byte(envFile), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HARNESS_MODEL_DEEP", "env-deep") // the environment beats the file
	t.Cleanup(func() {
		for _, k := range []string{"HARNESS_MODEL_FAST", "OCTO_ROUTER_ENABLED", "UNRELATED"} {
			_ = os.Unsetenv(k)
		}
	})
	base := startServe(t, dir, "127.0.0.1")

	s := settingsView(t, base)
	if f := s["HARNESS_MODEL_FAST"]; f.Source != "file" || f.Value != "file-fast" || !f.Editable {
		t.Fatalf("fast = %+v", f)
	}
	if d := s["HARNESS_MODEL_DEEP"]; d.Source != "environment" || d.Value != "env-deep" || d.Editable {
		t.Fatalf("deep = %+v", d)
	}
	if r := s["OCTO_ROUTER_ENABLED"]; r.Source != "file" || r.Value != true {
		t.Fatalf("router = %+v", r)
	}
	status, raw := request(t, "PUT", base+"/v1/settings", map[string]any{"set": map[string]any{"HARNESS_MODEL_DEEP": "x"}})
	if status != 400 || !strings.Contains(string(raw), "setting_locked") {
		t.Fatalf("PUT locked = %d %s", status, raw)
	}

	status, raw = request(t, "PUT", base+"/v1/settings", map[string]any{"set": map[string]any{
		"HARNESS_MODEL_FAST": "new-fast", "ANTHROPIC_API_KEY": "sk-ant-ENDTOENDSECRET-0000",
	}})
	if status != 200 || strings.Contains(string(raw), "ENDTOENDSECRET") {
		t.Fatalf("PUT = %d %s", status, raw)
	}
	var cfg struct {
		DefaultModels struct{ Fast string }    `json:"default_models"`
		BuiltinLoop   struct{ Available bool } `json:"builtin_loop"`
	}
	_, raw = request(t, "GET", base+"/v1/config", nil)
	if err := json.Unmarshal(raw, &cfg); err != nil || cfg.DefaultModels.Fast != "new-fast" {
		t.Fatalf("config = %s (%v)", raw, err)
	}
	// A key written now takes a restart: the loop is still unavailable here.
	if cfg.BuiltinLoop.Available {
		t.Fatal("the built-in loop changed without a restart")
	}
	b, _ := os.ReadFile(filepath.Join(dir, config.EnvFileName))
	if !strings.Contains(string(b), "# written by hand\n") || !strings.Contains(string(b), "UNRELATED=keep me\n") ||
		!strings.Contains(string(b), "HARNESS_MODEL_FAST=new-fast\n") {
		t.Fatalf("file = %q", b)
	}
	if k := settingsView(t, base)["ANTHROPIC_API_KEY"]; !k.Set || k.Source != "file" || k.Value != nil {
		t.Fatalf("key = %+v", k)
	}
	_, raw = request(t, "GET", base+"/v1/settings", nil)
	var full settings.View
	_ = json.Unmarshal(raw, &full)
	if len(full.RestartRequired) != 1 || full.RestartRequired[0] != "ANTHROPIC_API_KEY" {
		t.Fatalf("restart_required = %v", full.RestartRequired)
	}
}

func TestServeSettingsRefusedOnARemoteBind(t *testing.T) {
	emptyEnv(t)
	dir := t.TempDir()
	base := startServe(t, dir, "0.0.0.0")
	status, raw := request(t, "GET", base+"/v1/settings", nil)
	if status != http.StatusForbidden {
		t.Fatalf("GET = %d %s", status, raw)
	}
	status, _ = request(t, "PUT", base+"/v1/settings", map[string]any{"set": map[string]any{"HARNESS_MODEL_FAST": "x"}})
	if status != http.StatusForbidden {
		t.Fatalf("PUT = %d", status)
	}
	if _, err := os.Stat(filepath.Join(dir, config.EnvFileName)); err == nil {
		t.Fatal("file written")
	}
}

// A harness.env naming an agent that is gone must not stop the app starting.
func TestServeStartsWithAStaleACPModelInTheSettingsFile(t *testing.T) {
	emptyEnv(t)
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, config.EnvFileName), []byte("HARNESS_MODEL_ORCHESTRATOR=acp:ghost\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Unsetenv("HARNESS_MODEL_ORCHESTRATOR") })
	base := startServe(t, dir, "127.0.0.1")
	var cfg struct {
		DefaultOrchestrator string `json:"default_orchestrator"`
	}
	_, raw := request(t, "GET", base+"/v1/config", nil)
	if err := json.Unmarshal(raw, &cfg); err != nil || cfg.DefaultOrchestrator != config.BuiltinModels().Orchestrator {
		t.Fatalf("config = %s (%v)", raw, err)
	}
}
