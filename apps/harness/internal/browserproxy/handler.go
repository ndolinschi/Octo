package browserproxy

import (
	"context"
	"crypto/subtle"
	_ "embed"
	"encoding/json"
	"errors"
	"html"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

//go:embed inspector.js
var inspectorJS []byte

const (
	cookieName    = "__octo_bp"
	ticketTTL     = 60 * time.Second
	pendingNavTTL = 15 * time.Second
	prefixPath    = "/__octo_browser/"
	bootstrapURI  = "/__octo_browser/bootstrap"
	inspectorURI  = "/__octo_browser/inspector.js"
)

type ticketEntry struct {
	targetPath string
	expiresAt  time.Time
}

type instance struct {
	target       *url.URL
	targetOrigin string
	proxyOrigin  string
	proxyHost    string
	cookieSecret string
	nonce        string
	ln           net.Listener
	srv          *http.Server
	lastUsed     atomic.Int64
	activated    atomic.Bool

	mu          sync.Mutex
	tickets     map[string]ticketEntry
	pendingNavs map[string]time.Time
}

func newInstance(target *url.URL, transport http.RoundTripper) (*instance, error) {
	secret, err := randomHex(32)
	if err != nil {
		return nil, err
	}
	nonce, err := randomHex(16)
	if err != nil {
		return nil, err
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	proxyHost := ln.Addr().String()
	inst := &instance{
		target:       &url.URL{Scheme: target.Scheme, Host: target.Host},
		targetOrigin: target.Scheme + "://" + target.Host,
		proxyOrigin:  "http://" + proxyHost,
		proxyHost:    proxyHost,
		cookieSecret: secret,
		nonce:        nonce,
		ln:           ln,
		tickets:      make(map[string]ticketEntry),
		pendingNavs:  make(map[string]time.Time),
	}
	inst.lastUsed.Store(time.Now().UnixNano())

	rp := &httputil.ReverseProxy{
		Transport:     transport,
		FlushInterval: -1,
		Rewrite:       inst.rewriteRequest,
		ModifyResponse: func(resp *http.Response) error {
			return inst.modifyResponse(resp)
		},
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, proxyErr error) {
			inst.writeUnreachable(w, proxyErr)
		},
	}

	inst.srv = &http.Server{
		Handler:           inst.handler(rp),
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		if serveErr := inst.srv.Serve(ln); serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
			_ = ln.Close()
		}
	}()
	return inst, nil
}

// writeUnreachable answers a request whose upstream could not be reached: a 502 with the reason as plain text and, in the
// same page, a message to the host (channel "octo-browser", type "error", this instance's nonce) so the Browser tab can show
// its own error state with Retry instead of the bare text.
func (i *instance) writeUnreachable(w http.ResponseWriter, proxyErr error) {
	reason := "Upstream server unreachable: " + proxyErr.Error()
	msg, err := json.Marshal(map[string]string{"channel": "octo-browser", "nonce": i.nonce, "type": "error", "message": reason})
	if err != nil {
		http.Error(w, reason, http.StatusBadGateway)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusBadGateway)
	// `</` and U+2028/9 cannot end the script early or the string: json.Marshal escapes <, > and & as \u00XX.
	_, _ = io.WriteString(w, "<!doctype html><meta charset=\"utf-8\"><title>Unreachable</title><body style=\"font:14px system-ui;padding:16px\">"+
		html.EscapeString(reason)+"<script>parent.postMessage("+string(msg)+",\"*\")</script>")
}

func (i *instance) mintTicket(targetPath string) (string, error) {
	tok, err := randomHex(24)
	if err != nil {
		return "", err
	}
	now := time.Now()
	i.lastUsed.Store(now.UnixNano())
	i.mu.Lock()
	for k, v := range i.tickets {
		if now.After(v.expiresAt) {
			delete(i.tickets, k)
		}
	}
	i.tickets[tok] = ticketEntry{
		targetPath: sanitizeRedirectPath(targetPath),
		expiresAt:  now.Add(ticketTTL),
	}
	i.mu.Unlock()
	return tok, nil
}

func (i *instance) consumeTicket(tok string) (string, bool) {
	if tok == "" {
		return "", false
	}
	now := time.Now()
	i.mu.Lock()
	entry, ok := i.tickets[tok]
	if ok {
		delete(i.tickets, tok)
	}
	if ok && !now.After(entry.expiresAt) {
		for k, exp := range i.pendingNavs {
			if now.After(exp) {
				delete(i.pendingNavs, k)
			}
		}
		i.pendingNavs[navKey(entry.targetPath)] = now.Add(pendingNavTTL)
	}
	i.mu.Unlock()
	if !ok || now.After(entry.expiresAt) {
		return "", false
	}
	i.activated.Store(true)
	return entry.targetPath, true
}

func navKey(rawPath string) string {
	key, _, _ := strings.Cut(rawPath, "#")
	if key == "" {
		return "/"
	}
	return key
}

func (i *instance) hasPendingNav(requestURI string) bool {
	now := time.Now()
	i.mu.Lock()
	defer i.mu.Unlock()
	for k, exp := range i.pendingNavs {
		if now.After(exp) {
			delete(i.pendingNavs, k)
		}
	}
	exp, ok := i.pendingNavs[navKey(requestURI)]
	return ok && !now.After(exp)
}

func (i *instance) hasValidCookie(r *http.Request) bool {
	c, err := r.Cookie(cookieName)
	if err != nil || len(c.Value) != len(i.cookieSecret) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(c.Value), []byte(i.cookieSecret)) == 1
}

// isAuthorized verifies that the request carries the proxy capability cookie or comes from an
// already-bootstrapped iframe context whose browser blocked third-party loopback cookies
// (SameSite=Lax cross-site iframe or Safari/WKWebView ITP). Foreign Origins and unsolicited
// cross-site requests are still rejected.
func (i *instance) isAuthorized(r *http.Request) bool {
	if !i.isOwnHost(r.Host) {
		return false
	}
	if i.hasValidCookie(r) {
		return true
	}
	if !i.activated.Load() {
		return false
	}
	if origin := r.Header.Get("Origin"); origin != "" && origin != i.proxyOrigin {
		return false
	}
	isSafeNavMethod := r.Method == http.MethodGet || r.Method == http.MethodHead
	if ref := r.Header.Get("Referer"); ref != "" && ref != i.proxyOrigin && !strings.HasPrefix(ref, i.proxyOrigin+"/") {
		return isSafeNavMethod && i.hasPendingNav(r.URL.RequestURI())
	}
	if sfs := r.Header.Get("Sec-Fetch-Site"); strings.EqualFold(sfs, "cross-site") {
		return isSafeNavMethod && i.hasPendingNav(r.URL.RequestURI())
	}
	return true
}

// isOwnHost says the request names this proxy's own loopback listener (127.0.0.1:port, or localhost / another
// loopback IP on the same port). Any other Host is a page that rebound its DNS name to 127.0.0.1, or a request that
// was never meant for this proxy: refused whatever cookie it carries.
func (i *instance) isOwnHost(host string) bool {
	if host == i.proxyHost {
		return true
	}
	h, port, err := net.SplitHostPort(host)
	_, ownPort, _ := net.SplitHostPort(i.proxyHost)
	if err != nil || port != ownPort {
		return false
	}
	if strings.EqualFold(h, "localhost") {
		return true
	}
	ip := net.ParseIP(h)
	return ip != nil && ip.IsLoopback()
}

func (i *instance) handler(rp *httputil.ReverseProxy) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		i.lastUsed.Store(time.Now().UnixNano())

		if r.URL.Path == bootstrapURI {
			dest, ok := i.consumeTicket(r.URL.Query().Get("ticket"))
			if !ok {
				http.Error(w, "invalid or expired browser session ticket", http.StatusForbidden)
				return
			}
			http.SetCookie(w, &http.Cookie{
				Name:     cookieName,
				Value:    i.cookieSecret,
				Path:     "/",
				HttpOnly: true,
				SameSite: http.SameSiteLaxMode,
			})
			http.Redirect(w, r, dest, http.StatusFound)
			return
		}

		if !i.isAuthorized(r) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}

		if r.URL.Path == inspectorURI {
			w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
			w.Header().Set("Cache-Control", "no-store")
			w.Header().Set("X-Content-Type-Options", "nosniff")
			if _, err := w.Write(inspectorJS); err != nil {
				return
			}
			return
		}

		if strings.HasPrefix(r.URL.Path, prefixPath) {
			http.NotFound(w, r)
			return
		}

		rp.ServeHTTP(w, r)
	})
}

func (i *instance) rewriteRequest(pr *httputil.ProxyRequest) {
	pr.SetURL(i.target)
	pr.Out.Host = i.target.Host

	// Strip our internal capability cookie before forwarding upstream.
	stripNamedCookie(pr.Out, cookieName)

	if origin := pr.In.Header.Get("Origin"); origin == i.proxyOrigin {
		pr.Out.Header.Set("Origin", i.targetOrigin)
	}
	if ref := pr.In.Header.Get("Referer"); strings.HasPrefix(ref, i.proxyOrigin) {
		pr.Out.Header.Set("Referer", i.targetOrigin+strings.TrimPrefix(ref, i.proxyOrigin))
	}
	// Let Go's http.Transport advertise gzip and transparently gunzip before modifyResponse.
	if !isWebSocketUpgrade(pr.In) {
		pr.Out.Header.Del("Accept-Encoding")
	}
}

func (i *instance) shutdown(ctx context.Context) error {
	err := i.srv.Shutdown(ctx)
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

func isWebSocketUpgrade(r *http.Request) bool {
	return strings.EqualFold(r.Header.Get("Upgrade"), "websocket")
}

func sanitizeRedirectPath(p string) string {
	if p == "" || !strings.HasPrefix(p, "/") || strings.HasPrefix(p, "//") {
		return "/"
	}
	return p
}

func stripNamedCookie(r *http.Request, dropName string) {
	cookies := r.Cookies()
	if len(cookies) == 0 {
		return
	}
	r.Header.Del("Cookie")
	for _, c := range cookies {
		if c.Name != dropName {
			r.AddCookie(c)
		}
	}
}
