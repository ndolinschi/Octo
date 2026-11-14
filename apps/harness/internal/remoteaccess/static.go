package remoteaccess

import (
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
)

// CSP is the Content-Security-Policy of the web app's pages: its own scripts only, inline styles (React's style
// attributes), images and fonts from itself or data:/blob:, workers from itself (the editor), no framing.
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
	"font-src 'self' data:; worker-src 'self' blob:; connect-src 'self'; manifest-src 'self'; frame-ancestors 'none'; " +
	"base-uri 'none'; form-action 'none'; object-src 'none'"

const missingPage = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Octo</title><body style="font:16px system-ui;margin:2rem;max-width:30rem">
<h1 style="font-size:1.25rem">Octo is reachable, but its phone app is not installed here.</h1>
<p>On the computer, build it with <code>pnpm --filter @octo/web build</code> and start the harness with
<code>HARNESS_REMOTE_WEB_DIR</code> pointing at <code>apps/web/dist</code>.</p></body>`

// static serves the mobile web app: from WebDir (unknown paths without an extension get index.html, so the app's
// own routes load), proxied to WebProxy in development, or a one-paragraph page saying it is not installed.
func (m *Manager) static() http.Handler {
	if m.o.WebProxy != "" {
		if u, err := url.Parse(m.o.WebProxy); err == nil {
			rp := httputil.NewSingleHostReverseProxy(u)
			return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				r.Header.Del("Authorization")
				rp.ServeHTTP(w, r)
			})
		}
	}
	dir := m.o.WebDir
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			noStore(w)
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		if dir == "" {
			htmlHeaders(w)
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = w.Write([]byte(missingPage))
			return
		}
		clean := path.Clean("/" + r.URL.Path)
		file := filepath.Join(dir, filepath.FromSlash(clean))
		if fi, err := os.Stat(file); err == nil && !fi.IsDir() && !hidden(clean) {
			serveFile(w, r, file, clean)
			return
		}
		if path.Ext(clean) != "" {
			noStore(w)
			http.NotFound(w, r)
			return
		}
		serveFile(w, r, filepath.Join(dir, "index.html"), "/index.html")
	})
}

func hidden(p string) bool {
	for _, s := range strings.Split(p, "/") {
		if strings.HasPrefix(s, ".") {
			return true
		}
	}
	return false
}

func htmlHeaders(w http.ResponseWriter) {
	h := w.Header()
	h.Set("Content-Security-Policy", CSP)
	h.Set("Cache-Control", "no-cache")
	h.Set("Content-Type", "text/html; charset=utf-8")
}

func serveFile(w http.ResponseWriter, r *http.Request, file, clean string) {
	switch {
	case strings.HasSuffix(clean, ".html"):
		htmlHeaders(w)
	case strings.HasPrefix(clean, "/assets/"):
		// Vite's hashed files never change under one name.
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	default:
		w.Header().Set("Cache-Control", "no-cache")
	}
	if strings.HasSuffix(clean, ".webmanifest") {
		w.Header().Set("Content-Type", "application/manifest+json")
	}
	http.ServeFile(w, r, file)
}
