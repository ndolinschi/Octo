package bridge_test

import (
	"io"
	"net/http"
	"strings"
	"testing"
)

// getAs is a GET of path as a client with the given Host and Origin ("" keeps
// the test server's own): a paired device arrives through the tunnel with the
// tunnel's host name.
func (e *env) getAs(t *testing.T, path, host, origin string) string {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, e.url+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	if host != "" {
		req.Host = host
	}
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET %s = %d %s", path, resp.StatusCode, b)
	}
	return string(b)
}

// A paired device reads GET /v1/providers and GET /v1/plugins but gets no
// account folder, no "owned" flag and no login command (it can name the folder).
func TestPairedDeviceGetsNoFoldersOrLoginCommands(t *testing.T) {
	e := newAccountsEnv(t)
	var acc accountReply
	e.into(t, "POST", "/v1/providers/cc/accounts", map[string]any{"name": "Work"}, http.StatusCreated, &acc)
	e.into(t, "POST", "/v1/providers/cc@work/recheck", nil, http.StatusOK, nil) // not logged in: the problem carries the login line
	dir := acc.Account.Dir

	for _, path := range []string{"/v1/providers", "/v1/plugins"} {
		for _, local := range []struct{ name, host, origin string }{
			{"test server", "", ""},
			{"localhost", "localhost:8790", ""},
			{"desktop origin", "", "http://localhost:1420"},
		} {
			body := e.getAs(t, path, local.host, local.origin)
			if !strings.Contains(body, dir) || !strings.Contains(body, `"login_command"`) || !strings.Contains(body, `"owned":true`) {
				t.Errorf("%s as %s lost its folder or login command: %s", path, local.name, body)
			}
		}
		for _, paired := range []struct{ name, host, origin string }{
			{"tunnel host", "quiet-fox-1234.trycloudflare.com", ""},
			{"tunnel host and origin", "quiet-fox-1234.trycloudflare.com", "https://quiet-fox-1234.trycloudflare.com"},
			{"foreign origin", "", "https://evil.example"},
		} {
			body := e.getAs(t, path, paired.host, paired.origin)
			for _, leak := range []string{dir, `"login_command"`, `"dir"`, `"owned"`, "CLAUDE_CONFIG_DIR"} {
				if strings.Contains(body, leak) {
					t.Errorf("%s as %s leaks %q: %s", path, paired.name, leak, body)
				}
			}
			if !strings.Contains(body, "cc@work") || !strings.Contains(body, `"Work"`) {
				t.Errorf("%s as %s lost the account itself: %s", path, paired.name, body)
			}
		}
	}
}
