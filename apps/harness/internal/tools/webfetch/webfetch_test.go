package webfetch

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"sync"
	"testing"
	"time"
)

func local(allow bool) Config { return Config{AllowPrivate: allow} }

func TestPrivateAddressesAreRefusedByDefault(t *testing.T) {
	var hits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits++; w.Write([]byte("secret")) }))
	defer srv.Close()
	for _, u := range []string{srv.URL, strings.Replace(srv.URL, "127.0.0.1", "localhost", 1), strings.Replace(srv.URL, "127.0.0.1", "[::1]", 1),
		"http://169.254.169.254/latest/meta-data/", "http://10.0.0.5/", "http://192.168.1.1/", "http://[::ffff:127.0.0.1]/", "http://0.0.0.0/"} {
		_, err := Fetch(context.Background(), Config{Timeout: 3 * time.Second}, u)
		if err == nil || !strings.Contains(err.Error(), "private") {
			t.Errorf("%s: err = %v, want a private-address refusal", u, err)
		}
	}
	if hits != 0 {
		t.Fatalf("the server was reached %d times", hits)
	}
	// The project setting lifts the refusal.
	out, err := Fetch(context.Background(), local(true), srv.URL)
	if err != nil || !strings.Contains(out, "secret") || hits != 1 {
		t.Fatalf("allowed fetch: %q %v hits %d", out, err, hits)
	}
}

func TestPrivateTable(t *testing.T) {
	for ip, want := range map[string]bool{
		"127.0.0.1": true, "10.1.2.3": true, "172.16.0.1": true, "172.32.0.1": false, "192.168.0.1": true, "169.254.169.254": true,
		"100.64.0.1": true, "0.0.0.0": true, "224.0.0.1": true, "8.8.8.8": false, "93.184.216.34": false,
		"::1": true, "fe80::1": true, "fc00::1": true, "::": true, "2606:4700:4700::1111": false,
		"::ffff:10.0.0.1": true, "::ffff:8.8.8.8": false, "64:ff9b::7f00:1": true, "64:ff9b::808:808": false, "2002:7f00:1::": true,
	} {
		if got := Private(netip.MustParseAddr(ip)); got != want {
			t.Errorf("Private(%s) = %v, want %v", ip, got, want)
		}
	}
}

func TestRefusedURLs(t *testing.T) {
	for _, u := range []string{"", "ftp://example.com/x", "file:///etc/passwd", "javascript:alert(1)", "http://", "http://user:pw@example.com/", "example.com/x", "gopher://x"} {
		if _, err := Fetch(context.Background(), local(true), u); err == nil {
			t.Errorf("%q must be refused", u)
		}
	}
	// A URL holding a stored secret never leaves.
	cfg := Config{AllowPrivate: true, Redact: func(s string) string { return strings.ReplaceAll(s, "sk-123", "[secret]") }}
	if _, err := Fetch(context.Background(), cfg, "http://127.0.0.1:1/?k=sk-123"); err == nil || !strings.Contains(err.Error(), "secret") {
		t.Errorf("secret in url: %v", err)
	}
}

func TestSendsNoCookiesNoCredentialsNoProjectData(t *testing.T) {
	var mu sync.Mutex
	var seen []http.Header
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		seen = append(seen, r.Header.Clone())
		mu.Unlock()
		if r.URL.Path == "/start" {
			http.SetCookie(w, &http.Cookie{Name: "sid", Value: "abc"})
			http.Redirect(w, r, "/end", http.StatusFound)
			return
		}
		w.Header().Set("Content-Type", "text/plain")
		w.Write([]byte("end"))
	}))
	defer srv.Close()
	t.Setenv("HTTP_PROXY", "http://127.0.0.1:9") // a proxy from the environment must not be used
	t.Setenv("HTTPS_PROXY", "http://127.0.0.1:9")
	out, err := Fetch(context.Background(), local(true), srv.URL+"/start")
	if err != nil || !strings.Contains(out, "end") {
		t.Fatalf("%q %v", out, err)
	}
	if len(seen) != 2 {
		t.Fatalf("requests = %d", len(seen))
	}
	for i, h := range seen {
		for _, bad := range []string{"Cookie", "Authorization", "Referer", "Proxy-Authorization"} {
			if h.Get(bad) != "" {
				t.Errorf("request %d carries %s", i, bad)
			}
		}
		if !strings.HasPrefix(h.Get("User-Agent"), "octo-harness") {
			t.Errorf("request %d user agent %q", i, h.Get("User-Agent"))
		}
	}
}

func TestContentHandling(t *testing.T) {
	big := strings.Repeat("0123456789", 60_000) // 600 kB
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/html":
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Write([]byte(`<html><head><title>Hello &amp; welcome</title><style>p{color:red}</style><script>var secret=1;</script></head>
<body><!-- hidden --><h1>Heading</h1><p>First <b>bold</b> para &lt;ok&gt;</p><ul><li>one</li><li>two</li></ul><script>alert(1)</script></body></html>`))
		case "/json":
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(`{"a":1}`))
		case "/img":
			w.Header().Set("Content-Type", "image/png")
			w.Write([]byte("\x89PNG"))
		case "/pdf":
			w.Header().Set("Content-Type", "application/pdf")
			w.Write([]byte("%PDF"))
		case "/big":
			w.Header().Set("Content-Type", "text/plain")
			w.Write([]byte(big))
		case "/slow":
			time.Sleep(600 * time.Millisecond)
			w.Write([]byte("late"))
		case "/loop":
			http.Redirect(w, r, "/loop", http.StatusFound)
		case "/ftp":
			http.Redirect(w, r, "ftp://example.com/x", http.StatusFound)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	ctx := context.Background()

	out, err := Fetch(ctx, local(true), srv.URL+"/html")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"Title: Hello & welcome", "Heading", "First bold para <ok>", "- one", "- two"} {
		if !strings.Contains(out, want) {
			t.Errorf("html text lacks %q:\n%s", want, out)
		}
	}
	for _, bad := range []string{"secret", "alert", "color:red", "hidden", "<b>"} {
		if strings.Contains(out, bad) {
			t.Errorf("html text still has %q:\n%s", bad, out)
		}
	}
	if out, err := Fetch(ctx, local(true), srv.URL+"/json"); err != nil || !strings.Contains(out, `{"a":1}`) {
		t.Errorf("json: %q %v", out, err)
	}
	for _, p := range []string{"/img", "/pdf"} {
		if _, err := Fetch(ctx, local(true), srv.URL+p); err == nil || !strings.Contains(err.Error(), "text only") {
			t.Errorf("%s: %v", p, err)
		}
	}
	if _, err := Fetch(ctx, local(true), srv.URL+"/missing"); err == nil || !strings.Contains(err.Error(), "404") {
		t.Errorf("404: %v", err)
	}
	out, err = Fetch(ctx, local(true), srv.URL+"/big")
	if err != nil || len(out) > MaxBytes+400 || !strings.Contains(out, "cut at 200 kB") {
		t.Errorf("big: len %d err %v tail %q", len(out), err, out[max(len(out)-60, 0):])
	}
	if _, err := Fetch(ctx, Config{AllowPrivate: true, Timeout: 150 * time.Millisecond}, srv.URL+"/slow"); err == nil || !strings.Contains(err.Error(), "timed out") {
		t.Errorf("slow: %v", err)
	}
	if _, err := Fetch(ctx, local(true), srv.URL+"/loop"); err == nil || !strings.Contains(err.Error(), "redirects") {
		t.Errorf("loop: %v", err)
	}
	if _, err := Fetch(ctx, local(true), srv.URL+"/ftp"); err == nil || !strings.Contains(err.Error(), "refused") {
		t.Errorf("ftp redirect: %v", err)
	}
}

func TestHandlerShape(t *testing.T) {
	h := Handler(Config{})
	out, isErr, err := h(context.Background(), json.RawMessage(`{"url":"http://127.0.0.1:1/"}`))
	if err != nil || !isErr || !strings.Contains(out, "web_fetch:") {
		t.Fatalf("%q %v %v", out, isErr, err)
	}
	if _, isErr, _ := h(context.Background(), json.RawMessage(`{`)); !isErr {
		t.Fatal("bad json must be an error result")
	}
}
