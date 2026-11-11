package plugins

import (
	"os"
	"os/exec"
	"path/filepath"
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

func isExecutable(path string) bool {
	fi, err := os.Stat(path)
	return err == nil && fi.Mode().IsRegular() && fi.Mode().Perm()&0o111 != 0
}

// Which resolves a command name the way agents are resolved (PATH lookup for a
// bare name) and says whether it was found.
func Which(command string) (string, bool) { return resolveCommand(command, "") }
