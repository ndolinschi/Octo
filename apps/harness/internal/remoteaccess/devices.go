package remoteaccess

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// Device statuses.
const (
	StatusPending = "pending"
	StatusActive  = "active"
)

// TokenPrefix starts every device token, so one is recognisable in a leak scan.
const TokenPrefix = "octo_dev_"

// Device is one paired phone or browser. Only the SHA-256 of its token is kept.
type Device struct {
	ID       string     `json:"id"`
	Name     string     `json:"name"`
	Hash     string     `json:"token_sha256"`
	Status   string     `json:"status"`
	ReadOnly bool       `json:"read_only"`
	PairedAt time.Time  `json:"paired_at"`
	LastSeen *time.Time `json:"last_seen,omitempty"`
}

type storeFile struct {
	Version      int      `json:"version"`
	Acknowledged bool     `json:"acknowledged"`
	Devices      []Device `json:"devices"`
}

// Store is the harness's own record of paired devices: {data-dir}/remote/devices.json (folder 0700, file 0600),
// written whole and atomically. Shared with nothing else.
type Store struct {
	mu       sync.Mutex
	path     string
	f        storeFile
	seen     map[string]time.Time // exact last request, in memory
	saved    map[string]time.Time // last_seen as last written
	idle     time.Duration
	pendTTL  time.Duration
	now      func() time.Time
	saveErrs int
}

// StorePath is the devices file under a data directory.
func StorePath(dataDir string) string { return filepath.Join(dataDir, "remote", "devices.json") }

// OpenStore reads the devices file (a missing file is an empty store).
func OpenStore(dataDir string, idle, pendingTTL time.Duration, now func() time.Time) (*Store, error) {
	s := &Store{path: StorePath(dataDir), idle: idle, pendTTL: pendingTTL, now: now, seen: map[string]time.Time{}, saved: map[string]time.Time{}}
	b, err := os.ReadFile(s.path)
	switch {
	case errors.Is(err, os.ErrNotExist):
		s.f.Version = 1
	case err != nil:
		return nil, err
	default:
		if err := json.Unmarshal(b, &s.f); err != nil {
			return nil, fmt.Errorf("%s: %w", s.path, err)
		}
	}
	// A pending device never outlives a restart: nobody can still be looking at its prompt.
	kept := s.f.Devices[:0]
	for _, d := range s.f.Devices {
		if d.Status == StatusActive {
			kept = append(kept, d)
		}
	}
	s.f.Devices = kept
	return s, nil
}

func (s *Store) saveLocked() error {
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return err
	}
	_ = os.Chmod(filepath.Dir(s.path), 0o700)
	b, err := json.MarshalIndent(s.f, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(s.path), ".devices-*.json")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer func() { _ = os.Remove(name) }()
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return err
	}
	if _, err := tmp.Write(b); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(name, s.path)
}

// Acknowledged reports whether the owner confirmed the first-time warning.
func (s *Store) Acknowledged() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.f.Acknowledged
}

// Acknowledge records the confirmation.
func (s *Store) Acknowledge() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.f.Acknowledged {
		return nil
	}
	s.f.Acknowledged = true
	return s.saveLocked()
}

// NewToken returns a device token (256 random bits) and its stored hash.
func NewToken() (token, hash string, err error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", "", err
	}
	token = TokenPrefix + base64.RawURLEncoding.EncodeToString(b)
	return token, hashToken(token), nil
}

func hashToken(t string) string {
	sum := sha256.Sum256([]byte(t))
	return hex.EncodeToString(sum[:])
}

func newID() string {
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	return "dev_" + hex.EncodeToString(b)
}

// Add records a new pending device and returns it with its token (the only time the token exists in clear).
func (s *Store) Add(name string) (Device, string, error) {
	token, hash, err := NewToken()
	if err != nil {
		return Device{}, "", err
	}
	d := Device{ID: newID(), Name: cleanName(name), Hash: hash, Status: StatusPending, PairedAt: s.now().UTC()}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.f.Devices = append(s.f.Devices, d)
	// Pending devices are not written: a restart drops them anyway.
	return d, token, nil
}

func cleanName(n string) string {
	n = strings.Join(strings.Fields(n), " ")
	if r := []rune(n); len(r) > 60 {
		n = string(r[:60])
	}
	if n == "" {
		n = "Device"
	}
	return n
}

// Lookup errors: the device_* codes of the catalogue.
const (
	codeNotPaired = "device_not_paired"
	codeExpired   = "device_expired"
)

// Authenticate finds the device a token belongs to. It removes devices that expired (no use for the idle period)
// and pending devices that waited too long. code is "" on success.
func (s *Store) Authenticate(token string) (Device, string) {
	if !strings.HasPrefix(token, TokenPrefix) {
		return Device{}, codeNotPaired
	}
	h := hashToken(token)
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sweepLocked()
	for i, d := range s.f.Devices {
		if subtle.ConstantTimeCompare([]byte(d.Hash), []byte(h)) != 1 {
			continue
		}
		if s.expiredLocked(d) {
			s.removeLocked(i)
			_ = s.saveLocked()
			return Device{}, codeExpired
		}
		return d, ""
	}
	return Device{}, codeNotPaired
}

func (s *Store) lastUse(d Device) time.Time {
	if t, ok := s.seen[d.ID]; ok {
		return t
	}
	if d.LastSeen != nil {
		return *d.LastSeen
	}
	return d.PairedAt
}

func (s *Store) expiredLocked(d Device) bool {
	return d.Status == StatusActive && s.idle > 0 && s.now().Sub(s.lastUse(d)) > s.idle
}

// sweepLocked drops pending devices older than the pending TTL. Expired active devices are dropped by Sweep.
func (s *Store) sweepLocked() {
	now := s.now()
	kept := s.f.Devices[:0]
	for _, d := range s.f.Devices {
		if d.Status == StatusPending && now.Sub(d.PairedAt) > s.pendTTL {
			continue
		}
		kept = append(kept, d)
	}
	s.f.Devices = kept
}

// Sweep removes pending devices that waited too long and active ones unused for the idle period.
func (s *Store) Sweep() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sweepLocked()
	changed := false
	kept := s.f.Devices[:0]
	for _, d := range s.f.Devices {
		if s.expiredLocked(d) {
			changed = true
			continue
		}
		kept = append(kept, d)
	}
	s.f.Devices = kept
	if changed {
		_ = s.saveLocked()
	}
}

func (s *Store) removeLocked(i int) {
	delete(s.seen, s.f.Devices[i].ID)
	delete(s.saved, s.f.Devices[i].ID)
	s.f.Devices = append(s.f.Devices[:i], s.f.Devices[i+1:]...)
}

// Touch notes a request by the device; last_seen is written at most once a minute.
func (s *Store) Touch(id string) {
	now := s.now().UTC()
	s.mu.Lock()
	defer s.mu.Unlock()
	s.seen[id] = now
	if now.Sub(s.saved[id]) < time.Minute {
		return
	}
	for i := range s.f.Devices {
		if s.f.Devices[i].ID == id && s.f.Devices[i].Status == StatusActive {
			t := now
			s.f.Devices[i].LastSeen = &t
			s.saved[id] = now
			if err := s.saveLocked(); err != nil {
				s.saveErrs++
			}
		}
	}
}

// Online is how many devices made a request within the window.
func (s *Store) Online(window time.Duration) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := 0
	for _, t := range s.seen {
		if s.now().Sub(t) <= window {
			n++
		}
	}
	return n
}

// DeviceView is a device as the computer's Settings shows it.
type DeviceView struct {
	ID       string     `json:"id"`
	Name     string     `json:"name"`
	Status   string     `json:"status"`
	ReadOnly bool       `json:"read_only"`
	PairedAt time.Time  `json:"paired_at"`
	LastSeen *time.Time `json:"last_seen,omitempty"`
	Online   bool       `json:"online"`
}

// List returns the devices, pending first, then by pairing time.
func (s *Store) List(window time.Duration) []DeviceView {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sweepLocked()
	out := make([]DeviceView, 0, len(s.f.Devices))
	for _, d := range s.f.Devices {
		v := DeviceView{ID: d.ID, Name: d.Name, Status: d.Status, ReadOnly: d.ReadOnly, PairedAt: d.PairedAt, LastSeen: d.LastSeen}
		if t, ok := s.seen[d.ID]; ok {
			tt := t
			v.LastSeen = &tt
			v.Online = s.now().Sub(t) <= window
		}
		out = append(out, v)
	}
	sort.SliceStable(out, func(i, j int) bool {
		if (out[i].Status == StatusPending) != (out[j].Status == StatusPending) {
			return out[i].Status == StatusPending
		}
		return out[i].PairedAt.Before(out[j].PairedAt)
	})
	return out
}

// ErrNoDevice is returned for an unknown device id.
var ErrNoDevice = errors.New("no such device")

func (s *Store) update(id string, f func(*Device)) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.f.Devices {
		if s.f.Devices[i].ID == id {
			f(&s.f.Devices[i])
			return s.saveLocked()
		}
	}
	return ErrNoDevice
}

// Confirm makes a pending device active.
func (s *Store) Confirm(id string) error {
	return s.update(id, func(d *Device) { d.Status = StatusActive })
}

// SetReadOnly switches a device's read-only mode.
func (s *Store) SetReadOnly(id string, ro bool) error {
	return s.update(id, func(d *Device) { d.ReadOnly = ro })
}

// Revoke removes a device (pending or active).
func (s *Store) Revoke(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.f.Devices {
		if s.f.Devices[i].ID == id {
			s.removeLocked(i)
			return s.saveLocked()
		}
	}
	return ErrNoDevice
}

// RevokeAll removes every device and returns their ids.
func (s *Store) RevokeAll() ([]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ids := make([]string, 0, len(s.f.Devices))
	for _, d := range s.f.Devices {
		ids = append(ids, d.ID)
	}
	s.f.Devices = nil
	s.seen = map[string]time.Time{}
	s.saved = map[string]time.Time{}
	return ids, s.saveLocked()
}

// DropPending removes every pending device (remote access turned off).
func (s *Store) DropPending() {
	s.mu.Lock()
	defer s.mu.Unlock()
	kept := s.f.Devices[:0]
	for _, d := range s.f.Devices {
		if d.Status != StatusPending {
			kept = append(kept, d)
		}
	}
	s.f.Devices = kept
}

// Pending is how many devices wait for the owner's answer.
func (s *Store) Pending() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sweepLocked()
	n := 0
	for _, d := range s.f.Devices {
		if d.Status == StatusPending {
			n++
		}
	}
	return n
}
