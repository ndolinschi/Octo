package remoteaccess

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/events"
)

// stubAPI stands in for the bridge: it echoes what reached it.
type stubAPI struct{ hub *events.Hub }

func (s stubAPI) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"method": r.Method, "path": r.URL.Path, "auth": r.Header.Get("Authorization")})
}

type rig struct {
	t   *testing.T
	m   *Manager
	hub *events.Hub
	bin string
	pub chan map[string]any
}

func newRig(t *testing.T, mode string, tweak func(*Options)) *rig {
	t.Helper()
	hub := events.NewHub()
	r := &rig{t: t, hub: hub, bin: fakeCloudflared(t, mode), pub: make(chan map[string]any, 256)}
	o := Options{
		DataDir:     t.TempDir(),
		Cloudflared: r.bin,
		API:         stubAPI{hub},
		Subscribe: func(_ context.Context, pid string) (<-chan events.Event, func(), error) {
			ch, cancel := hub.Subscribe(pid)
			return ch, cancel, nil
		},
		Publish: func(typ string, f map[string]any) {
			if typ == EventChanged {
				select {
				case r.pub <- f:
				default:
				}
			}
		},
		Version:      "test",
		ClaimSpacing: time.Nanosecond,
		StopGrace:    time.Second,
		Backoff:      func(int) time.Duration { return 10 * time.Millisecond },
	}
	if tweak != nil {
		tweak(&o)
	}
	m, err := New(o)
	if err != nil {
		t.Fatal(err)
	}
	r.m = m
	t.Cleanup(m.Close)
	return r
}

func eventually(t *testing.T, what string, f func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if f() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

// on enables remote access (acknowledging) and waits for the URL.
func (r *rig) on() Status {
	r.t.Helper()
	if _, err := r.m.Enable(true); err != nil {
		r.t.Fatal(err)
	}
	eventually(r.t, "state on", func() bool { return r.m.Status().State == StateOn })
	return r.m.Status()
}

func (r *rig) base() string { return "http://" + r.m.Status().Listen }

type resp struct {
	status int
	header http.Header
	body   map[string]any
	raw    string
}

func (r *rig) do(method, path, token string, body any) resp {
	r.t.Helper()
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, r.base()+path, rd)
	if err != nil {
		r.t.Fatal(err)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	req.Header.Set("Origin", "https://evil.example")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		r.t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	out := resp{status: res.StatusCode, header: res.Header, raw: string(b)}
	_ = json.Unmarshal(b, &out.body)
	return out
}

func (x resp) code() string {
	if e, ok := x.body["error"].(map[string]any); ok {
		s, _ := e["code"].(string)
		return s
	}
	return ""
}

// pair issues a code, claims it and (when confirm) allows the device; it returns the token and the device id.
func (r *rig) pair(confirm bool) (string, string) {
	r.t.Helper()
	st, err := r.m.IssueCode()
	if err != nil {
		r.t.Fatal(err)
	}
	if st.Pairing == nil || !strings.HasSuffix(st.Pairing.Link, "/#pair="+strings.ReplaceAll(st.Pairing.Code, "-", "")) {
		r.t.Fatalf("pairing view %+v", st.Pairing)
	}
	res := r.do("POST", "/pair/claim", "", map[string]string{"code": st.Pairing.Code, "name": "Test phone"})
	if res.status != http.StatusCreated {
		r.t.Fatalf("claim: %d %s", res.status, res.raw)
	}
	tok, _ := res.body["token"].(string)
	id, _ := res.body["device_id"].(string)
	if confirm {
		if err := r.m.Confirm(id); err != nil {
			r.t.Fatal(err)
		}
	}
	return tok, id
}
