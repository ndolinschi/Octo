package main

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const (
	secretKey   = "sk-ant-api03-DOCTORSECRET0123456789"
	secretOcto  = "octo-key-doctor-secret"
	secretURLPw = "urlpw-doctor-secret"
	secretQuery = "query-doctor-secret"
)

func TestHelperDoctor(t *testing.T) {
	if os.Getenv("HARNESS_TEST_HELPER_DOCTOR") != "1" {
		t.Skip("helper process")
	}
	args := strings.Fields(os.Getenv("HARNESS_TEST_ARGS"))
	if err := cmdDoctor(args); err != nil {
		t.Fatal(err)
	}
}

func fakePlugins(t *testing.T) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "plugins", "fake")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	manifest := `{"name":"fake","version":"1","agents":[
	 {"id":"gone","label":"Gone","command":"definitely-not-installed-xyz","install":"install the gone CLI","auth":{"hint":"log in to gone"}},
	 {"id":"out","label":"Logged out","command":"sh","auth":{"probe":["sh","-c","exit 1"],"hint":"run: out login"}},
	 {"id":"in","label":"Logged in","command":"sh","auth":{"probe":["sh","-c","exit 0"],"hint":"x"}},
	 {"id":"req","label":"Needs a CLI","command":"sh","requires":["definitely-not-a-command-xyz"],"install":"install the xyz CLI"}]}`
	if err := os.WriteFile(filepath.Join(dir, "plugin.json"), []byte(manifest), 0o644); err != nil {
		t.Fatal(err)
	}
	return filepath.Dir(dir)
}

func TestHarnessDoctorReportsAgentsAndLeaksNothing(t *testing.T) {
	plugins := fakePlugins(t)
	run := func(extra string) string {
		cmd := exec.Command(os.Args[0], "-test.run=^TestHelperDoctor$")
		cmd.Env = []string{
			"HARNESS_TEST_HELPER_DOCTOR=1", "HARNESS_NO_BUILTIN_PLUGINS=1", "PATH=/bin:/usr/bin",
			"HARNESS_TEST_ARGS=--data-dir " + t.TempDir() + " --plugins-dir " + plugins + " " + extra,
			"ANTHROPIC_API_KEY=" + secretKey, "HARNESS_OCTO_KEY=" + secretOcto,
			"ANTHROPIC_BASE_URL=http://u:" + secretURLPw + "@127.0.0.1:1/autoroute?key=" + secretQuery,
			"GITHUB_TOKEN=ghp_doctorsecrettoken123456",
		}
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("doctor: %v\n%s", err, out)
		}
		return string(out)
	}
	text := run("")
	for _, want := range []string{"gone", "not installed", "install the gone CLI", "log in to gone", "out", "not logged in", "run: out login",
		"requires definitely-not-a-command-xyz: not found", "PATH for child processes: /bin:/usr/bin", "ANTHROPIC_API_KEY", "built-in loop"} {
		if !strings.Contains(text, want) {
			t.Errorf("doctor output lacks %q:\n%s", want, text)
		}
	}
	for _, s := range []string{secretKey, secretOcto, secretURLPw, secretQuery, "ghp_doctorsecrettoken123456"} {
		if strings.Contains(text, s) {
			t.Errorf("doctor output contains the secret %q", s)
		}
	}
	js := run("--json")
	var rep struct {
		Agents []struct {
			ID    string `json:"id"`
			Probe struct {
				LoggedIn *bool `json:"logged_in"`
			} `json:"probe"`
		} `json:"agents"`
	}
	if err := json.NewDecoder(strings.NewReader(js[strings.Index(js, "{"):])).Decode(&rep); err != nil {
		t.Fatalf("json: %v\n%s", err, js)
	}
	got := map[string]*bool{}
	for _, a := range rep.Agents {
		got[a.ID] = a.Probe.LoggedIn
	}
	if got["out"] == nil || *got["out"] || got["in"] == nil || !*got["in"] || got["gone"] != nil {
		t.Fatalf("probes = %v", got)
	}
	for _, s := range []string{secretKey, secretOcto, secretURLPw, secretQuery} {
		if strings.Contains(js, s) {
			t.Errorf("doctor json contains the secret %q", s)
		}
	}
}

func TestDiagnosticsEndpointAndTraceSetting(t *testing.T) {
	emptyEnv(t)
	t.Setenv("ANTHROPIC_API_KEY", secretKey)
	t.Setenv("HARNESS_NO_BUILTIN_PLUGINS", "1")
	data := t.TempDir()
	cfg, _, err := serveConfig([]string{"--data-dir", data, "--plugins-dir", fakePlugins(t)})
	if err != nil {
		t.Fatal(err)
	}
	cfg.BaseURL = "http://u:" + secretURLPw + "@127.0.0.1:1/x?key=" + secretQuery
	addr := freeAddr(t)
	done := make(chan error, 1)
	ctx, cancel := contextWithCancel(t)
	go func() { done <- serve(ctx, cfg, addr) }()
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(15 * time.Second):
			t.Error("serve did not stop")
		}
	})
	base := "http://" + addr
	var body string
	deadline := time.Now().Add(10 * time.Second)
	for {
		resp, err := http.Get(base + "/v1/diagnostics")
		if err == nil {
			b := new(strings.Builder)
			buf := make([]byte, 4096)
			for {
				n, rerr := resp.Body.Read(buf)
				b.Write(buf[:n])
				if rerr != nil {
					break
				}
			}
			resp.Body.Close()
			body = b.String()
			break
		}
		if time.Now().After(deadline) {
			t.Fatal(err)
		}
		time.Sleep(20 * time.Millisecond)
	}
	for _, s := range []string{secretKey, secretURLPw, secretQuery} {
		if strings.Contains(body, s) {
			t.Errorf("GET /v1/diagnostics contains %q", s)
		}
	}
	var rep struct {
		Agents   []struct{ ID string } `json:"agents"`
		LogTail  []string              `json:"log_tail"`
		ACPTrace struct {
			Enabled bool `json:"enabled"`
		} `json:"acp_trace"`
		Router struct {
			BaseURL string `json:"base_url"`
		} `json:"router"`
	}
	if err := json.Unmarshal([]byte(body), &rep); err != nil {
		t.Fatal(err)
	}
	if len(rep.Agents) != 4 || len(rep.LogTail) == 0 || rep.ACPTrace.Enabled || rep.Router.BaseURL != "http://127.0.0.1:1/x" {
		t.Fatalf("report = %+v", rep)
	}
	// The trace switch is a setting and takes effect at once.
	put := func(v string) {
		req, _ := http.NewRequest("PUT", base+"/v1/settings", strings.NewReader(`{"set":{"HARNESS_ACP_TRACE":`+v+`}}`))
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != 200 {
			t.Fatalf("PUT settings = %d", resp.StatusCode)
		}
	}
	enabled := func() bool {
		resp, err := http.Get(base + "/v1/diagnostics")
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var r struct {
			ACPTrace struct {
				Enabled bool `json:"enabled"`
			} `json:"acp_trace"`
		}
		_ = json.NewDecoder(resp.Body).Decode(&r)
		return r.ACPTrace.Enabled
	}
	put("true")
	if !enabled() {
		t.Fatal("the setting did not switch the trace on")
	}
	put("false")
	if enabled() {
		t.Fatal("the setting did not switch the trace off")
	}
}

func contextWithCancel(t *testing.T) (context.Context, context.CancelFunc) {
	t.Helper()
	return context.WithCancel(context.Background())
}
