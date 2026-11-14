package remoteaccess

import (
	"encoding/json"
	"net/http"

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
	"pairing_locked":       http.StatusLocked,
	"pairing_code_invalid": http.StatusForbidden,
	"pairing_code_expired": http.StatusForbidden,
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
	if code := m.pair.Claim(body.Code); code != "" {
		if code == "pairing_rate_limited" {
			w.Header().Set("Retry-After", "1")
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
