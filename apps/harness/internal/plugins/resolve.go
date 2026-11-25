package plugins

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

// resolveCommand maps a manifest command to a path: absolute as is, containing
// a separator relative to the plugin directory, otherwise a PATH lookup. The
// bool reports whether the result is an executable file.
func resolveCommand(command, pluginDir string) (string, bool) {
	switch {
	case filepath.IsAbs(command):
	case strings.ContainsAny(command, `/\`):
		command = filepath.Join(pluginDir, filepath.FromSlash(command))
	default:
		p, err := exec.LookPath(command)
		if err != nil {
			return command, false
		}
		return p, true
	}
	return command, isExecutable(command)
}

// resolveCommandIn is resolveCommand, then, for a bare name PATH does not have,
// the first executable of that name in one of the search folders ("~/" is the
// user's home). The folders are where a vendor installs its CLI by default.
func resolveCommandIn(command, pluginDir string, search []string) (string, bool) {
	path, ok := resolveCommand(command, pluginDir)
	if ok || filepath.IsAbs(command) || strings.ContainsAny(command, `/\`) {
		return path, ok
	}
	for _, dir := range search {
		dir = expandHome(dir)
		if dir == "" {
			continue
		}
		for _, name := range executableNames(command) {
			if cand := filepath.Join(dir, name); isExecutable(cand) {
				return cand, true
			}
		}
	}
	return path, false
}

// expandHome replaces a leading "~/" with the user's home; "" when it has none.
func expandHome(dir string) string {
	rest, ok := strings.CutPrefix(dir, "~/")
	if !ok {
		return dir
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return ""
	}
	return filepath.Join(home, rest)
}

// executableNames are the file names a command may have (on Windows with the
// usual extensions).
func executableNames(command string) []string {
	if runtime.GOOS != "windows" {
		return []string{command}
	}
	return []string{command, command + ".exe", command + ".cmd", command + ".bat"}
}

func isWindowsAbs(p string) bool {
	return len(p) >= 3 && p[1] == ':' && (p[2] == '\\' || p[2] == '/')
}

func isExecutable(path string) bool {
	fi, err := os.Stat(path)
	return err == nil && fi.Mode().IsRegular() && fi.Mode().Perm()&0o111 != 0
}

// Which resolves a command name the way agents are resolved (PATH lookup for a
// bare name) and says whether it was found.
func Which(command string) (string, bool) { return resolveCommand(command, "") }
