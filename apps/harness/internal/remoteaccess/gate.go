package remoteaccess

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"path"
	"strconv"
	"strings"
	"sync"

	"github.com/ndolinschi/Octo/apps/harness/internal/attachments"
	"github.com/ndolinschi/Octo/apps/harness/internal/usererr"
)

const (
	maxBody     = 1 << 20
	uploadSlack = 1 << 20
)

// remoteHandler is everything the tunnel listener serves (spec section 3). Nothing here trusts the peer address:
// every request arrives from cloudflared on 127.0.0.1.
func (m *Manager) remoteHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) {
		noStore(w)
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "version": m.o.Version})
	})
	mux.HandleFunc("POST /pair/claim", m.claim)
	mux.HandleFunc("GET /pair/me", m.me)
	mux.HandleFunc("/pair/", func(w http.ResponseWriter, _ *http.Request) {
		noStore(w)
		writeProblem(w, http.StatusNotFound, usererr.Generic("not_found", "no such route"))
	})
	mux.Handle("/v1/", m.apiGate())
	mux.Handle("/mcp/", http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		noStore(w)
		writeProblem(w, http.StatusForbidden, usererr.Remote("remote_forbidden"))
	}))
	mux.Handle("/", m.static())
	return securityHeaders(mux)
}

// securityHeaders: no CORS header is ever set (the web app is same-origin), plus the headers every answer carries.
func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		if r.Method == http.MethodOptions {
			// No preflight is ever answered: a cross-origin page gets nothing.
			noStore(w)
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func noStore(w http.ResponseWriter) { w.Header().Set("Cache-Control", "no-store") }

type ctxKey struct{}

// deviceOf is the device a gated request was authenticated as.
func deviceOf(r *http.Request) (Device, bool) {
	d, ok := r.Context().Value(ctxKey{}).(Device)
	return d, ok
}

// bearer is the Authorization header's token ("" when absent or not Bearer).
func bearer(r *http.Request) string {
	scheme, tok, ok := strings.Cut(r.Header.Get("Authorization"), " ")
	if !ok || !strings.EqualFold(scheme, "Bearer") {
		return ""
	}
	return strings.TrimSpace(tok)
}

// authenticate finds the request's device; it writes the refusal itself and returns false when there is none.
func (m *Manager) authenticate(w http.ResponseWriter, r *http.Request) (Device, bool) {
	if r.URL.Query().Has("token") {
		writeProblem(w, http.StatusUnauthorized, usererr.Remote("query_token_refused"))
		return Device{}, false
	}
	d, code := m.devices.Authenticate(bearer(r))
	if code != "" {
		w.Header().Set("WWW-Authenticate", `Bearer realm="octo-remote"`)
		writeProblem(w, http.StatusUnauthorized, usererr.Remote(code))
		return Device{}, false
	}
	return d, true
}

// apiGate lets a request through to the bridge only with an active device token and a route the device may use.
func (m *Manager) apiGate() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		noStore(w)
		p := r.URL.Path
		// A path that is not canonical, or that hides a slash in an escape, could be read one way here and another
		// way by the bridge's router: refused before anything else.
		if path.Clean(p) != p || strings.Contains(strings.ToLower(r.URL.RawPath), "%2f") {
			writeProblem(w, http.StatusBadRequest, usererr.Generic("invalid_request", "path is not canonical"))
			return
		}
		d, ok := m.authenticate(w, r)
		if !ok {
			return
		}
		if d.Status != StatusActive {
			writeProblem(w, http.StatusForbidden, usererr.Remote("device_pending"))
			return
		}
		class, _ := Classify(r.Method, p)
		switch {
		case class == ClassDeny:
			writeProblem(w, http.StatusForbidden, usererr.Remote("remote_forbidden"))
			return
		case class != ClassRead && d.ReadOnly:
			writeProblem(w, http.StatusForbidden, usererr.Remote("remote_read_only"))
			return
		case class != ClassRead && !m.o.Allow[class]:
			writeProblem(w, http.StatusForbidden, usererr.Remote("remote_forbidden"))
			return
		}
		if class == ClassAnswer && isApprovalAnswer(r) && !onceOnly(w, r) {
			return
		}
		m.devices.Touch(d.ID)
		m.mu.Lock()
		m.activity = m.o.Now()
		m.mu.Unlock()
		ctx, done := m.track.add(d.ID, context.WithValue(r.Context(), ctxKey{}, d))
		defer done()
		r = r.WithContext(ctx)
		r.Header.Del("Authorization")
		limit := int64(maxBody)
		if isAttachmentUpload(r) {
			limit = attachments.MaxBytes + uploadSlack
		}
		r.Body = http.MaxBytesReader(w, r.Body, limit)
		if isPoll(r) {
			m.poll(w, r)
			return
		}
		m.o.API.ServeHTTP(w, r)
	})
}

func isAttachmentUpload(r *http.Request) bool {
	segs := split(r.URL.Path)
	return r.Method == http.MethodPost && len(segs) == 4 && segs[0] == "v1" && segs[1] == "projects" && segs[3] == "attachments"
}

func isApprovalAnswer(r *http.Request) bool {
	segs := split(r.URL.Path)
	return r.Method == http.MethodPost && len(segs) == 5 && segs[0] == "v1" && segs[1] == "projects" && segs[3] == "approvals"
}

// onceOnly lets a device answer an approval for this one request only: "allow" or "deny", with a note. A rule
// (allow_always, match), a grant for the rest of the turn (allow_for_turn, allow_all_for_turn) or anything else is
// refused; the body the bridge gets is rebuilt from the two fields, so an ACP option id (which could name an
// agent's own "always" option) is dropped and the harness picks the agent's allow-once or reject-once option.
// It writes the refusal itself and returns false.
func onceOnly(w http.ResponseWriter, r *http.Request) bool {
	var in struct {
		Decision string `json:"decision"`
		Note     string `json:"note"`
		Match    string `json:"match"`
	}
	data, err := io.ReadAll(io.LimitReader(r.Body, maxBody))
	if err != nil || json.Unmarshal(data, &in) != nil || (in.Decision != "allow" && in.Decision != "deny") || in.Match != "" {
		writeProblem(w, http.StatusForbidden, usererr.Remote("remote_decision_forbidden"))
		return false
	}
	body, _ := json.Marshal(map[string]string{"decision": in.Decision, "note": in.Note})
	r.Body = io.NopCloser(bytes.NewReader(body))
	r.ContentLength = int64(len(body))
	r.Header.Set("Content-Length", strconv.Itoa(len(body)))
	return true
}

func isPoll(r *http.Request) bool {
	segs := split(r.URL.Path)
	return r.Method == http.MethodGet && len(segs) == 5 && segs[0] == "v1" && segs[1] == "projects" && segs[3] == "events" && segs[4] == "poll"
}

// tracker holds a cancel func per open request of each device, so a revoke ends long polls and streams at once.
type tracker struct {
	mu   sync.Mutex
	next int
	m    map[string]map[int]context.CancelFunc
}

func newTracker() *tracker { return &tracker{m: map[string]map[int]context.CancelFunc{}} }

func (t *tracker) add(id string, parent context.Context) (context.Context, func()) {
	ctx, cancel := context.WithCancel(parent)
	t.mu.Lock()
	t.next++
	n := t.next
	if t.m[id] == nil {
		t.m[id] = map[int]context.CancelFunc{}
	}
	t.m[id][n] = cancel
	t.mu.Unlock()
	return ctx, func() {
		t.mu.Lock()
		delete(t.m[id], n)
		t.mu.Unlock()
		cancel()
	}
}

func (t *tracker) cancel(id string) {
	t.mu.Lock()
	cs := t.m[id]
	delete(t.m, id)
	t.mu.Unlock()
	for _, c := range cs {
		c()
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		slog.Debug("remote: write response", "err", err)
	}
}

// writeProblem sends a catalogue error in the bridge's error shape.
func writeProblem(w http.ResponseWriter, status int, u *usererr.Error) {
	body := map[string]any{"code": u.Code, "message": u.Message}
	u.AddTo(body, "hint", "command", "action", "details")
	writeJSON(w, status, map[string]any{"error": body})
}
