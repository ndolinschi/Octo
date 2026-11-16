package browserproxy

import (
	"context"
	"crypto/subtle"
	_ "embed"
	"errors"
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
	cookieName   = "__octo_bp"
	ticketTTL    = 60 * time.Second
	prefixPath   = "/__octo_browser/"
	bootstrapURI = "/__octo_browser/bootstrap"
	inspectorURI = "/__octo_browser/inspector.js"
)

type ticketEntry struct {
	targetPath string
	expiresAt  time.Time
}

type instance struct {
	target       *url.URL
	targetOrigin string
	proxyOrigin  string
	cookieSecret string
	nonce        string
	ln           net.Listener
	srv          *http.Server
	lastUsed     atomic.Int64

	mu      sync.Mutex
	tickets map[string]ticketEntry
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
	inst := &instance{
		target:       &url.URL{Scheme: target.Scheme, Host: target.Host},
		targetOrigin: target.Scheme + "://" + target.Host,
		proxyOrigin:  "http://" + ln.Addr().String(),
		cookieSecret: secret,
		nonce:        nonce,
		ln:           ln,
		tickets:      make(map[string]ticketEntry),
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
			http.Error(w, "Upstream server unreachable: "+proxyErr.Error(), http.StatusBadGateway)
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
	i.mu.Unlock()
	if !ok || now.After(entry.expiresAt) {
		return "", false
	}
	return entry.targetPath, true
}

func (i *instance) hasValidCookie(r *http.Request) bool {
	c, err := r.Cookie(cookieName)
	if err != nil || len(c.Value) != len(i.cookieSecret) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(c.Value), []byte(i.cookieSecret)) == 1
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

		if !i.hasValidCookie(r) {
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
	// Request uncompressed HTML from upstream so inspector script injection needs no codec.
	if !isWebSocketUpgrade(pr.In) {
		pr.Out.Header.Set("Accept-Encoding", "identity")
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
