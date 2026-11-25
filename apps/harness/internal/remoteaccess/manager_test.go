package remoteaccess

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/usererr"
)

func TestOffByDefault(t *testing.T) {
	r := newRig(t, "", nil)
	st := r.m.Status()
	if st.State != StateOff || st.Listen != "" || st.URL != "" || st.Acknowledged {
		t.Fatalf("status %+v", st)
	}
	if _, err := os.Stat(r.bin + ".log"); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("cloudflared ran without being switched on")
	}
	if _, err := r.m.IssueCode(); usererr.As(err) == nil || usererr.As(err).Code != "remote_off" {
		t.Fatalf("code while off: %v", err)
	}
}

func TestEnableNeedsAcknowledgementOnce(t *testing.T) {
	dir := t.TempDir()
	r := newRig(t, "", func(o *Options) { o.DataDir = dir })
	if _, err := r.m.Enable(false); usererr.As(err) == nil || usererr.As(err).Code != "remote_ack_required" {
		t.Fatalf("first enable without ack: %v", err)
	}
	if r.m.Status().State != StateOff {
		t.Fatal("turned on without the acknowledgement")
	}
	r.on()
	r.m.Disable()
	r2 := newRig(t, "", func(o *Options) { o.DataDir = dir })
	if _, err := r2.m.Enable(false); err != nil {
		t.Fatalf("later enable: %v", err)
	}
}

func TestOnWithTheTunnelURL(t *testing.T) {
	r := newRig(t, "", nil)
	st := r.on()
	if st.URL != "https://fake-quick-tunnel-1.trycloudflare.com" {
		t.Fatalf("url %q", st.URL)
	}
	eventually(t, "connected", func() bool { return r.m.Status().Connected })
	log, _ := os.ReadFile(r.bin + ".log")
	want := "tunnel --no-autoupdate --url http://" + st.Listen
	if strings.TrimSpace(string(log)) != want {
		t.Fatalf("cloudflared args %q, want %q", log, want)
	}
	if st.Cloudflared.Version != "2025.1.0" {
		t.Fatalf("version %q", st.Cloudflared.Version)
	}
}

func TestMissingCloudflared(t *testing.T) {
	found := false
	r := newRig(t, "", func(o *Options) {
		o.Find = func(context.Context) Cloudflared {
			if found {
				return Cloudflared{Found: true, Path: o.Cloudflared, Install: "x"}
			}
			return Cloudflared{Install: "brew install cloudflared"}
		}
	})
	st, err := r.m.Enable(true)
	if err != nil {
		t.Fatal(err)
	}
	if st.State != StateError || st.Error == nil || st.Error.Code != "cloudflared_missing" || st.Error.Command != "brew install cloudflared" {
		t.Fatalf("status %+v", st)
	}
	if st.Listen != "" {
		t.Fatal("listener open without cloudflared")
	}
	found = true
	if st := r.m.Check(); st.State != StateOff || !st.Cloudflared.Found {
		t.Fatalf("after check %+v", st)
	}
	r.on()
}

func TestRestartAnnouncesNewURLAndWithdrawsTheCode(t *testing.T) {
	r := newRig(t, "urlthencrash", func(o *Options) { o.MaxFails = 100 })
	if _, err := r.m.Enable(true); err != nil {
		t.Fatal(err)
	}
	var issued string
	eventually(t, "a code on the first URL", func() bool {
		st, err := r.m.IssueCode()
		if err == nil && strings.HasSuffix(st.URL, "-1.trycloudflare.com") && st.Pairing != nil {
			issued = st.Pairing.Code
			return true
		}
		return false
	})
	eventually(t, "the second URL", func() bool { return strings.HasSuffix(r.m.Status().URL, "-2.trycloudflare.com") })
	if p := r.m.Status().Pairing; p != nil && p.Code == issued {
		t.Fatal("the code shown with the old URL survived the new URL")
	}
	sawStarting := false
	for len(r.pub) > 0 {
		if (<-r.pub)["state"] == StateStarting {
			sawStarting = true
		}
	}
	if !sawStarting {
		t.Fatal("no remote.changed event for the restart")
	}
}

func TestGivesUpAfterRepeatedFailures(t *testing.T) {
	r := newRig(t, "crash", func(o *Options) { o.MaxFails = 3 })
	if _, err := r.m.Enable(true); err != nil {
		t.Fatal(err)
	}
	eventually(t, "error state", func() bool { return r.m.Status().State == StateError })
	st := r.m.Status()
	if st.Error == nil || st.Error.Code != "tunnel_failed" || !strings.Contains(st.Error.Details, "failed to connect to the edge") {
		t.Fatalf("status %+v", st.Error)
	}
	log, _ := os.ReadFile(r.bin + ".log")
	if n := strings.Count(string(log), "\n"); n != 3 {
		t.Fatalf("%d starts, want 3", n)
	}
}

func TestNoURLTimesOutAndTheAPIHostIsNotTaken(t *testing.T) {
	r := newRig(t, "nourl", func(o *Options) {
		o.MaxFails = 2
		o.StartTimeout = 300 * time.Millisecond
	})
	if _, err := r.m.Enable(true); err != nil {
		t.Fatal(err)
	}
	eventually(t, "error state", func() bool { return r.m.Status().State == StateError })
	if u := r.m.Status().URL; u != "" {
		t.Fatalf("url %q taken from an error line", u)
	}
}

func TestDisableStopsTheProcessGroupAndListener(t *testing.T) {
	r := newRig(t, "", nil)
	st := r.on()
	pids := readPids(t, r.bin)
	r.m.Disable()
	// Disable has signalled the whole group; the helper is not our child, so its exit is not waited for: it is gone a
	// moment later (on a loaded CI runner the check ran before the kernel had delivered the signal).
	for _, p := range pids {
		p := p
		eventually(t, fmt.Sprintf("process %d gone after disable", p), func() bool { return !alive(p) })
	}
	if s := r.m.Status(); s.State != StateOff || s.Listen != "" {
		t.Fatalf("status %+v", s)
	}
	if err := dial(st.Listen); err == nil {
		t.Fatal("the listener still accepts connections")
	}
}

func TestIdleAutoOff(t *testing.T) {
	clk := newClock()
	r := newRig(t, "", func(o *Options) {
		o.Now = clk.now
		o.IdleOff = time.Hour
		o.Tick = 10 * time.Millisecond
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go r.m.Run(ctx)
	r.on()
	clk.add(59 * time.Minute)
	time.Sleep(50 * time.Millisecond)
	if r.m.Status().State != StateOn {
		t.Fatal("turned off before the idle period")
	}
	clk.add(2 * time.Minute)
	eventually(t, "auto-off", func() bool { return r.m.Status().State == StateOff })
}

func TestRevokeAllAndOff(t *testing.T) {
	r := newRig(t, "", nil)
	r.on()
	tok, _ := r.pair(true)
	if res := r.do("GET", "/v1/projects", tok, nil); res.status != 200 {
		t.Fatalf("before: %d", res.status)
	}
	st, err := r.m.RevokeAllAndOff()
	if err != nil || st.State != StateOff || len(st.Devices) != 0 {
		t.Fatalf("after: %+v %v", st, err)
	}
	if _, code := r.m.devices.Authenticate(tok); code != "device_not_paired" {
		t.Fatalf("token still known: %q", code)
	}
}

func TestParsePermsAndEnv(t *testing.T) {
	if p, err := ParsePerms("send, stop"); err != nil || !p[ClassSend] || p[ClassAnswer] || !p[ClassStop] {
		t.Fatalf("%v %v", p, err)
	}
	if p, _ := ParsePerms("none"); len(p) != 0 {
		t.Fatal("none")
	}
	if _, err := ParsePerms("send,root"); err == nil {
		t.Fatal("unknown permission accepted")
	}
	var o Options
	env := map[string]string{EnvIdleOff: "0", EnvDeviceIdle: "7", EnvAllow: "answer", EnvWebDir: "/x"}
	if err := OptionsFromEnv(&o, func(k string) string { return env[k] }); err != nil {
		t.Fatal(err)
	}
	if o.IdleOff >= 0 || o.DeviceIdle != 7*24*time.Hour || !o.Allow[ClassAnswer] || o.Allow[ClassSend] || o.WebDir != "/x" {
		t.Fatalf("%+v", o)
	}
	env[EnvIdleOff] = "-3"
	if err := OptionsFromEnv(&o, func(k string) string { return env[k] }); err == nil {
		t.Fatal("negative hours accepted")
	}
}

// OnListen names the tunnel listener's port each time it opens, so the Browser tab's proxy can refuse it (security
// review finding 10).
func TestOnListenNamesTheListenerPort(t *testing.T) {
	ports := make(chan int, 4)
	r := newRig(t, "", func(o *Options) { o.OnListen = func(p int) { ports <- p } })
	st := r.on()
	_, port, _ := net.SplitHostPort(st.Listen)
	select {
	case p := <-ports:
		if strconv.Itoa(p) != port {
			t.Fatalf("OnListen(%d), listener %s", p, st.Listen)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("OnListen was not called")
	}
}

// The tunnel listener serves the paired-device API without the desktop token: cloudflared reaches it on loopback, and
// nothing else may (security review finding 9). A non-loopback HARNESS_REMOTE_ADDR is refused with a clear error, in
// the settings and in New.
func TestRemoteAddrMustBeLoopback(t *testing.T) {
	for _, a := range []string{"", "127.0.0.1:0", "127.0.0.1:8799", "[::1]:0", "localhost:0", "127.1.2.3:9"} {
		o := Options{}
		if err := OptionsFromEnv(&o, func(k string) string { return map[string]string{EnvAddr: a}[k] }); err != nil {
			t.Errorf("%q refused: %v", a, err)
		}
	}
	for _, a := range []string{"0.0.0.0:8799", ":8799", "[::]:0", "192.168.1.5:8799", "10.0.0.1:0", "example.com:80", "127.0.0.1", "nonsense"} {
		o := Options{}
		err := OptionsFromEnv(&o, func(k string) string { return map[string]string{EnvAddr: a}[k] })
		if err == nil || !strings.Contains(err.Error(), EnvAddr) || !strings.Contains(err.Error(), "loopback") {
			t.Errorf("%q: err = %v", a, err)
		}
		if _, err := New(Options{Addr: a, DataDir: t.TempDir()}); err == nil {
			t.Errorf("New accepted %q", a)
		}
	}
}
