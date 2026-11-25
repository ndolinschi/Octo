package config

import (
	"bufio"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// EnvFileName is the settings file inside the data directory.
const EnvFileName = "harness.env"

// LoadEnvFile reads {dataDir}/harness.env, when it exists, into the process
// environment. Lines are KEY=VALUE (an optional "export " prefix and one pair
// of surrounding quotes are accepted); blank lines and lines starting with #
// are skipped. A variable that is already set in the process environment,
// even to an empty value, is left alone. On Unix the file must not be readable
// by group or others, else it is refused with a warning. A malformed line is
// skipped with a warning naming its number. Values are never logged.
// It returns the names it set.
func LoadEnvFile(dataDir string) []string {
	path := filepath.Join(dataDir, EnvFileName)
	fi, err := os.Stat(path)
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			slog.Warn("harness.env unreadable", "path", path, "err", err)
		}
		return nil
	}
	if !fi.Mode().IsRegular() {
		slog.Warn("harness.env ignored: not a regular file", "path", path)
		return nil
	}
	if runtime.GOOS != "windows" && fi.Mode().Perm()&0o077 != 0 {
		slog.Warn(fmt.Sprintf("harness.env ignored: it is readable by other users (mode %04o); run: chmod 600 %s", fi.Mode().Perm(), path))
		return nil
	}
	f, err := os.Open(path)
	if err != nil {
		slog.Warn("harness.env unreadable", "path", path, "err", err)
		return nil
	}
	defer f.Close()
	var set []string
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 1<<20)
	for n := 1; sc.Scan(); n++ {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, val, ok := parseEnvLine(line)
		if !ok {
			slog.Warn("harness.env: ignoring malformed line", "path", path, "line", n)
			continue
		}
		if _, exists := os.LookupEnv(key); exists {
			continue
		}
		if err := os.Setenv(key, val); err != nil {
			slog.Warn("harness.env: cannot set variable", "line", n, "err", err)
			continue
		}
		set = append(set, key)
	}
	if err := sc.Err(); err != nil {
		slog.Warn("harness.env: read stopped", "path", path, "err", err)
	}
	if len(set) > 0 {
		slog.Info("harness.env loaded", "path", path, "variables", set)
	}
	return set
}

func parseEnvLine(line string) (key, val string, ok bool) {
	line = strings.TrimSpace(strings.TrimPrefix(line, "export "))
	k, v, found := strings.Cut(line, "=")
	if !found {
		return "", "", false
	}
	key, val = strings.TrimSpace(k), strings.TrimSpace(v)
	if !validEnvKey(key) {
		return "", "", false
	}
	if len(val) >= 2 && (val[0] == '"' || val[0] == '\'') && val[len(val)-1] == val[0] {
		val = val[1 : len(val)-1]
	} else if strings.HasPrefix(val, `"`) || strings.HasPrefix(val, "'") {
		return "", "", false // unterminated quote
	}
	return key, val, true
}

func validEnvKey(k string) bool {
	if k == "" {
		return false
	}
	for i, r := range k {
		switch {
		case r == '_', r >= 'A' && r <= 'Z', r >= 'a' && r <= 'z':
		case r >= '0' && r <= '9' && i > 0:
		default:
			return false
		}
	}
	return true
}
