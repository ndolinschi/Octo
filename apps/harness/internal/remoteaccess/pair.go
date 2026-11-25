package remoteaccess

import (
	"encoding/json"
	"math"
	"net"
	"net/http"
	"strconv"
	"strings"

	"github.com/ndolinschi/Octo/apps/harness/internal/usererr"
)

// ClaimResult is POST /pair/claim's answer: the token is in it once and never again.
type ClaimResult struct {
	DeviceID string `json:"device_id"`
	Name     string `json:"name"`
	Token    string `json:"token"`
	Status   string `json:"status"`
}

// Me is GET /pair/me: what a device is and may do.
type Me struct {
	DeviceID    string   `json:"device_id"`
	Name        string   `json:"name"`
	Status      string   `json:"status"`
	ReadOnly    bool     `json:"read_only"`
	Permissions []string `json:"permissions"`
}

var claimStatus = map[string]int{
	"pairing_rate_limited": http.StatusTooManyRequests,
	"pairing_backoff":      http.StatusTooManyRequests,
	"pairing_locked":       http.StatusLocked,
	"pairing_code_invalid": http.StatusForbidden,
	"pairing_code_expired": http.StatusForbidden,
}

// claimSource names who is claiming, for the per-source count of wrong codes. Through the tunnel every request
// comes from cloudflared on loopback, so the address is the one Cloudflare's edge saw (Cf-Connecting-Ip, which the
// edge sets and a client cannot); without it (a request straight to the loopback listener), the peer address.
func claimSource(r *http.Request) string {
	if ip := strings.TrimSpace(r.Header.Get("Cf-Connecting-Ip")); ip != "" {
		return "cf:" + ip
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return "peer:" + r.RemoteAddr
	}
	return "peer:" + host
}

func (m *Manager) claim(w http.ResponseWriter, r *http.Request) {
	noStore(w)
	var body struct {
		Code string `json:"code"`
		Name string `json:"name"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil {
		writeProblem(w, http.StatusBadRequest, usererr.Generic("invalid_request", "body must be {code, name}"))
		return
	}
	from := claimSource(r)
	if code := m.pair.Claim(body.Code, from); code != "" {
		switch code {
		case "pairing_rate_limited":
			w.Header().Set("Retry-After", "1")
		case "pairing_backoff":
			w.Header().Set("Retry-After", strconv.Itoa(int(math.Ceil(m.pair.Wait(from).Seconds()))))
		}
		writeProblem(w, claimStatus[code], usererr.Remote(code))
		return
	}
	d, token, err := m.devices.Add(body.Name)
	if err != nil {
		writeProblem(w, http.StatusInternalServerError, usererr.Generic("internal", err.Error()))
		return
	}
	m.mu.Lock()
	m.activity = m.o.Now()
	m.mu.Unlock()
	m.changed()
	writeJSON(w, http.StatusCreated, ClaimResult{DeviceID: d.ID, Name: d.Name, Token: token, Status: d.Status})
}

func (m *Manager) me(w http.ResponseWriter, r *http.Request) {
	noStore(w)
	d, ok := m.authenticate(w, r)
	if !ok {
		return
	}
	perms := []string{"read"}
	if !d.ReadOnly {
		perms = m.o.Allow.List()
	}
	if d.Status == StatusActive {
		m.devices.Touch(d.ID)
		m.mu.Lock()
		m.activity = m.o.Now()
		m.mu.Unlock()
	}
	writeJSON(w, http.StatusOK, Me{DeviceID: d.ID, Name: d.Name, Status: d.Status, ReadOnly: d.ReadOnly, Permissions: perms})
}
