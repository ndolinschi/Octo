package remoteaccess

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestTokenIs256BitsAndOnlyItsHashIsStored(t *testing.T) {
	dir := t.TempDir()
	clk := newClock()
	s, err := OpenStore(dir, 30*24*time.Hour, 5*time.Minute, clk.now)
	if err != nil {
		t.Fatal(err)
	}
	d, token, err := s.Add("  iPhone   15  ")
	if err != nil {
		t.Fatal(err)
	}
	if d.Name != "iPhone 15" || d.Status != StatusPending {
		t.Fatalf("device %+v", d)
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(token, TokenPrefix))
	if !strings.HasPrefix(token, TokenPrefix) || err != nil || len(raw) != 32 {
		t.Fatalf("token %q is not %s + 32 bytes", token, TokenPrefix)
	}
	if err := s.Confirm(d.ID); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(StorePath(dir))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), token) || strings.Contains(string(b), strings.TrimPrefix(token, TokenPrefix)) {
		t.Fatal("the token itself was written")
	}
	if !strings.Contains(string(b), hashToken(token)) {
		t.Fatal("the hash was not written")
	}
	if runtime.GOOS != "windows" {
		fi, _ := os.Stat(StorePath(dir))
		di, _ := os.Stat(filepath.Dir(StorePath(dir)))
		if fi.Mode().Perm() != 0o600 || di.Mode().Perm() != 0o700 {
			t.Fatalf("modes file %v dir %v", fi.Mode().Perm(), di.Mode().Perm())
		}
	}
	// A reopened store knows the device by its token.
	s2, err := OpenStore(dir, 30*24*time.Hour, 5*time.Minute, clk.now)
	if err != nil {
		t.Fatal(err)
	}
	if got, code := s2.Authenticate(token); code != "" || got.ID != d.ID || got.Status != StatusActive {
		t.Fatalf("reopened: %+v %q", got, code)
	}
	if _, code := s2.Authenticate("octo_dev_nope"); code != "device_not_paired" {
		t.Fatalf("unknown token: %q", code)
	}
	if _, code := s2.Authenticate("some-local-api-token"); code != "device_not_paired" {
		t.Fatalf("local token: %q", code)
	}
}

func TestPendingDevicesExpireAndDoNotSurviveARestart(t *testing.T) {
	dir := t.TempDir()
	clk := newClock()
	s, _ := OpenStore(dir, 30*24*time.Hour, 5*time.Minute, clk.now)
	_, tok, _ := s.Add("phone")
	if s.Pending() != 1 {
		t.Fatal("pending")
	}
	clk.add(5*time.Minute + time.Second)
	if _, code := s.Authenticate(tok); code != "device_not_paired" {
		t.Fatalf("a pending device past its time: %q", code)
	}
	if s.Pending() != 0 {
		t.Fatal("still pending")
	}
	// A pending device that was written by another save is dropped on open.
	d, _, _ := s.Add("other")
	_ = s.Acknowledge()
	_ = s.SetReadOnly(d.ID, false) // writes the file with the pending device in it
	s2, _ := OpenStore(dir, 30*24*time.Hour, 5*time.Minute, clk.now)
	if len(s2.List(time.Minute)) != 0 {
		t.Fatal("a pending device survived a restart")
	}
}

func TestIdleDevicesExpire(t *testing.T) {
	dir := t.TempDir()
	clk := newClock()
	s, _ := OpenStore(dir, 30*24*time.Hour, 5*time.Minute, clk.now)
	d, tok, _ := s.Add("phone")
	_ = s.Confirm(d.ID)
	clk.add(29 * 24 * time.Hour)
	if _, code := s.Authenticate(tok); code != "" {
		t.Fatalf("29 days: %q", code)
	}
	s.Touch(d.ID)
	clk.add(29 * 24 * time.Hour)
	if _, code := s.Authenticate(tok); code != "" {
		t.Fatalf("29 days after the last use: %q", code)
	}
	clk.add(2 * 24 * time.Hour)
	if _, code := s.Authenticate(tok); code != "device_expired" {
		t.Fatalf("31 days after the last use: %q", code)
	}
	if len(s.List(time.Minute)) != 0 {
		t.Fatal("expired device still listed")
	}
}

func TestRevokeAndRevokeAll(t *testing.T) {
	s, _ := OpenStore(t.TempDir(), time.Hour, time.Minute, newClock().now)
	a, ta, _ := s.Add("a")
	b, _, _ := s.Add("b")
	_ = s.Confirm(a.ID)
	_ = s.Confirm(b.ID)
	if err := s.Revoke(a.ID); err != nil {
		t.Fatal(err)
	}
	if _, code := s.Authenticate(ta); code != "device_not_paired" {
		t.Fatalf("revoked: %q", code)
	}
	if err := s.Revoke("dev_nope"); err != ErrNoDevice {
		t.Fatalf("unknown: %v", err)
	}
	ids, err := s.RevokeAll()
	if err != nil || len(ids) != 1 || len(s.List(time.Minute)) != 0 {
		t.Fatalf("revoke all: %v %v", ids, err)
	}
}
