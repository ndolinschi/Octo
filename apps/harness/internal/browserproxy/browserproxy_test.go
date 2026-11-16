package browserproxy_test

import (
	"bufio"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/browserproxy"
)

func TestOpenBootstrapCookieAndHTMLInjection(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if c, err := r.Cookie("__octo_bp"); err == nil && c.Value != "" {
			t.Errorf("capability cookie leaked to upstream: %v", c.Value)
		}
		switch r.URL.Path {
		case "/app":
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Header().Set("X-Frame-Options", "DENY")
			w.Header().Set("Content-Security-Policy", "default-src 'none'; script-src 'https://cdn.example'; frame-ancestors 'none'")
			_, _ = io.WriteString(w, "<!doctype html><html><head><title>Demo</title></head><body><h1>Hello</h1></body></html>")
		case "/redir":
			http.Redirect(w, r, "http://"+r.Host+"/app?ok=1", http.StatusFound)
		default:
			http.NotFound(w, r)
		}
	}))
	defer upstream.Close()

	mgr := browserproxy.NewManager(browserproxy.Options{})
	defer func() {
		if err := mgr.Shutdown(context.Background()); err != nil {
			t.Fatalf("shutdown: %v", err)
		}
	}()

	sess, err := mgr.Open(context.Background(), "proj-1", upstream.URL+"/app?tab=1")
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if sess.Nonce == "" || sess.ProxyOrigin == "" {
		t.Fatalf("unexpected session: %+v", sess)
	}

	// Direct access without cookie is rejected with 403.
	respNoCookie, err := http.Get(sess.ProxyOrigin + "/app")
	if err != nil {
		t.Fatalf("GET without cookie: %v", err)
	}
	respNoCookie.Body.Close()
	if respNoCookie.StatusCode != http.StatusForbidden {
		t.Fatalf("expected 403 without cookie, got %d", respNoCookie.StatusCode)
	}

	// Follow one-time bootstrap ticket with a cookie jar.
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatalf("cookiejar: %v", err)
	}
	client := &http.Client{Jar: jar}
	resp, err := client.Get(sess.FrameURL)
	if err != nil {
		t.Fatalf("bootstrap GET: %v", err)
	}
	bodyBytes, err := io.ReadAll(resp.Body)
	resp.Body.Close()
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 after bootstrap redirect, got %d (%s)", resp.StatusCode, string(bodyBytes))
	}
	if got := resp.Header.Get("X-Frame-Options"); got != "" {
		t.Errorf("X-Frame-Options not stripped: %q", got)
	}
	csp := resp.Header.Get("Content-Security-Policy")
	if strings.Contains(csp, "frame-ancestors") {
		t.Errorf("CSP still contains frame-ancestors: %q", csp)
	}
	if !strings.Contains(csp, "'self'") {
		t.Errorf("CSP script-src was not widened with 'self': %q", csp)
	}
	if !strings.Contains(csp, "'unsafe-inline'") {
		t.Errorf("CSP style-src was not widened with 'unsafe-inline' for inspector overlay: %q", csp)
	}
	if !strings.Contains(csp, "data:") {
		t.Errorf("CSP img-src was not widened with data: for SVG foreignObject crops: %q", csp)
	}
	body := string(bodyBytes)
	if !strings.Contains(body, `/__octo_browser/inspector.js`) || !strings.Contains(body, sess.Nonce) {
		t.Errorf("inspector script tag missing from HTML: %s", body)
	}

	// Reusing the one-time bootstrap ticket fails.
	noFollow := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	replay, err := noFollow.Get(sess.FrameURL)
	if err != nil {
		t.Fatalf("replay GET: %v", err)
	}
	replay.Body.Close()
	if replay.StatusCode != http.StatusForbidden {
		t.Errorf("expected 403 on ticket replay, got %d", replay.StatusCode)
	}

	// Inspector JS endpoint serves the script when authenticated.
	jsResp, err := client.Get(sess.ProxyOrigin + "/__octo_browser/inspector.js")
	if err != nil {
		t.Fatalf("inspector.js GET: %v", err)
	}
	jsBytes, _ := io.ReadAll(jsResp.Body)
	jsResp.Body.Close()
	if jsResp.StatusCode != http.StatusOK || !strings.Contains(string(jsBytes), "octo-browser") {
		t.Errorf("unexpected inspector.js response: status=%d len=%d", jsResp.StatusCode, len(jsBytes))
	}

	// Upstream redirects stay on the proxy origin.
	redirResp, err := client.Get(sess.ProxyOrigin + "/redir")
	if err != nil {
		t.Fatalf("redir GET: %v", err)
	}
	redirResp.Body.Close()
	if redirResp.Request.URL.Host != strings.TrimPrefix(sess.ProxyOrigin, "http://") {
		t.Errorf("redirect escaped proxy origin: %s", redirResp.Request.URL.String())
	}
}

func TestWebSocketUpgradePassThrough(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		hj, ok := w.(http.Hijacker)
		if !ok {
			t.Error("ResponseWriter not hijackable")
			return
		}
		conn, rw, err := hj.Hijack()
		if err != nil {
			return
		}
		defer conn.Close()
		_, _ = rw.WriteString("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n")
		_ = rw.Flush()
		line, _ := rw.ReadString('\n')
		_, _ = rw.WriteString("echo:" + line)
		_ = rw.Flush()
	}))
	defer upstream.Close()

	mgr := browserproxy.NewManager(browserproxy.Options{})
	defer func() { _ = mgr.Shutdown(context.Background()) }()

	sess, err := mgr.Open(context.Background(), "proj-ws", upstream.URL+"/")
	if err != nil {
		t.Fatalf("Open: %v", err)
	}

	noFollow := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	bootResp, err := noFollow.Get(sess.FrameURL)
	if err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	cookies := bootResp.Cookies()
	bootResp.Body.Close()
	if len(cookies) == 0 {
		t.Fatal("expected capability cookie")
	}

	u, _ := url.Parse(sess.ProxyOrigin)
	conn, err := net.DialTimeout("tcp", u.Host, 3*time.Second)
	if err != nil {
		t.Fatalf("dial proxy: %v", err)
	}
	defer conn.Close()

	req := "GET /hmr HTTP/1.1\r\n" +
		"Host: " + u.Host + "\r\n" +
		"Connection: Upgrade\r\n" +
		"Upgrade: websocket\r\n" +
		"Cookie: " + cookies[0].Name + "=" + cookies[0].Value + "\r\n\r\n"
	if _, err := conn.Write([]byte(req)); err != nil {
		t.Fatalf("write upgrade: %v", err)
	}
	br := bufio.NewReader(conn)
	statusLine, err := br.ReadString('\n')
	if err != nil || !strings.Contains(statusLine, "101") {
		t.Fatalf("expected 101 status line, got %q (err=%v)", statusLine, err)
	}
	for {
		line, err := br.ReadString('\n')
		if err != nil || line == "\r\n" {
			break
		}
	}
	if _, err := conn.Write([]byte("ping-hmr\n")); err != nil {
		t.Fatalf("write ws frame: %v", err)
	}
	reply, err := br.ReadString('\n')
	if err != nil || reply != "echo:ping-hmr\n" {
		t.Fatalf("expected echo:ping-hmr, got %q (err=%v)", reply, err)
	}
}

func TestSSRFAndBlockedPortRejection(t *testing.T) {
	mgr := browserproxy.NewManager(browserproxy.Options{BlockedLoopbackPorts: []int{8790}})
	defer func() { _ = mgr.Shutdown(context.Background()) }()

	cases := []struct {
		url  string
		kind browserproxy.ErrorKind
	}{
		{"", browserproxy.KindInvalid},
		{"javascript:alert(1)", browserproxy.KindInvalid},
		{"file:///etc/passwd", browserproxy.KindInvalid},
		{"http://127.0.0.1:8790/v1/config", browserproxy.KindForbidden},
		{"http://localhost:8790/health", browserproxy.KindForbidden},
		{"http://169.254.169.254/latest/meta-data/", browserproxy.KindForbidden},
		{"http://0.0.0.0:3000/", browserproxy.KindForbidden},
	}
	for _, tc := range cases {
		_, err := mgr.Open(context.Background(), "proj-1", tc.url)
		if err == nil {
			t.Errorf("expected error for %q, got nil", tc.url)
			continue
		}
		var be *browserproxy.Error
		if !errors.As(err, &be) || be.Kind != tc.kind {
			t.Errorf("for %q: got %v, want ErrorKind=%v", tc.url, err, tc.kind)
		}
	}

	// Dynamic AddBlockedPort also blocks a port added after construction.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	ln.Close()
	mgr.AddBlockedPort(port)
	if _, err := mgr.Open(context.Background(), "proj-1", "http://127.0.0.1:"+strconv.Itoa(port)); err == nil {
		t.Errorf("expected dynamically blocked port %d to fail", port)
	}
}
