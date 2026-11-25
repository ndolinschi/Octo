package main

import (
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/apitoken"
)

func statusOf(t *testing.T, method, url, token string) (int, string) {
	t.Helper()
	req, _ := http.NewRequest(method, url, nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	buf := make([]byte, 1<<16)
	n, _ := resp.Body.Read(buf)
	return resp.StatusCode, string(buf[:n])
}

// Without HARNESS_API_TOKEN, serve generates a token, writes it to the data
// directory (0600) and enforces it on /v1; /health stays open.
func TestServeGeneratesATokenFileAndEnforcesIt(t *testing.T) {
	emptyEnv(t)
	t.Setenv("HARNESS_NO_BUILTIN_PLUGINS", "1")
	dir := t.TempDir()
	cfg, _, err := serveConfig([]string{"--data-dir", dir})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.APIToken != "" || cfg.NoAPIToken {
		t.Fatalf("defaults: %q %v", cfg.APIToken, cfg.NoAPIToken)
	}
	base := startServeWith(t, cfg, "127.0.0.1")

	raw, err := os.ReadFile(filepath.Join(dir, "api-token"))
	if err != nil {
		t.Fatalf("no token file: %v", err)
	}
	tok := strings.TrimSpace(string(raw))
	if len(tok) < 32 {
		t.Fatalf("token %q is too short", tok)
	}
	if runtime.GOOS != "windows" {
		if fi, _ := os.Stat(filepath.Join(dir, "api-token")); fi.Mode().Perm() != 0o600 {
			t.Fatalf("token file mode %v", fi.Mode().Perm())
		}
	}
	if st, _ := statusOf(t, "GET", base+"/health", ""); st != 200 {
		t.Fatalf("/health without a token = %d", st)
	}
	if st, body := statusOf(t, "GET", base+"/v1/config", ""); st != 401 || !strings.Contains(body, "unauthorized") {
		t.Fatalf("/v1/config without a token = %d %s", st, body)
	}
	if st, _ := statusOf(t, "GET", base+"/v1/config", "wrong-token-0123456789abcdef"); st != 401 {
		t.Fatalf("/v1/config with a wrong token = %d", st)
	}
	if st, _ := statusOf(t, "GET", base+"/v1/config", tok); st != 200 {
		t.Fatalf("/v1/config with the token = %d", st)
	}
	// Nothing the harness shows about itself carries the token.
	_, diag := statusOf(t, "GET", base+"/v1/diagnostics", tok)
	_, cfgBody := statusOf(t, "GET", base+"/v1/config", tok)
	_, settings := statusOf(t, "GET", base+"/v1/settings", tok)
	for name, body := range map[string]string{"diagnostics": diag, "config": cfgBody, "settings": settings} {
		if strings.Contains(body, tok) {
			t.Errorf("/v1/%s contains the token", name)
		}
	}
	for _, line := range logRing.Lines(500) {
		if strings.Contains(line, tok) {
			t.Errorf("the log contains the token: %s", line)
		}
	}
}

func TestServeUsesHarnessAPITokenAndWritesNoFile(t *testing.T) {
	emptyEnv(t)
	t.Setenv("HARNESS_NO_BUILTIN_PLUGINS", "1")
	const tok = "env-supplied-token-0123456789"
	t.Setenv("HARNESS_API_TOKEN", tok)
	dir := t.TempDir()
	cfg, _, err := serveConfig([]string{"--data-dir", dir})
	if err != nil || cfg.APIToken != tok {
		t.Fatalf("config token = %q %v", cfg.APIToken, err)
	}
	base := startServeWith(t, cfg, "127.0.0.1")
	if st, _ := statusOf(t, "GET", base+"/v1/config", tok); st != 200 {
		t.Fatalf("with the env token = %d", st)
	}
	if st, _ := statusOf(t, "GET", base+"/v1/config", ""); st != 401 {
		t.Fatalf("without = %d", st)
	}
	if _, err := os.Stat(apitoken.Path(dir)); !os.IsNotExist(err) {
		t.Fatalf("a token from the environment must not be written to disk (%v)", err)
	}
}

func TestServeNoAPITokenFlagAndEnvTurnTheCheckOff(t *testing.T) {
	emptyEnv(t)
	t.Setenv("HARNESS_NO_BUILTIN_PLUGINS", "1")
	for name, setup := range map[string]func(t *testing.T) []string{
		"flag": func(t *testing.T) []string { return []string{"--no-api-token"} },
		"env": func(t *testing.T) []string {
			t.Setenv("HARNESS_NO_API_TOKEN", "1")
			return nil
		},
	} {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			cfg, _, err := serveConfig(append([]string{"--data-dir", dir}, setup(t)...))
			if err != nil || !cfg.NoAPIToken {
				t.Fatalf("NoAPIToken = %v %v", cfg.NoAPIToken, err)
			}
			base := startServeWith(t, cfg, "127.0.0.1")
			if st, _ := statusOf(t, "GET", base+"/v1/config", ""); st != 200 {
				t.Fatalf("/v1/config with the check off = %d", st)
			}
			if _, err := os.Stat(apitoken.Path(dir)); !os.IsNotExist(err) {
				t.Fatalf("no token file expected with the check off (%v)", err)
			}
		})
	}
}

func TestServeRefusesAWeakConfiguredToken(t *testing.T) {
	emptyEnv(t)
	t.Setenv("HARNESS_NO_BUILTIN_PLUGINS", "1")
	t.Setenv("HARNESS_API_TOKEN", "short")
	cfg, _, err := serveConfig([]string{"--data-dir", t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := setupAPIToken(cfg); err == nil || !strings.Contains(err.Error(), "at least") {
		t.Fatalf("setupAPIToken = %v, want a refusal", err)
	}
}
