package apitoken_test

import (
	"bytes"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/apitoken"
)

func TestResolveGeneratesAndWritesA0600File(t *testing.T) {
	var logs bytes.Buffer
	old := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug})))
	defer slog.SetDefault(old)

	dir := filepath.Join(t.TempDir(), "data")
	tok, generated, err := apitoken.Resolve(dir, "")
	if err != nil || !generated {
		t.Fatalf("Resolve = %q %v %v", tok, generated, err)
	}
	if len(tok) != 64 {
		t.Fatalf("token length %d, want 64 hex characters", len(tok))
	}
	raw, err := os.ReadFile(apitoken.Path(dir))
	if err != nil || strings.TrimSpace(string(raw)) != tok {
		t.Fatalf("file = %q %v", raw, err)
	}
	if runtime.GOOS != "windows" {
		fi, _ := os.Stat(apitoken.Path(dir))
		if fi.Mode().Perm() != 0o600 {
			t.Fatalf("mode = %v, want 0600", fi.Mode().Perm())
		}
	}
	if strings.Contains(logs.String(), tok) {
		t.Fatalf("the token was logged: %s", logs.String())
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Fatalf("data dir holds %d entries, want only api-token (temp file left behind?)", len(entries))
	}
	// A second start replaces it.
	tok2, _, err := apitoken.Resolve(dir, "")
	if err != nil || tok2 == tok {
		t.Fatalf("second token = %q (same as first: %v) %v", tok2, tok2 == tok, err)
	}
	raw, _ = os.ReadFile(apitoken.Path(dir))
	if strings.TrimSpace(string(raw)) != tok2 {
		t.Fatalf("file was not replaced")
	}
}

func TestResolveUsesTheConfiguredTokenAndWritesNothing(t *testing.T) {
	dir := t.TempDir()
	tok, generated, err := apitoken.Resolve(dir, "0123456789abcdef-configured")
	if err != nil || generated || tok != "0123456789abcdef-configured" {
		t.Fatalf("Resolve = %q %v %v", tok, generated, err)
	}
	if _, err := os.Stat(apitoken.Path(dir)); !os.IsNotExist(err) {
		t.Fatalf("a configured token must not be written to disk (stat err = %v)", err)
	}
}

func TestResolveRejectsWeakOrUnprintableTokens(t *testing.T) {
	for _, bad := range []string{"short", "has space 0123456789", "tab\t0123456789abcdef", "nonascii-é-0123456789"} {
		if _, _, err := apitoken.Resolve(t.TempDir(), bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}

func TestMatcher(t *testing.T) {
	m, err := apitoken.NewMatcher("the-right-token-123")
	if err != nil {
		t.Fatal(err)
	}
	if !m.Match("the-right-token-123") || !m.Match(" the-right-token-123 ") {
		t.Fatal("the token does not match")
	}
	for _, bad := range []string{"", "the-right-token-12", "the-right-token-1234", "THE-RIGHT-TOKEN-123"} {
		if m.Match(bad) {
			t.Errorf("%q matched", bad)
		}
	}
	if _, err := apitoken.NewMatcher(""); err == nil {
		t.Fatal("empty token accepted")
	}
}
