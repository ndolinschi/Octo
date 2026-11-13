package config

import (
	"bufio"
	"errors"
	"fmt"
	"io/fs"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"unicode"
)

// ReadEnvValues parses {dataDir}/harness.env into a map, whatever its mode (the
// loader refuses a group-readable file; a settings screen still has to show
// and repair it). The first occurrence of a key wins, as in LoadEnvFile.
// Malformed lines are skipped. A missing file is an empty map.
func ReadEnvValues(dataDir string) (map[string]string, error) {
	out := map[string]string{}
	f, err := os.Open(filepath.Join(dataDir, EnvFileName))
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return out, nil
		}
		return nil, err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 1<<20)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, val, ok := parseEnvLine(line)
		if !ok {
			continue
		}
		if _, dup := out[key]; !dup {
			out[key] = val
		}
	}
	return out, sc.Err()
}

// ValidEnvValue reports why v cannot be stored as a harness.env value: control
// characters (newlines included) would break the line format, and a leading
// quote or surrounding blanks would be read back differently than written.
// The reason never contains v.
func ValidEnvValue(v string) error {
	if v != strings.TrimSpace(v) {
		return errors.New("must not start or end with whitespace")
	}
	for _, r := range v {
		if unicode.IsControl(r) {
			return errors.New("must not contain control characters or line breaks")
		}
	}
	if strings.HasPrefix(v, `"`) || strings.HasPrefix(v, "'") {
		return errors.New("must not start with a quote character")
	}
	return nil
}

// UpdateEnvFile rewrites {dataDir}/harness.env atomically: every other line
// (comments, blanks, unknown variables) is kept as it was, set replaces the
// first line of a key (later duplicates of it are dropped) or appends one,
// unset removes every line of a key. The result is written to a temporary file
// in the same directory with mode 0600, synced and renamed over the original,
// so a reader sees the old file or the new one, never a mix, and a file that
// was group-readable comes out 0600. Values are never logged or put in errors.
func UpdateEnvFile(dataDir string, set map[string]string, unset []string) error {
	for k, v := range set {
		if !validEnvKey(k) {
			return fmt.Errorf("invalid variable name %q", k)
		}
		if err := ValidEnvValue(v); err != nil {
			return fmt.Errorf("%s: %w", k, err)
		}
	}
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return err
	}
	path := filepath.Join(dataDir, EnvFileName)
	var lines []string
	raw, err := os.ReadFile(path)
	switch {
	case err == nil:
		lines = strings.Split(strings.TrimSuffix(string(raw), "\n"), "\n")
		if len(raw) == 0 {
			lines = nil
		}
	case errors.Is(err, fs.ErrNotExist):
	default:
		return err
	}
	if fi, err := os.Lstat(path); err == nil && !fi.Mode().IsRegular() && fi.Mode()&os.ModeSymlink == 0 {
		return errors.New("harness.env is not a regular file")
	}

	drop := map[string]bool{}
	for _, k := range unset {
		drop[k] = true
	}
	written := map[string]bool{}
	out := make([]string, 0, len(lines)+len(set))
	for _, line := range lines {
		t := strings.TrimSpace(line)
		if t != "" && !strings.HasPrefix(t, "#") {
			if key, _, ok := parseEnvLine(t); ok {
				if drop[key] {
					continue
				}
				if v, replace := set[key]; replace {
					if written[key] {
						continue
					}
					written[key] = true
					out = append(out, key+"="+v)
					continue
				}
			}
		}
		out = append(out, line)
	}
	for _, k := range slices.Sorted(maps.Keys(set)) {
		if !written[k] {
			out = append(out, k+"="+set[k])
		}
	}
	data := ""
	if len(out) > 0 {
		data = strings.Join(out, "\n") + "\n"
	}
	return writeAtomic(path, []byte(data))
}

func writeAtomic(path string, data []byte) (err error) {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, EnvFileName+".tmp-*") // created 0600
	if err != nil {
		return err
	}
	defer func() {
		if err != nil {
			_ = tmp.Close()
			_ = os.Remove(tmp.Name())
		}
	}()
	if err = tmp.Chmod(0o600); err != nil && !errors.Is(err, errors.ErrUnsupported) {
		// Windows has no mode bits; anywhere else a failure here is real.
		if pathSeparatorIsSlash() {
			return err
		}
		err = nil
	}
	if _, err = tmp.Write(data); err != nil {
		return err
	}
	if err = tmp.Sync(); err != nil {
		return err
	}
	if err = tmp.Close(); err != nil {
		return err
	}
	if err = os.Rename(tmp.Name(), path); err != nil {
		return err
	}
	if d, derr := os.Open(dir); derr == nil { // make the rename durable; best effort
		_ = d.Sync()
		_ = d.Close()
	}
	return nil
}

func pathSeparatorIsSlash() bool { return os.PathSeparator == '/' }
