package config_test

import (
	"bytes"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/config"
)

func writeEnvFile(t *testing.T, content string, mode os.FileMode) string {
	t.Helper()
	dir := t.TempDir()
	p := filepath.Join(dir, config.EnvFileName)
	if err := os.WriteFile(p, []byte(content), mode); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(p, mode); err != nil {
		t.Fatal(err)
	}
	return dir
}

// captureLogs routes slog to a buffer for the test.
func captureLogs(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	old := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(old) })
	return &buf
}

func unsetForTest(t *testing.T, keys ...string) {
	t.Helper()
	for _, k := range keys {
		t.Setenv(k, "")
		_ = os.Unsetenv(k)
	}
}

func TestEnvFileFillsOnlyUnsetVariables(t *testing.T) {
	unsetForTest(t, "OCTO_T_NEW", "OCTO_T_QUOTED", "OCTO_T_SQ", "OCTO_T_EXPORT", "OCTO_T_EQ")
	t.Setenv("OCTO_T_TAKEN", "from-process")
	t.Setenv("OCTO_T_EMPTY", "")
	dir := writeEnvFile(t, `# a comment
OCTO_T_NEW=value
OCTO_T_QUOTED="with spaces # kept"
OCTO_T_SQ='single'
export OCTO_T_EXPORT=exported

  OCTO_T_EQ = a=b=c
OCTO_T_TAKEN=from-file
OCTO_T_EMPTY=from-file
`, 0o600)
	got := config.LoadEnvFile(dir)
	want := map[string]string{
		"OCTO_T_NEW": "value", "OCTO_T_QUOTED": "with spaces # kept", "OCTO_T_SQ": "single",
		"OCTO_T_EXPORT": "exported", "OCTO_T_EQ": "a=b=c",
		"OCTO_T_TAKEN": "from-process", "OCTO_T_EMPTY": "",
	}
	for k, v := range want {
		if os.Getenv(k) != v {
			t.Errorf("%s = %q, want %q", k, os.Getenv(k), v)
		}
	}
	if len(got) != 5 {
		t.Errorf("set %v, want the five new variables", got)
	}
}

func TestEnvFileGroupOrWorldReadableIsRefused(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("permission bits are checked on Unix only")
	}
	for _, mode := range []os.FileMode{0o640, 0o604, 0o644, 0o660} {
		unsetForTest(t, "OCTO_T_REFUSED")
		logs := captureLogs(t)
		dir := writeEnvFile(t, "OCTO_T_REFUSED=secret-value-123\n", mode)
		if got := config.LoadEnvFile(dir); len(got) != 0 || os.Getenv("OCTO_T_REFUSED") != "" {
			t.Errorf("mode %v: file was used (%v)", mode, got)
		}
		out := logs.String()
		if !strings.Contains(out, "chmod 600") || !strings.Contains(out, filepath.Join(dir, config.EnvFileName)) {
			t.Errorf("mode %v: the warning must name the fix: %s", mode, out)
		}
		if strings.Contains(out, "secret-value-123") {
			t.Errorf("mode %v: a value was logged: %s", mode, out)
		}
	}
	// 0400 is fine.
	unsetForTest(t, "OCTO_T_RO")
	if got := config.LoadEnvFile(writeEnvFile(t, "OCTO_T_RO=1\n", 0o400)); len(got) != 1 {
		t.Errorf("0400 must be accepted, set %v", got)
	}
}

func TestEnvFileMalformedLineWarnsWithNumberNotContent(t *testing.T) {
	unsetForTest(t, "OCTO_T_GOOD1", "OCTO_T_GOOD2")
	logs := captureLogs(t)
	dir := writeEnvFile(t, "OCTO_T_GOOD1=1\nthis-has-no-equals-secret-token\n9BAD=x\nOCTO_T_Q=\"unterminated-secret\nOCTO_T_GOOD2=2\n", 0o600)
	got := config.LoadEnvFile(dir)
	if len(got) != 2 || os.Getenv("OCTO_T_GOOD1") != "1" || os.Getenv("OCTO_T_GOOD2") != "2" {
		t.Fatalf("set %v", got)
	}
	out := logs.String()
	for _, n := range []string{"line=2", "line=3", "line=4"} {
		if !strings.Contains(out, n) {
			t.Errorf("missing warning %s in %s", n, out)
		}
	}
	if strings.Contains(out, "secret") || strings.Contains(out, "9BAD") {
		t.Errorf("a malformed line's content was logged: %s", out)
	}
}

func TestEnvFileNeverLogsValues(t *testing.T) {
	unsetForTest(t, "OCTO_T_KEYISH")
	logs := captureLogs(t)
	config.LoadEnvFile(writeEnvFile(t, "OCTO_T_KEYISH=sk-ant-very-secret\n", 0o600))
	out := logs.String()
	if strings.Contains(out, "very-secret") {
		t.Fatalf("value logged: %s", out)
	}
	if !strings.Contains(out, "OCTO_T_KEYISH") {
		t.Fatalf("the variable name should be logged: %s", out)
	}
}

func TestEnvFileAbsentOrNotAFile(t *testing.T) {
	logs := captureLogs(t)
	if got := config.LoadEnvFile(t.TempDir()); got != nil {
		t.Fatalf("absent file set %v", got)
	}
	if logs.Len() != 0 {
		t.Fatalf("an absent file is silent, got %s", logs.String())
	}
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, config.EnvFileName), 0o700); err != nil {
		t.Fatal(err)
	}
	if got := config.LoadEnvFile(dir); got != nil || !strings.Contains(logs.String(), "not a regular file") {
		t.Fatalf("directory: %v %s", got, logs.String())
	}
}

// The settings file feeds Load: the model, key and child allow-list variables
// it sets are what the config sees; the process environment still wins.
func TestEnvFileFeedsLoad(t *testing.T) {
	unsetForTest(t, "ANTHROPIC_API_KEY", "HARNESS_MODEL_FAST")
	t.Setenv("HARNESS_MODEL_DEEP", "from-process")
	dir := writeEnvFile(t, "ANTHROPIC_API_KEY=sk-file\nHARNESS_MODEL_FAST=fast-file\nHARNESS_MODEL_DEEP=deep-file\n", 0o600)
	config.LoadEnvFile(dir)
	cfg, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.APIKey != "sk-file" || cfg.Models.Fast != "fast-file" || cfg.Models.Deep != "from-process" {
		t.Fatalf("cfg = key %q fast %q deep %q", cfg.APIKey, cfg.Models.Fast, cfg.Models.Deep)
	}
}
