package browserproxy

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ErrorKind classifies user-facing proxy validation errors.
type ErrorKind int

const (
	KindInvalid ErrorKind = iota + 1
	KindForbidden
)

// Error is returned when a requested target URL cannot be proxied.
type Error struct {
	Kind    ErrorKind
	Code    string
	Message string
}

func (e *Error) Error() string { return e.Message }

// Session describes an active loopback proxy frame for one project and origin.
type Session struct {
	FrameURL    string `json:"frame_url"`
	ProxyOrigin string `json:"proxy_origin"`
	TargetURL   string `json:"target_url"`
	Nonce       string `json:"nonce"`
}

// Options configures a Manager.
type Options struct {
	IdleTimeout          time.Duration
	BlockedLoopbackPorts []int
	Transport            http.RoundTripper
}

type proxyKey struct {
	projectID string
	origin    string
}

// Manager owns ephemeral 127.0.0.1 listeners for Browser tabs.
type Manager struct {
	mu           sync.Mutex
	closed       bool
	idleTimeout  time.Duration
	blockedPorts map[int]struct{}
	transport    http.RoundTripper
	instances    map[proxyKey]*instance
}

// NewManager constructs a proxy manager with dial-time SSRF and port guards.
func NewManager(opts Options) *Manager {
	idle := opts.IdleTimeout
	if idle <= 0 {
		idle = 30 * time.Minute
	}
	blocked := make(map[int]struct{}, len(opts.BlockedLoopbackPorts))
	for _, p := range opts.BlockedLoopbackPorts {
		if p > 0 {
			blocked[p] = struct{}{}
		}
	}
	m := &Manager{
		idleTimeout:  idle,
		blockedPorts: blocked,
		instances:    make(map[proxyKey]*instance),
	}
	if opts.Transport != nil {
		m.transport = opts.Transport
	} else {
		m.transport = newGuardedTransport(m.isPortBlocked)
	}
	return m
}

// AddBlockedPort forbids proxying to a loopback port discovered after construction.
func (m *Manager) AddBlockedPort(port int) {
	if port <= 0 {
		return
	}
	m.mu.Lock()
	m.blockedPorts[port] = struct{}{}
	m.mu.Unlock()
}

// Open starts or reuses the loopback proxy for rawURL's origin and returns a one-time bootstrap URL.
func (m *Manager) Open(ctx context.Context, projectID, rawURL string) (Session, error) {
	if err := ctx.Err(); err != nil {
		return Session{}, err
	}
	if strings.TrimSpace(projectID) == "" {
		return Session{}, &Error{Kind: KindInvalid, Code: "invalid_project", Message: "project id is required"}
	}
	u, err := parseTargetURL(rawURL, m.isPortBlocked)
	if err != nil {
		return Session{}, err
	}
	origin := u.Scheme + "://" + u.Host
	key := proxyKey{projectID: projectID, origin: origin}

	m.SweepIdle(time.Now())

	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return Session{}, errors.New("browser proxy manager is shut down")
	}
	inst, ok := m.instances[key]
	if !ok {
		created, createErr := newInstance(u, m.transport)
		if createErr != nil {
			m.mu.Unlock()
			return Session{}, createErr
		}
		inst = created
		m.instances[key] = inst
	}
	m.mu.Unlock()

	relPath := u.EscapedPath()
	if relPath == "" {
		relPath = "/"
	}
	if u.RawQuery != "" {
		relPath += "?" + u.RawQuery
	}
	if u.Fragment != "" {
		relPath += "#" + u.Fragment
	}
	ticket, err := inst.mintTicket(relPath)
	if err != nil {
		return Session{}, err
	}
	return Session{
		FrameURL:    inst.proxyOrigin + "/__octo_browser/bootstrap?ticket=" + url.QueryEscape(ticket),
		ProxyOrigin: inst.proxyOrigin,
		TargetURL:   u.String(),
		Nonce:       inst.nonce,
	}, nil
}

// CloseProject stops all proxy listeners belonging to projectID.
func (m *Manager) CloseProject(ctx context.Context, projectID string) error {
	m.mu.Lock()
	var toClose []*instance
	for k, inst := range m.instances {
		if k.projectID == projectID {
			delete(m.instances, k)
			toClose = append(toClose, inst)
		}
	}
	m.mu.Unlock()
	var firstErr error
	for _, inst := range toClose {
		if err := inst.shutdown(ctx); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

// SweepIdle closes listeners that have not served a request within IdleTimeout.
func (m *Manager) SweepIdle(now time.Time) {
	cutoff := now.Add(-m.idleTimeout).UnixNano()
	m.mu.Lock()
	var stale []*instance
	for k, inst := range m.instances {
		if inst.lastUsed.Load() < cutoff {
			delete(m.instances, k)
			stale = append(stale, inst)
		}
	}
	m.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	for _, inst := range stale {
		if err := inst.shutdown(ctx); err != nil {
			// Best-effort idle sweep; listener is already closed on shutdown timeout.
			_ = inst.ln.Close()
		}
	}
}

// Shutdown stops every active loopback listener.
func (m *Manager) Shutdown(ctx context.Context) error {
	m.mu.Lock()
	m.closed = true
	all := make([]*instance, 0, len(m.instances))
	for k, inst := range m.instances {
		delete(m.instances, k)
		all = append(all, inst)
	}
	m.mu.Unlock()
	var firstErr error
	for _, inst := range all {
		if err := inst.shutdown(ctx); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

func (m *Manager) isPortBlocked(port int) bool {
	m.mu.Lock()
	_, blocked := m.blockedPorts[port]
	m.mu.Unlock()
	return blocked
}

func parseTargetURL(raw string, portBlocked func(int) bool) (*url.URL, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil, &Error{Kind: KindInvalid, Code: "invalid_url", Message: "enter an http:// or https:// URL"}
	}
	u, err := url.Parse(trimmed)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return nil, &Error{Kind: KindInvalid, Code: "invalid_url", Message: "only http:// and https:// URLs are supported"}
	}
	host := u.Hostname()
	if ip := net.ParseIP(host); ip != nil && isBlockedIP(ip) {
		return nil, &Error{Kind: KindForbidden, Code: "forbidden_target", Message: "link-local and unspecified addresses cannot be opened"}
	}
	if isLoopbackHost(host) {
		port := effectivePort(u)
		if portBlocked(port) {
			return nil, &Error{Kind: KindForbidden, Code: "forbidden_target", Message: "cannot proxy Octo's internal service port"}
		}
	}
	return u, nil
}

func effectivePort(u *url.URL) int {
	if p := u.Port(); p != "" {
		n, err := strconv.Atoi(p)
		if err == nil {
			return n
		}
	}
	if u.Scheme == "https" {
		return 443
	}
	return 80
}

func isLoopbackHost(host string) bool {
	h := strings.ToLower(host)
	if h == "localhost" || strings.HasSuffix(h, ".localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func isBlockedIP(ip net.IP) bool {
	return ip.IsUnspecified() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsMulticast()
}

func newGuardedTransport(portBlocked func(int) bool) http.RoundTripper {
	dialer := &net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}
	return &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		MaxIdleConns:          64,
		IdleConnTimeout:       60 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			host, portStr, err := net.SplitHostPort(addr)
			if err != nil {
				return nil, err
			}
			port, err := strconv.Atoi(portStr)
			if err != nil {
				return nil, fmt.Errorf("invalid port %q: %w", portStr, err)
			}
			ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
			if err != nil {
				return nil, err
			}
			for _, ipa := range ips {
				if isBlockedIP(ipa.IP) {
					return nil, fmt.Errorf("blocked address %s", ipa.IP.String())
				}
				if ipa.IP.IsLoopback() && portBlocked(port) {
					return nil, fmt.Errorf("blocked internal port %d", port)
				}
			}
			if len(ips) == 0 {
				return nil, fmt.Errorf("no address for %s", host)
			}
			var lastErr error
			for _, ipa := range ips {
				conn, dialErr := dialer.DialContext(ctx, network, net.JoinHostPort(ipa.IP.String(), portStr))
				if dialErr == nil {
					return conn, nil
				}
				lastErr = dialErr
				if ctx.Err() != nil {
					break
				}
			}
			return nil, lastErr
		},
	}
}

func randomHex(nBytes int) (string, error) {
	buf := make([]byte, nBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("random token: %w", err)
	}
	return hex.EncodeToString(buf), nil
}
