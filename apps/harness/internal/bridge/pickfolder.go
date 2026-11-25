package bridge

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/childenv"
)

// pickTimeout is how long a folder chooser may stay open.
const pickTimeout = 10 * time.Minute

// pickerGOOS is the operating system the chooser is picked for (tests change it).
var pickerGOOS = runtime.GOOS

// pickerEnvNames are the variables a desktop dialog needs to reach the user's
// session; they locate sockets and displays and hold no secret.
var pickerEnvNames = []string{
	"DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR",
	"XDG_CURRENT_DESKTOP", "XDG_SESSION_TYPE", "DESKTOP_SESSION", "GTK_THEME", "QT_QPA_PLATFORM",
}

// The macOS script reads the start folder from its argument, never from
// interpolated text.
var osascriptLines = []string{
	"on run argv",
	"set startPath to item 1 of argv",
	`if startPath is "" then`,
	`return POSIX path of (choose folder with prompt "Choose a folder")`,
	"end if",
	`return POSIX path of (choose folder with prompt "Choose a folder" default location (POSIX file startPath))`,
	"end run",
}

// The Windows script reads the start folder from OCTO_PICK_START.
const powershellScript = `Add-Type -AssemblyName System.Windows.Forms; ` +
	`$d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = 'Choose a folder'; ` +
	`if ($env:OCTO_PICK_START) { $d.SelectedPath = $env:OCTO_PICK_START }; ` +
	`if ($d.ShowDialog() -eq 'OK') { [Console]::Out.Write($d.SelectedPath) } else { exit 1 }`

// folderChooser is one way to open the system's folder chooser.
type folderChooser struct {
	name string
	// build returns the command for a start folder ("" = the chooser's own default).
	build func(start string) *exec.Cmd
	// env is extra environment for the command (nil: none).
	env func(start string) map[string]string
	// cancelled says whether a failed run means "the user closed the dialog".
	cancelled func(exit int, stdout, stderr string) bool
}

// findChooser picks the chooser for this machine, or says why there is none.
func findChooser() (folderChooser, string) {
	switch pickerGOOS {
	case "darwin":
		path, err := exec.LookPath("osascript")
		if err != nil {
			return folderChooser{}, "osascript was not found on PATH"
		}
		return folderChooser{
			name: "osascript",
			build: func(start string) *exec.Cmd {
				args := make([]string, 0, 2*len(osascriptLines)+1)
				for _, l := range osascriptLines {
					args = append(args, "-e", l)
				}
				return exec.Command(path, append(args, start)...)
			},
			// The user's cancel is exit status 1 with error -128 ("User canceled.").
			cancelled: func(exit int, _, stderr string) bool {
				return exit == 1 && (strings.Contains(stderr, "-128") || strings.Contains(strings.ToLower(stderr), "user canceled"))
			},
		}, ""
	case "windows":
		path, err := exec.LookPath("powershell")
		if err != nil {
			return folderChooser{}, "powershell was not found on PATH"
		}
		return folderChooser{
			name: "powershell",
			build: func(string) *exec.Cmd {
				return exec.Command(path, "-NoProfile", "-NonInteractive", "-STA", "-Command", powershellScript)
			},
			env:       func(start string) map[string]string { return map[string]string{"OCTO_PICK_START": start} },
			cancelled: func(exit int, stdout, _ string) bool { return exit == 1 && strings.TrimSpace(stdout) == "" },
		}, ""
	}
	if os.Getenv("DISPLAY") == "" && os.Getenv("WAYLAND_DISPLAY") == "" {
		return folderChooser{}, "there is no display (neither DISPLAY nor WAYLAND_DISPLAY is set)"
	}
	if path, err := exec.LookPath("zenity"); err == nil {
		return folderChooser{
			name: "zenity",
			build: func(start string) *exec.Cmd {
				args := []string{"--file-selection", "--directory", "--title=Choose a folder"}
				if start != "" {
					args = append(args, "--filename="+strings.TrimRight(start, "/")+"/")
				}
				return exec.Command(path, args...)
			},
			cancelled: func(exit int, stdout, _ string) bool { return exit == 1 && strings.TrimSpace(stdout) == "" },
		}, ""
	}
	if path, err := exec.LookPath("kdialog"); err == nil {
		return folderChooser{
			name: "kdialog",
			build: func(start string) *exec.Cmd {
				if start == "" {
					start, _ = os.UserHomeDir()
				}
				return exec.Command(path, "--getexistingdirectory", start)
			},
			cancelled: func(exit int, stdout, _ string) bool { return exit == 1 && strings.TrimSpace(stdout) == "" },
		}, ""
	}
	return folderChooser{}, "neither zenity nor kdialog was found on PATH"
}

// pickFolderAvailable reports whether a system folder chooser can be opened.
func pickFolderAvailable() bool {
	_, why := findChooser()
	return why == ""
}

// picker lets one dialog be open at a time.
type picker struct{ mu sync.Mutex }

// startFolder is the folder the chooser opens in: start when it is an existing
// directory (`~` is the home directory), else "" (the chooser's default).
func startFolder(start string) string {
	start = strings.TrimSpace(start)
	if start == "" {
		return ""
	}
	if p, ok := expandHome(start); ok {
		start = p
	}
	if !filepath.IsAbs(start) {
		return ""
	}
	start = filepath.Clean(start)
	if fi, err := os.Stat(start); err != nil || !fi.IsDir() {
		return ""
	}
	return start
}

// pickFolder is POST /v1/fs/pick-folder {start?}: it opens the operating
// system's own folder chooser and answers {path} or {cancelled: true};
// {error: "unavailable", message} when no chooser exists here. One dialog at a
// time (409 busy); the dialog is closed when the request is cancelled.
func (s *Server) pickFolder(w http.ResponseWriter, r *http.Request) {
	if !s.loopbackGuard(w, r, "the folder chooser") {
		return
	}
	var in struct {
		Start string `json:"start"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBody)).Decode(&in); err != nil && !errors.Is(err, io.EOF) {
		writeError(w, http.StatusBadRequest, "invalid_request", "invalid JSON body: "+err.Error())
		return
	}
	chooser, why := findChooser()
	if why != "" {
		writeJSON(w, http.StatusOK, map[string]any{"error": "unavailable", "message": "No folder chooser is available: " + why + "."})
		return
	}
	if !s.picker.mu.TryLock() {
		writeError(w, http.StatusConflict, "busy", "a folder chooser is already open")
		return
	}
	defer s.picker.mu.Unlock()

	ctx, cancel := context.WithTimeout(r.Context(), pickTimeout)
	defer cancel()
	start := startFolder(in.Start)
	built := chooser.build(start)
	cmd := exec.CommandContext(ctx, built.Path, built.Args[1:]...)
	var extra map[string]string
	if chooser.env != nil {
		extra = chooser.env(start)
	}
	cmd.Env = pickerEnv(extra)
	var stdout, stderr limited
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	cmd.WaitDelay = 2 * time.Second
	err := cmd.Run()
	if ctx.Err() != nil {
		if r.Context().Err() == nil {
			writeJSON(w, http.StatusOK, map[string]any{"error": "failed", "message": "The folder chooser was closed after 10 minutes."})
		}
		return
	}
	var exit *exec.ExitError
	switch {
	case err == nil:
	case errors.As(err, &exit):
		if chooser.cancelled(exit.ExitCode(), stdout.String(), stderr.String()) {
			writeJSON(w, http.StatusOK, map[string]any{"cancelled": true})
			return
		}
		slog.Warn("folder chooser failed", "chooser", chooser.name, "exit", exit.ExitCode(), "stderr", stderr.String())
		writeJSON(w, http.StatusOK, map[string]any{"error": "failed", "message": "The folder chooser (" + chooser.name + ") failed."})
		return
	default:
		slog.Warn("folder chooser could not start", "chooser", chooser.name, "err", err)
		writeJSON(w, http.StatusOK, map[string]any{"error": "unavailable", "message": "The folder chooser (" + chooser.name + ") could not be started."})
		return
	}
	path := strings.TrimRight(strings.TrimSpace(stdout.String()), "\r\n")
	if path == "" {
		writeJSON(w, http.StatusOK, map[string]any{"cancelled": true})
		return
	}
	if len(path) > 1 {
		path = strings.TrimRight(path, `/\`)
	}
	if fi, err := os.Stat(path); !filepath.IsAbs(path) || err != nil || !fi.IsDir() {
		writeJSON(w, http.StatusOK, map[string]any{"error": "invalid", "message": "The folder chooser returned something that is not a folder."})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"path": path})
}

// pickerEnv is the environment of the dialog: the child allow-list plus the
// variables that locate the user's display and session bus (and what the
// command itself needs, such as the Windows start folder).
func pickerEnv(more map[string]string) []string {
	extra := map[string]string{}
	for _, n := range pickerEnvNames {
		if v := os.Getenv(n); v != "" {
			extra[n] = v
		}
	}
	for k, v := range more {
		extra[k] = v
	}
	return childenv.Build(os.Environ(), extra)
}

// limited keeps the first 16 KiB written to it.
type limited struct {
	mu sync.Mutex
	b  []byte
}

func (l *limited) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if room := 16<<10 - len(l.b); room > 0 {
		l.b = append(l.b, p[:min(len(p), room)]...)
	}
	return len(p), nil
}

func (l *limited) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return string(l.b)
}
