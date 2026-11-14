package remoteaccess

import (
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/usererr"
)

// Status is GET /v1/remote: everything Settings → Remote access shows. Local only (never sent to a device).
type Status struct {
	State     string `json:"state"`
	URL       string `json:"url,omitempty"`
	Connected bool   `json:"connected"`
	// Error is set in state "error" (cloudflared_missing, tunnel_failed).
	Error *ProblemView `json:"error,omitempty"`
	// Listen is the tunnel listener's loopback address while it is open (for scripts and tests).
	Listen       string       `json:"listen,omitempty"`
	Cloudflared  Cloudflared  `json:"cloudflared"`
	Pairing      *PairingView `json:"pairing,omitempty"`
	Devices      []DeviceView `json:"devices"`
	Online       int          `json:"online"`
	Pending      int          `json:"pending"`
	Acknowledged bool         `json:"acknowledged"`
	Permissions  []string     `json:"permissions"`
	IdleOffHours float64      `json:"idle_off_hours"`
	WebApp       bool         `json:"web_app"`
}

// ProblemView is an error with its stable code.
type ProblemView struct {
	Code string `json:"code"`
	usererr.Info
}

// PairingView is the open pairing code. Link is the URL to put in the QR code: the code rides in the fragment,
// which browsers never send to a server.
type PairingView struct {
	Code      string    `json:"code"`
	ExpiresAt time.Time `json:"expires_at"`
	Link      string    `json:"link"`
}

// Status reports the current state.
func (m *Manager) Status() Status {
	m.mu.Lock()
	s := Status{State: m.state, URL: m.url, Connected: m.connected, Cloudflared: m.cf}
	if m.problem != nil {
		s.Error = &ProblemView{Code: m.problem.Code, Info: *m.problem.Info()}
	}
	if m.ln != nil {
		s.Listen = m.ln.Addr().String()
	}
	m.mu.Unlock()
	if code, exp := m.pair.Code(); code != "" && s.URL != "" {
		s.Pairing = &PairingView{Code: FormatCode(code), ExpiresAt: exp.UTC(), Link: s.URL + "/#pair=" + code}
	}
	s.Devices = m.devices.List(OnlineWindow)
	for _, d := range s.Devices {
		if d.Online {
			s.Online++
		}
		if d.Status == StatusPending {
			s.Pending++
		}
	}
	s.Acknowledged = m.devices.Acknowledged()
	s.Permissions = m.o.Allow.List()
	if m.o.IdleOff > 0 {
		s.IdleOffHours = m.o.IdleOff.Hours()
	}
	s.WebApp = m.o.WebDir != "" || m.o.WebProxy != ""
	return s
}

// FormatCode shows a code as two groups of four (ABCD-EFGH).
func FormatCode(c string) string {
	if len(c) != CodeLength {
		return c
	}
	return c[:4] + "-" + c[4:]
}
