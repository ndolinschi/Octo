package main

import (
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// brokenPlugins writes a manifest that does not parse, one with an agent without id or command, and returns the dir.
func brokenPlugins(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	for name, body := range map[string]string{
		"badjson": `{not json`,
		"broken":  `{"name":"broken","version":"1","agents":[{"id":"","command":""}]}`,
	} {
		if err := os.MkdirAll(filepath.Join(root, name), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, name, "plugin.json"), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func runDoctor(t *testing.T, baseURL, extra string, plugins string) string {
	t.Helper()
	cmd := exec.Command(os.Args[0], "-test.run=^TestHelperDoctor$")
	cmd.Env = []string{
		"HARNESS_TEST_HELPER_DOCTOR=1", "HARNESS_NO_BUILTIN_PLUGINS=1", "PATH=/bin:/usr/bin",
		"HARNESS_TEST_ARGS=--data-dir " + t.TempDir() + " --plugins-dir " + plugins + " --base-url " + baseURL + " " + extra,
		"ANTHROPIC_API_KEY=" + secretKey,
	}
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("doctor: %v\n%s", err, out)
	}
	return string(out)
}

// Every plugin error (an unparsable manifest with its path, an agent without id or command) is a problem of the
// report, and the model API is probed: a port nothing listens on is unreachable, a 401 is unauthorized, a 200 reachable.
func TestDoctorReportsPluginProblemsAndModelReachability(t *testing.T) {
	plugins := brokenPlugins(t)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	dead := "http://" + ln.Addr().String()
	_ = ln.Close()

	text := runDoctor(t, dead, "", plugins)
	for _, want := range []string{
		"plugin badjson (" + filepath.Join(plugins, "badjson", "plugin.json") + "): invalid JSON",
		"plugin broken (" + filepath.Join(plugins, "broken", "plugin.json") + "):",
		"model API: unreachable", "the built-in agent loop's model API is unreachable",
	} {
		if !strings.Contains(text, want) {
			t.Errorf("doctor output lacks %q:\n%s", want, text)
		}
	}
	if strings.Contains(text, secretKey) {
		t.Error("the key leaked")
	}

	refuse := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" {
			http.NotFound(w, r) // the router detection asks /health
			return
		}
		if r.Header.Get("x-api-key") != secretKey {
			t.Errorf("probe sent %s with key set=%v", r.URL.Path, r.Header.Get("x-api-key") != "")
		}
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer refuse.Close()
	js := runDoctor(t, refuse.URL, "--json", plugins)
	var rep struct {
		ModelAPI       struct{ State string }                     `json:"model_api"`
		PluginProblems []struct{ Plugin, Manifest, Error string } `json:"plugin_problems"`
	}
	if err := json.NewDecoder(strings.NewReader(js[strings.Index(js, "{"):])).Decode(&rep); err != nil {
		t.Fatalf("json: %v\n%s", err, js)
	}
	if rep.ModelAPI.State != "unauthorized" || len(rep.PluginProblems) < 2 {
		t.Fatalf("report = %+v", rep)
	}

	ok := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(`{"data":[]}`)) }))
	defer ok.Close()
	if text := runDoctor(t, ok.URL, "", plugins); !strings.Contains(text, "model API: reachable") {
		t.Fatalf("reachable:\n%s", text)
	}
}
