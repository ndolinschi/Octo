package remoteaccess

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/bridge"
)

func TestTunnelListenerGate(t *testing.T) {
	r := newRig(t, "", nil)
	r.on()

	h := r.do("GET", "/health", "", nil)
	if h.status != 200 || h.body["ok"] != true {
		t.Fatalf("health %d %s", h.status, h.raw)
	}
	for k, v := range map[string]string{"X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY"} {
		if h.header.Get(k) != v {
			t.Errorf("%s = %q", k, h.header.Get(k))
		}
	}

	// No token, the local desktop token, a token in the query.
	if res := r.do("GET", "/v1/projects", "", nil); res.status != 401 || res.code() != "device_not_paired" {
		t.Fatalf("no token: %d %s", res.status, res.raw)
	}
	if res := r.do("GET", "/v1/projects", "the-local-api-token", nil); res.status != 401 || res.code() != "device_not_paired" {
		t.Fatalf("local token: %d %s", res.status, res.raw)
	}

	tok, id := r.pair(false)
	if res := r.do("GET", "/v1/projects?token="+tok, "", nil); res.status != 401 || res.code() != "query_token_refused" {
		t.Fatalf("query token: %d %s", res.status, res.raw)
	}
	// Pending: nothing but /pair/me.
	if res := r.do("GET", "/v1/projects", tok, nil); res.status != 403 || res.code() != "device_pending" {
		t.Fatalf("pending: %d %s", res.status, res.raw)
	}
	if res := r.do("GET", "/pair/me", tok, nil); res.status != 200 || res.body["status"] != StatusPending {
		t.Fatalf("me pending: %d %s", res.status, res.raw)
	}
	if st := r.m.Status(); st.Pending != 1 || st.Devices[0].Name != "Test phone" {
		t.Fatalf("status %+v", st.Devices)
	}

	if err := r.m.Confirm(id); err != nil {
		t.Fatal(err)
	}
	res := r.do("GET", "/v1/projects", tok, nil)
	if res.status != 200 || res.body["path"] != "/v1/projects" || res.body["auth"] != "" {
		t.Fatalf("active read: %d %s", res.status, res.raw)
	}
	if res.header.Get("Cache-Control") != "no-store" {
		t.Fatalf("cache-control %q", res.header.Get("Cache-Control"))
	}
	for k := range res.header {
		if strings.HasPrefix(k, "Access-Control-") {
			t.Fatalf("CORS header %s on the tunnel listener", k)
		}
	}
	if res := r.do("POST", "/v1/projects/p1/messages", tok, map[string]string{"text": "hi"}); res.status != 200 {
		t.Fatalf("send: %d %s", res.status, res.raw)
	}
	if res := r.do("GET", "/pair/me", tok, nil); res.body["status"] != StatusActive || len(res.body["permissions"].([]any)) != 4 {
		t.Fatalf("me active: %s", res.raw)
	}
	if st := r.m.Status(); st.Online != 1 || !st.Devices[0].Online || st.Devices[0].LastSeen == nil {
		t.Fatalf("online %+v", st)
	}

	// Local-only routes.
	for _, c := range []struct{ m, p string }{
		{"GET", "/v1/settings"}, {"PUT", "/v1/settings"}, {"GET", "/v1/remote"}, {"POST", "/v1/remote/enable"},
		{"GET", "/v1/projects/p1/secrets"}, {"PATCH", "/v1/projects/p1"}, {"POST", "/v1/projects"},
		{"POST", "/v1/fs/pick-folder"}, {"GET", "/v1/diagnostics"}, {"POST", "/mcp/x"}, {"POST", "/v1/projects/p1/unknown"},
	} {
		if res := r.do(c.m, c.p, tok, nil); res.status != 403 || res.code() != "remote_forbidden" {
			t.Errorf("%s %s: %d %s", c.m, c.p, res.status, res.raw)
		}
	}
	// Paths read differently by the router are refused (or redirected to their canonical form, never served).
	noFollow := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	for _, p := range []string{"/v1/projects/p1/../../settings", "/v1/projects/p1%2Fsecrets", "/v1//projects"} {
		req, _ := http.NewRequest("GET", r.base()+p, nil)
		req.URL.RawPath = p
		req.Header.Set("Authorization", "Bearer "+tok)
		res, err := noFollow.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_ = res.Body.Close()
		if res.StatusCode != 400 && res.StatusCode != 403 && res.StatusCode != 404 && res.StatusCode != 301 && res.StatusCode != 307 {
			t.Errorf("%s: %d", p, res.StatusCode)
		}
	}

	// Read-only.
	if err := r.m.SetReadOnly(id, true); err != nil {
		t.Fatal(err)
	}
	if res := r.do("POST", "/v1/projects/p1/approvals/a1", tok, map[string]string{"decision": "allow"}); res.status != 403 || res.code() != "remote_read_only" {
		t.Fatalf("read-only answer: %d %s", res.status, res.raw)
	}
	if res := r.do("GET", "/v1/projects/p1/agents", tok, nil); res.status != 200 {
		t.Fatalf("read-only read: %d", res.status)
	}
	_ = r.m.SetReadOnly(id, false)

	// A preflight gets nothing.
	if res := r.do("OPTIONS", "/v1/projects", "", nil); res.status != 405 || res.header.Get("Access-Control-Allow-Origin") != "" {
		t.Fatalf("preflight: %d %v", res.status, res.header)
	}

	// Revoke.
	if err := r.m.Revoke(id); err != nil {
		t.Fatal(err)
	}
	if res := r.do("GET", "/v1/projects", tok, nil); res.status != 401 || res.code() != "device_not_paired" {
		t.Fatalf("revoked: %d %s", res.status, res.raw)
	}
}

// A paired phone answers an approval once: "allow" or "deny". Saving a rule (allow_always), allowing for the rest of
// the request (allow_for_turn, allow_all_for_turn) or anything unreadable is refused at the gate, before the bridge
// (security review finding 5).
func TestRemoteApprovalAnswersAreOnceOnly(t *testing.T) {
	r := newRig(t, "", nil)
	r.on()
	tok, _ := r.pair(true)
	for _, d := range []string{"allow", "deny"} {
		res := r.do("POST", "/v1/projects/p1/approvals/a1", tok, map[string]string{"decision": d, "note": "ok"})
		if res.status != 200 || res.body["path"] != "/v1/projects/p1/approvals/a1" {
			t.Errorf("%s: %d %s", d, res.status, res.raw)
		}
	}
	for _, body := range []any{
		map[string]string{"decision": "allow_always", "match": "curl"},
		map[string]string{"decision": "allow_always"},
		map[string]string{"decision": "allow_for_turn"},
		map[string]string{"decision": "allow_all_for_turn"},
		map[string]string{"decision": "allow", "match": "*"},
		map[string]any{"decision": []string{"allow"}},
		"not json",
		nil,
	} {
		if res := r.do("POST", "/v1/projects/p1/approvals/a1", tok, body); res.status != 403 || res.code() != "remote_decision_forbidden" || res.body["error"].(map[string]any)["hint"] == nil {
			t.Errorf("%v: %d %s", body, res.status, res.raw)
		}
	}
}

func TestPermissionSettingAppliesToEveryDevice(t *testing.T) {
	r := newRig(t, "", func(o *Options) { o.Allow = Perms{ClassSend: true} })
	r.on()
	tok, _ := r.pair(true)
	if res := r.do("POST", "/v1/projects/p1/approvals/a1", tok, nil); res.status != 403 || res.code() != "remote_forbidden" {
		t.Fatalf("answer without the permission: %d %s", res.status, res.raw)
	}
	if res := r.do("POST", "/v1/projects/p1/cancel", tok, nil); res.status != 403 {
		t.Fatalf("stop without the permission: %d", res.status)
	}
	if res := r.do("POST", "/v1/projects/p1/messages", tok, nil); res.status != 200 {
		t.Fatalf("send: %d", res.status)
	}
}

func TestPairingThroughTheListener(t *testing.T) {
	r := newRig(t, "", nil)
	r.on()
	st, _ := r.m.IssueCode()
	claim := func(from string, body any) resp {
		t.Helper()
		b, _ := json.Marshal(body)
		req, _ := http.NewRequest("POST", r.base()+"/pair/claim", bytes.NewReader(b))
		req.Header.Set("Cf-Connecting-Ip", from)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		raw, _ := io.ReadAll(res.Body)
		out := resp{status: res.StatusCode, header: res.Header, raw: string(raw)}
		_ = json.Unmarshal(raw, &out.body)
		return out
	}
	for i := 1; i < MaxWrongTry; i++ {
		if res := claim("203.0.113.9", map[string]string{"code": "ZZZZ-ZZZZ"}); res.status != 403 || res.code() != "pairing_code_invalid" {
			t.Fatalf("wrong %d: %d %s", i, res.status, res.raw)
		}
	}
	res := claim("203.0.113.9", map[string]string{"code": "ZZZZ-ZZZZ"})
	if res.status != 429 || res.code() != "pairing_backoff" || res.header.Get("Retry-After") != "30" {
		t.Fatalf("backoff: %d %s %v", res.status, res.raw, res.header)
	}
	if res := claim("203.0.113.9", map[string]string{"code": st.Pairing.Code}); res.status != 429 {
		t.Fatalf("right code while waiting: %d", res.status)
	}
	// The phone, from another address, still pairs with the same code.
	if res := claim("198.51.100.7", map[string]string{"code": st.Pairing.Code, "name": "Phone"}); res.status != 201 {
		t.Fatalf("right code from another source: %d %s", res.status, res.raw)
	}
	if res := r.do("POST", "/pair/claim", "", "not an object"); res.status != 400 {
		t.Fatalf("bad body: %d", res.status)
	}
}

func TestClaimRateLimit(t *testing.T) {
	r := newRig(t, "", func(o *Options) { o.ClaimSpacing = time.Hour })
	r.on()
	_, _ = r.m.IssueCode()
	_ = r.do("POST", "/pair/claim", "", map[string]string{"code": "x"})
	res := r.do("POST", "/pair/claim", "", map[string]string{"code": "x"})
	if res.status != 429 || res.code() != "pairing_rate_limited" || res.header.Get("Retry-After") != "1" {
		t.Fatalf("%d %s", res.status, res.raw)
	}
}

func TestStaticWebApp(t *testing.T) {
	web := t.TempDir()
	must := func(err error) {
		if err != nil {
			t.Fatal(err)
		}
	}
	must(os.WriteFile(filepath.Join(web, "index.html"), []byte("<!doctype html><title>Octo</title>"), 0o644))
	must(os.MkdirAll(filepath.Join(web, "assets"), 0o755))
	must(os.WriteFile(filepath.Join(web, "assets", "app-abc.js"), []byte("console.log(1)"), 0o644))
	must(os.WriteFile(filepath.Join(web, "manifest.webmanifest"), []byte("{}"), 0o644))
	must(os.WriteFile(filepath.Join(web, ".secret"), []byte("x"), 0o644))
	r := newRig(t, "", func(o *Options) { o.WebDir = web })
	r.on()
	for _, p := range []string{"/", "/settings/general"} {
		res := r.do("GET", p, "", nil)
		if res.status != 200 || !strings.Contains(res.raw, "<title>Octo</title>") {
			t.Fatalf("%s: %d %q", p, res.status, res.raw)
		}
		if csp := res.header.Get("Content-Security-Policy"); !strings.Contains(csp, "script-src 'self'") || !strings.Contains(csp, "frame-ancestors 'none'") {
			t.Fatalf("csp %q", csp)
		}
	}
	if res := r.do("GET", "/assets/app-abc.js", "", nil); res.status != 200 || !strings.Contains(res.header.Get("Cache-Control"), "immutable") {
		t.Fatalf("asset %d %v", res.status, res.header)
	}
	if res := r.do("GET", "/manifest.webmanifest", "", nil); res.header.Get("Content-Type") != "application/manifest+json" {
		t.Fatalf("manifest type %q", res.header.Get("Content-Type"))
	}
	for _, p := range []string{"/missing.js", "/.secret"} {
		if res := r.do("GET", p, "", nil); res.status != 404 && !strings.Contains(res.raw, "<title>Octo</title>") {
			t.Fatalf("%s: %d", p, res.status)
		}
	}
	if res := r.do("POST", "/", "", nil); res.status != 405 {
		t.Fatalf("POST /: %d", res.status)
	}
}

func TestNoWebAppPage(t *testing.T) {
	r := newRig(t, "", nil)
	r.on()
	res := r.do("GET", "/", "", nil)
	if res.status != 503 || !strings.Contains(res.raw, "phone app is not installed") {
		t.Fatalf("%d %s", res.status, res.raw)
	}
}

// The control routes live on the main bridge, behind its local token.
func TestControlRoutesNeedTheLocalToken(t *testing.T) {
	r := newRig(t, "", nil)
	ctl := r.m.ControlHandler()
	srv := httptest.NewServer(bridge.New(nil, nil, nil, bridge.WithAPIToken("local-token"),
		bridge.WithMount("/v1/remote", ctl), bridge.WithMount("/v1/remote/", ctl)))
	defer srv.Close()
	get := func(method, path, token, body string) (int, string) {
		req, _ := http.NewRequest(method, srv.URL+path, strings.NewReader(body))
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		b := make([]byte, 4096)
		n, _ := res.Body.Read(b)
		return res.StatusCode, string(b[:n])
	}
	if code, _ := get("GET", "/v1/remote", "", ""); code != 401 {
		t.Fatalf("no token: %d", code)
	}
	if code, body := get("GET", "/v1/remote", "local-token", ""); code != 200 || !strings.Contains(body, `"state":"off"`) {
		t.Fatalf("local token: %d %s", code, body)
	}
	if code, body := get("POST", "/v1/remote/enable", "local-token", ""); code != 409 || !strings.Contains(body, "remote_ack_required") {
		t.Fatalf("enable without ack: %d %s", code, body)
	}
	if code, body := get("POST", "/v1/remote/enable", "local-token", `{"acknowledge":true}`); code != 200 || !strings.Contains(body, `"state":"starting"`) && !strings.Contains(body, `"state":"on"`) {
		t.Fatalf("enable: %d %s", code, body)
	}
	eventually(t, "on", func() bool { return r.m.Status().State == StateOn })
	if code, body := get("POST", "/v1/remote/pairing", "local-token", ""); code != 200 || !strings.Contains(body, `"pairing":{"code"`) {
		t.Fatalf("pairing: %d %s", code, body)
	}
	if code, _ := get("DELETE", "/v1/remote/devices/dev_nope", "local-token", ""); code != 404 {
		t.Fatalf("unknown device: %d", code)
	}
	if code, _ := get("PATCH", "/v1/remote/devices/dev_nope", "local-token", `{}`); code != 400 {
		t.Fatalf("patch without read_only: %d", code)
	}
	if code, body := get("POST", "/v1/remote/disable", "local-token", ""); code != 200 || !strings.Contains(body, `"state":"off"`) {
		t.Fatalf("disable: %d %s", code, body)
	}
}
