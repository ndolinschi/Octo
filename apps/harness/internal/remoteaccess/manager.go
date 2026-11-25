// Package remoteaccess is the harness's remote door for a paired phone
// (docs/superpowers/specs/2026-11-14-remote-access-mobile-design.md): it runs Cloudflare's `cloudflared` quick
// tunnel to a second, loopback-only listener, serves the mobile web app and pairing there, and lets requests that
// carry an active device token through to the bridge API by an allow-list. The computer controls it through the
// local routes of ControlHandler. Off after every start.
package remoteaccess

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/events"
	"github.com/ndolinschi/Octo/apps/harness/internal/usererr"
)

// States of remote access.
const (
	StateOff      = "off"
	StateStarting = "starting"
	StateOn       = "on"
	StateError    = "error"
)

// EventChanged is published on every project stream when the state, the devices or a pending request change.
const EventChanged = "remote.changed"

// OnlineWindow is how recently a device must have made a request to count as connected.
const OnlineWindow = time.Minute

// Options configures a Manager. Zero values take the defaults in brackets.
type Options struct {
	DataDir string
	// Cloudflared is a path or command name (HARNESS_REMOTE_CLOUDFLARED) ["cloudflared" on PATH].
	Cloudflared string
	// Addr is the tunnel listener's address (HARNESS_REMOTE_ADDR) ["127.0.0.1:0"].
	Addr string
	// WebDir holds the built mobile web app (HARNESS_REMOTE_WEB_DIR); WebProxy a dev server to proxy to instead.
	WebDir, WebProxy string
	// Allow is the permissions every device has beyond reading (HARNESS_REMOTE_ALLOW) [send, answer, stop].
	Allow Perms
	// DeviceIdle expires a device unused this long (HARNESS_REMOTE_DEVICE_IDLE_DAYS) [30 days].
	DeviceIdle time.Duration
	// IdleOff turns remote access off after no device request for this long (HARNESS_REMOTE_IDLE_OFF_HOURS);
	// negative = never [8 h].
	IdleOff time.Duration
	// API is the bridge's routes with no authentication and no CORS (bridge.NewAPI).
	API http.Handler
	// Subscribe opens a project's event stream (project.Service.Subscribe).
	Subscribe func(ctx context.Context, pid string) (<-chan events.Event, func(), error)
	// Publish delivers an event on every project stream (events.Hub.PublishAll).
	Publish func(typ string, fields map[string]any)
	// OnListen is told the tunnel listener's port each time it opens (the Browser tab's proxy blocks it).
	OnListen func(port int)
	Version  string

	// Test knobs.
	Now          func() time.Time
	StartTimeout time.Duration                     // [30 s] for a URL
	Backoff      func(attempt int) time.Duration   // [Backoff]
	MaxFails     int                               // [5]
	StopGrace    time.Duration                     // [3 s]
	ClaimSpacing time.Duration                     // [1 s]
	CodeTTL      time.Duration                     // [5 min]
	PendingTTL   time.Duration                     // [5 min]
	PollWait     time.Duration                     // [25 s] cap of a long poll
	Tick         time.Duration                     // [30 s] sweep and idle check
	Find         func(context.Context) Cloudflared // [FindCloudflared(Cloudflared)]
}

// Manager is remote access: the state machine, the tunnel, the listener, the devices and pairing.
type Manager struct {
	o       Options
	devices *Store
	pair    *Pairing
	polls   *polls
	track   *tracker

	mu        sync.Mutex
	state     string
	url       string
	connected bool
	problem   *usererr.Error
	cf        Cloudflared
	ln        net.Listener
	srv       *http.Server
	cancel    context.CancelFunc
	done      chan struct{}
	activity  time.Time
}

// New opens the devices store and finds cloudflared. Remote access starts off.
func New(o Options) (*Manager, error) {
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.Addr == "" {
		o.Addr = "127.0.0.1:0"
	}
	if err := CheckAddr(o.Addr); err != nil {
		return nil, err
	}
	if o.Allow == nil {
		o.Allow = DefaultPerms()
	}
	if o.DeviceIdle == 0 {
		o.DeviceIdle = 30 * 24 * time.Hour
	}
	if o.IdleOff == 0 {
		o.IdleOff = 8 * time.Hour
	}
	def := func(d *time.Duration, v time.Duration) {
		if *d == 0 {
			*d = v
		}
	}
	def(&o.StartTimeout, 30*time.Second)
	def(&o.StopGrace, 3*time.Second)
	def(&o.ClaimSpacing, ClaimSpacing)
	def(&o.CodeTTL, CodeTTL)
	def(&o.PendingTTL, 5*time.Minute)
	def(&o.PollWait, 25*time.Second)
	def(&o.Tick, 30*time.Second)
	if o.Backoff == nil {
		o.Backoff = Backoff
	}
	if o.MaxFails == 0 {
		o.MaxFails = 5
	}
	if o.Find == nil {
		bin := o.Cloudflared
		o.Find = func(ctx context.Context) Cloudflared { return FindCloudflared(ctx, bin) }
	}
	if o.Publish == nil {
		o.Publish = func(string, map[string]any) {}
	}
	st, err := OpenStore(o.DataDir, o.DeviceIdle, o.PendingTTL, o.Now)
	if err != nil {
		return nil, err
	}
	m := &Manager{o: o, devices: st, pair: newPairing(o.CodeTTL, o.ClaimSpacing, o.Now), track: newTracker(), state: StateOff}
	m.polls = newPolls(o.Subscribe, o.Now)
	m.cf = o.Find(context.Background())
	return m, nil
}

// Run sweeps expired devices and turns remote access off after the idle period; it stops everything when ctx ends.
func (m *Manager) Run(ctx context.Context) {
	t := time.NewTicker(m.o.Tick)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			m.Disable()
			return
		case <-t.C:
			m.devices.Sweep()
			m.polls.reap(2 * m.o.PollWait)
			m.mu.Lock()
			idle := m.state != StateOff && m.o.IdleOff > 0 && m.o.Now().Sub(m.activity) > m.o.IdleOff
			m.mu.Unlock()
			if idle {
				slog.Info("remote access turned off: no device used it", "idle", m.o.IdleOff)
				m.Disable()
			}
		}
	}
}

// Enable opens the listener and starts the tunnel. The first time ever it needs ack (the owner read the warning).
func (m *Manager) Enable(ack bool) (Status, error) {
	if !m.devices.Acknowledged() {
		if !ack {
			return m.Status(), usererr.Remote("remote_ack_required")
		}
		if err := m.devices.Acknowledge(); err != nil {
			return m.Status(), err
		}
	}
	m.mu.Lock()
	if m.state == StateStarting || m.state == StateOn {
		m.mu.Unlock()
		return m.Status(), nil
	}
	m.mu.Unlock()
	m.Disable() // a previous error state may still hold the listener
	cf := m.o.Find(context.Background())
	m.mu.Lock()
	m.cf = cf
	if !cf.Found {
		m.state, m.problem = StateError, usererr.CloudflaredMissing(cf.Install)
		m.mu.Unlock()
		m.changed()
		return m.Status(), nil
	}
	ln, err := net.Listen("tcp", m.o.Addr)
	if err != nil {
		m.state, m.problem = StateError, usererr.TunnelFailed(err.Error())
		m.mu.Unlock()
		m.changed()
		return m.Status(), nil
	}
	if t, ok := ln.Addr().(*net.TCPAddr); ok && m.o.OnListen != nil {
		m.o.OnListen(t.Port)
	}
	ctx, cancel := context.WithCancel(context.Background())
	m.ln, m.cancel, m.done = ln, cancel, make(chan struct{})
	m.srv = &http.Server{Handler: m.remoteHandler(), ReadHeaderTimeout: 10 * time.Second, BaseContext: func(net.Listener) context.Context { return ctx }}
	m.state, m.url, m.connected, m.problem, m.activity = StateStarting, "", false, nil, m.o.Now()
	srv, done := m.srv, m.done
	m.mu.Unlock()

	go func() {
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("remote listener", "err", err)
		}
	}()
	target := "http://" + ln.Addr().String()
	go func() {
		defer close(done)
		superviseTunnel(ctx, tunnelOpts{bin: cf.Path, target: target, startTimeout: m.o.StartTimeout, backoff: m.o.Backoff, maxFails: m.o.MaxFails, stopGrace: m.o.StopGrace}, tunnelHooks{
			onURL:       m.tunnelURL,
			onConnected: func() { m.set(func() { m.connected = true }) },
			onRestart:   func(int) { m.set(func() { m.state, m.connected = StateStarting, false }) },
			onFailed:    m.tunnelFailed,
		})
	}()
	slog.Info("remote access starting", "listen", ln.Addr().String(), "cloudflared", cf.Path)
	m.changed()
	return m.Status(), nil
}

func (m *Manager) set(f func()) {
	m.mu.Lock()
	f()
	m.mu.Unlock()
	m.changed()
}

func (m *Manager) tunnelURL(u string) {
	m.mu.Lock()
	moved := m.url != "" && m.url != u
	m.state, m.url = StateOn, u
	m.mu.Unlock()
	if moved {
		// The QR code and the code shown with the old URL lead nowhere now.
		m.pair.Cancel()
	}
	slog.Info("remote access on", "url", u)
	m.changed()
}

func (m *Manager) tunnelFailed(tail string) {
	m.mu.Lock()
	m.state, m.problem, m.url, m.connected = StateError, usererr.TunnelFailed(tail), "", false
	m.mu.Unlock()
	m.pair.Cancel()
	slog.Warn("remote access: the tunnel failed", "tail", tail)
	m.changed()
}

// Disable stops the tunnel (its whole process group) and the listener, and withdraws the code and pending devices.
func (m *Manager) Disable() Status {
	m.mu.Lock()
	cancel, done, srv := m.cancel, m.done, m.srv
	wasOff := m.state == StateOff
	m.cancel, m.done, m.srv, m.ln = nil, nil, nil, nil
	m.state, m.url, m.connected, m.problem = StateOff, "", false, nil
	m.mu.Unlock()
	if cancel != nil {
		cancel()
		<-done
	}
	if srv != nil {
		ctx, c := context.WithTimeout(context.Background(), 2*time.Second)
		_ = srv.Shutdown(ctx)
		c()
		_ = srv.Close()
	}
	m.polls.closeAll()
	m.pair.Cancel()
	m.devices.DropPending()
	if !wasOff {
		slog.Info("remote access off")
		m.changed()
	}
	return m.Status()
}

// Check looks for cloudflared again (after the owner installed it).
func (m *Manager) Check() Status {
	cf := m.o.Find(context.Background())
	m.mu.Lock()
	m.cf = cf
	if cf.Found && m.problem != nil && m.problem.Code == "cloudflared_missing" {
		m.state, m.problem = StateOff, nil
	}
	m.mu.Unlock()
	return m.Status()
}

// IssueCode opens a new pairing code (remote access must be on).
func (m *Manager) IssueCode() (Status, error) {
	m.mu.Lock()
	on := m.state == StateOn
	m.mu.Unlock()
	if !on {
		return m.Status(), usererr.Remote("remote_off")
	}
	m.pair.Issue()
	return m.Status(), nil
}

// CancelCode withdraws the open code.
func (m *Manager) CancelCode() Status {
	m.pair.Cancel()
	return m.Status()
}

// Confirm allows a pending device.
func (m *Manager) Confirm(id string) error {
	err := m.devices.Confirm(id)
	if err == nil {
		m.changed()
	}
	return err
}

// SetReadOnly switches a device's read-only mode.
func (m *Manager) SetReadOnly(id string, ro bool) error {
	err := m.devices.SetReadOnly(id, ro)
	if err == nil {
		m.changed()
	}
	return err
}

// Revoke removes a device and ends what it has open.
func (m *Manager) Revoke(id string) error {
	if err := m.devices.Revoke(id); err != nil {
		return err
	}
	m.track.cancel(id)
	m.polls.closeDevice(id)
	m.changed()
	return nil
}

// RevokeAllAndOff removes every device and turns remote access off.
func (m *Manager) RevokeAllAndOff() (Status, error) {
	ids, err := m.devices.RevokeAll()
	for _, id := range ids {
		m.track.cancel(id)
		m.polls.closeDevice(id)
	}
	st := m.Disable()
	m.changed()
	return st, err
}

// Close turns remote access off (harness shutdown).
func (m *Manager) Close() { m.Disable() }

func (m *Manager) changed() {
	m.mu.Lock()
	state := m.state
	m.mu.Unlock()
	m.o.Publish(EventChanged, map[string]any{"state": state, "online": m.devices.Online(OnlineWindow), "pending": m.devices.Pending()})
}

// Perms is the set of permissions beyond reading.
type Perms map[Class]bool

// DefaultPerms is send, answer and stop.
func DefaultPerms() Perms { return Perms{ClassSend: true, ClassAnswer: true, ClassStop: true} }

// ParsePerms reads HARNESS_REMOTE_ALLOW: a comma list of send, answer, stop ("" = the default; "none" = read only).
func ParsePerms(s string) (Perms, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return DefaultPerms(), nil
	}
	p := Perms{}
	if s == "none" {
		return p, nil
	}
	for _, f := range strings.Split(s, ",") {
		switch c := Class(strings.TrimSpace(f)); c {
		case ClassSend, ClassAnswer, ClassStop:
			p[c] = true
		default:
			return nil, errors.New("HARNESS_REMOTE_ALLOW: unknown permission " + strconv.Quote(string(c)) + " (use send, answer, stop or none)")
		}
	}
	return p, nil
}

// List is the permissions in a fixed order.
func (p Perms) List() []string {
	out := []string{"read"}
	for _, c := range []Class{ClassSend, ClassAnswer, ClassStop} {
		if p[c] {
			out = append(out, string(c))
		}
	}
	return out
}
