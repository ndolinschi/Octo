package remoteaccess

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseQuickURL(t *testing.T) {
	cases := map[string]string{
		"2024-05-01T10:00:01Z INF |  https://seasonal-deck-organisms-sf.trycloudflare.com                    |": "https://seasonal-deck-organisms-sf.trycloudflare.com",
		"https://abc-def.trycloudflare.com":                                                         "https://abc-def.trycloudflare.com",
		"Visit it at https://ABC.trycloudflare.com/ now":                                            "https://abc.trycloudflare.com",
		"INF Requesting new quick Tunnel on trycloudflare.com...":                                   "",
		`ERR failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": dial tcp`: "",
		"INF see https://developers.cloudflare.com/cloudflare-one/connections/connect-apps":         "",
		"INF Registered tunnel connection connIndex=0":                                              "",
		"http://plain.trycloudflare.com":                                                            "",
		"https://evil.trycloudflare.com.attacker.example":                                           "",
		"https://-bad.trycloudflare.com":                                                            "",
	}
	for line, want := range cases {
		if got := ParseQuickURL(line); got != want {
			t.Errorf("ParseQuickURL(%q) = %q, want %q", line, got, want)
		}
	}
}

func TestInstallLines(t *testing.T) {
	if InstallLine("darwin", "arm64") != "brew install cloudflared" {
		t.Fatal("darwin")
	}
	if !strings.Contains(InstallLine("windows", "amd64"), "winget") {
		t.Fatal("windows")
	}
	if l := InstallLine("linux", "arm64"); !strings.Contains(l, "cloudflared-linux-arm64") {
		t.Fatal(l)
	}
	if l := InstallLine("linux", "riscv64"); !strings.Contains(l, "cloudflared-linux-amd64") {
		t.Fatal(l)
	}
}

// fakeCloudflared copies testdata/fake-cloudflared into a fresh directory (its .mode, .log and .pids files are
// per test) and returns its path.
func fakeCloudflared(t *testing.T, mode string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", "fake-cloudflared"))
	if err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(t.TempDir(), "cloudflared")
	if err := os.WriteFile(p, b, 0o755); err != nil {
		t.Fatal(err)
	}
	if mode != "" {
		setMode(t, p, mode)
	}
	return p
}

func setMode(t *testing.T, bin, mode string) {
	t.Helper()
	if err := os.WriteFile(bin+".mode", []byte(mode), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestFindCloudflared(t *testing.T) {
	bin := fakeCloudflared(t, "")
	c := FindCloudflared(context.Background(), bin)
	if !c.Found || c.Path != bin || c.Version != "2025.1.0" {
		t.Fatalf("configured path: %+v", c)
	}
	t.Setenv("PATH", filepath.Dir(bin))
	if c := FindCloudflared(context.Background(), ""); !c.Found || c.Path != bin {
		t.Fatalf("on PATH: %+v", c)
	}
	t.Setenv("PATH", t.TempDir())
	if c := FindCloudflared(context.Background(), ""); c.Found || c.Install == "" {
		t.Fatalf("missing: %+v", c)
	}
	if c := FindCloudflared(context.Background(), filepath.Join(t.TempDir(), "nope")); c.Found {
		t.Fatalf("a configured path that does not exist: %+v", c)
	}
}
