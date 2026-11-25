package main

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// desktopAppID is the identifier of the desktop app (apps/desktop/src-tauri/tauri.conf.json).
// The shell keeps the harness's data in Tauri's app data directory, in "harness"
// (apps/desktop/src-tauri/src/lib.rs); this duplicates that path logic on purpose
// and imports nothing from the shell.
const desktopAppID = "com.ndolinschi.octo.desktop"

// desktopDataDir is where the desktop app keeps the harness's data on this
// machine ("" when it cannot be worked out): Tauri's app_data_dir plus "harness".
func desktopDataDir() string {
	home, _ := os.UserHomeDir()
	var base string
	switch runtime.GOOS {
	case "darwin":
		if home == "" {
			return ""
		}
		base = filepath.Join(home, "Library", "Application Support")
	case "windows":
		base = os.Getenv("APPDATA")
	default:
		base = os.Getenv("XDG_DATA_HOME")
		if base == "" && home != "" {
			base = filepath.Join(home, ".local", "share")
		}
	}
	if base == "" {
		return ""
	}
	return filepath.Join(base, desktopAppID, "harness")
}

// dataDirFlag returns the value of --data-dir in args ("" when absent).
func dataDirFlag(args []string) string {
	for i, a := range args {
		a = strings.TrimPrefix(strings.TrimPrefix(a, "-"), "-")
		switch {
		case a == "data-dir" && i+1 < len(args):
			return args[i+1]
		case strings.HasPrefix(a, "data-dir="):
			return strings.TrimPrefix(a, "data-dir=")
		}
	}
	return ""
}

// doctorDataDir picks the data directory `harness doctor` inspects and says why.
// A flag or HARNESS_DATA_DIR wins; otherwise the desktop app's directory when it
// exists, since that is the app the user runs; otherwise the harness default.
// chosen is "" when the default applies unchanged.
func doctorDataDir(args []string) (chosen, why string) {
	if d := dataDirFlag(args); d != "" {
		return "", "--data-dir " + d
	}
	if d := os.Getenv("HARNESS_DATA_DIR"); d != "" {
		return "", "HARNESS_DATA_DIR"
	}
	if d := desktopDataDir(); d != "" {
		if st, err := os.Stat(d); err == nil && st.IsDir() {
			return d, "the desktop app's data directory exists and no --data-dir or HARNESS_DATA_DIR was given"
		}
	}
	return "", "the default (no --data-dir, no HARNESS_DATA_DIR and no desktop app data found at " + desktopDataDir() + ")"
}
