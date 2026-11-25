package bridge_test

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/bridge"
)

// fakeTools puts scripts named after the chooser programs first on PATH and
// returns the directory.
func fakeTools(t *testing.T, scripts map[string]string) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("uses sh")
	}
	dir := t.TempDir()
	for name, body := range scripts {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("#!/bin/sh\n"+body+"\n"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	// sh itself must stay reachable for the scripts' own commands.
	t.Setenv("PATH", dir+string(os.PathListSeparator)+"/usr/bin"+string(os.PathListSeparator)+"/bin")
	return dir
}

func pickEnv(t *testing.T, goos string) *env {
	t.Helper()
	t.Cleanup(bridge.SetPickerGOOS(goos))
	t.Setenv("DISPLAY", ":99")
	return fsEnv(t)
}

type pickResp struct {
	Path      string `json:"path"`
	Cancelled bool   `json:"cancelled"`
	Error     string `json:"error"`
	Message   string `json:"message"`
}

func pick(t *testing.T, e *env, start string) pickResp {
	t.Helper()
	var body any
	if start != "" {
		body = map[string]string{"start": start}
	}
	var r pickResp
	e.into(t, "POST", "/v1/fs/pick-folder", body, http.StatusOK, &r)
	return r
}

func TestPickFolderZenity(t *testing.T) {
	root := t.TempDir()
	chosen := filepath.Join(root, "Мои проекты", "my folder")
	if err := os.MkdirAll(chosen, 0o755); err != nil {
		t.Fatal(err)
	}
	start := filepath.Join(root, "Мои проекты")
	log := filepath.Join(t.TempDir(), "args")
	fakeTools(t, map[string]string{"zenity": `printf '%s\n' "$@" > '` + log + `'; printf '%s\n' '` + chosen + `'`})
	e := pickEnv(t, "linux")
	if got := pick(t, e, start); got.Path != chosen || got.Cancelled || got.Error != "" {
		t.Fatalf("got %+v, want path %q", got, chosen)
	}
	raw, _ := os.ReadFile(log)
	args := strings.Split(strings.TrimSpace(string(raw)), "\n")
	want := []string{"--file-selection", "--directory", "--title=Choose a folder", "--filename=" + start + "/"}
	if strings.Join(args, "|") != strings.Join(want, "|") {
		t.Fatalf("zenity args = %q, want %q", args, want)
	}
	// With no start (or a start that is no folder) the chooser gets no filename.
	pick(t, e, "")
	pick(t, e, filepath.Join(root, "nope"))
	raw, _ = os.ReadFile(log)
	if strings.Contains(string(raw), "--filename") {
		t.Fatalf("zenity args = %q, want no --filename", raw)
	}
}

func TestPickFolderCancelled(t *testing.T) {
	fakeTools(t, map[string]string{"zenity": "exit 1"})
	e := pickEnv(t, "linux")
	if got := pick(t, e, ""); !got.Cancelled || got.Path != "" || got.Error != "" {
		t.Fatalf("got %+v, want cancelled", got)
	}
	// A crash is a failure, not a cancel.
	fakeTools(t, map[string]string{"zenity": "echo boom >&2; exit 5"})
	if got := pick(t, e, ""); got.Cancelled || got.Error != "failed" {
		t.Fatalf("got %+v, want failed", got)
	}
}

func TestPickFolderKdialogFallbackAndUnavailable(t *testing.T) {
	chosen := t.TempDir()
	log := filepath.Join(t.TempDir(), "args")
	fakeTools(t, map[string]string{"kdialog": `printf '%s\n' "$@" > '` + log + `'; echo '` + chosen + `'`})
	e := pickEnv(t, "linux")
	if got := pick(t, e, chosen); got.Path != chosen {
		t.Fatalf("got %+v", got)
	}
	if raw, _ := os.ReadFile(log); strings.TrimSpace(string(raw)) != "--getexistingdirectory\n"+chosen {
		t.Fatalf("kdialog args = %q", raw)
	}
	// Neither tool: unavailable, and the config says so.
	fakeTools(t, map[string]string{})
	got := pick(t, e, "")
	if got.Error != "unavailable" || !strings.Contains(got.Message, "zenity") {
		t.Fatalf("got %+v", got)
	}
	var cfg struct {
		PickFolder bool `json:"pick_folder"`
	}
	e.into(t, "GET", "/v1/config", nil, http.StatusOK, &cfg)
	if cfg.PickFolder {
		t.Fatal("config says pick_folder with no chooser")
	}
	// Headless: a tool alone is not enough.
	fakeTools(t, map[string]string{"zenity": "echo /tmp"})
	t.Setenv("DISPLAY", "")
	t.Setenv("WAYLAND_DISPLAY", "")
	if got := pick(t, e, ""); got.Error != "unavailable" || !strings.Contains(got.Message, "no display") {
		t.Fatalf("headless: %+v", got)
	}
	t.Setenv("DISPLAY", ":99")
	e.into(t, "GET", "/v1/config", nil, http.StatusOK, &cfg)
	if !cfg.PickFolder {
		t.Fatal("config lacks pick_folder with zenity and a display")
	}
}

func TestPickFolderRejectsWhatIsNotAFolder(t *testing.T) {
	file := filepath.Join(t.TempDir(), "file.txt")
	if err := os.WriteFile(file, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	fakeTools(t, map[string]string{"zenity": "echo '" + file + "'"})
	e := pickEnv(t, "linux")
	if got := pick(t, e, ""); got.Error != "invalid" || got.Path != "" {
		t.Fatalf("file: %+v", got)
	}
	fakeTools(t, map[string]string{"zenity": "echo relative/dir"})
	if got := pick(t, e, ""); got.Error != "invalid" {
		t.Fatalf("relative: %+v", got)
	}
}

func TestPickFolderMacOS(t *testing.T) {
	chosen := filepath.Join(t.TempDir(), "My Folder")
	if err := os.MkdirAll(chosen, 0o755); err != nil {
		t.Fatal(err)
	}
	log := filepath.Join(t.TempDir(), "args")
	// osascript prints the POSIX path with a trailing slash.
	fakeTools(t, map[string]string{"osascript": `printf '%s\n' "$@" > '` + log + `'; printf '%s/\n' '` + chosen + `'`})
	e := pickEnv(t, "darwin")
	start := t.TempDir()
	if got := pick(t, e, start); got.Path != chosen {
		t.Fatalf("got %+v, want %q", got, chosen)
	}
	raw, _ := os.ReadFile(log)
	lines := strings.Split(strings.TrimRight(string(raw), "\n"), "\n")
	// The script is a series of -e lines and the start folder is the last argument,
	// never part of the script text.
	if lines[len(lines)-1] != start || strings.Contains(strings.Join(lines[:len(lines)-1], "\n"), start) {
		t.Fatalf("osascript args = %q", lines)
	}
	if lines[0] != "-e" || lines[1] != "on run argv" || !strings.Contains(string(raw), "item 1 of argv") {
		t.Fatalf("osascript args = %q", lines)
	}
	// A start with quotes cannot break out of anything: it is only an argument.
	odd := filepath.Join(t.TempDir(), `a "quoted" folder`)
	if err := os.MkdirAll(odd, 0o755); err != nil {
		t.Fatal(err)
	}
	pick(t, e, odd)
	if raw, _ := os.ReadFile(log); !strings.HasSuffix(strings.TrimRight(string(raw), "\n"), odd) {
		t.Fatalf("osascript args = %q", raw)
	}
	// The user's cancel: exit status 1 with error -128.
	fakeTools(t, map[string]string{"osascript": `echo "execution error: User canceled. (-128)" >&2; exit 1`})
	if got := pick(t, e, ""); !got.Cancelled || got.Error != "" {
		t.Fatalf("cancel: %+v", got)
	}
	// Exit 1 for another reason is a failure.
	fakeTools(t, map[string]string{"osascript": `echo "syntax error" >&2; exit 1`})
	if got := pick(t, e, ""); got.Cancelled || got.Error != "failed" {
		t.Fatalf("failure: %+v", got)
	}
	fakeTools(t, map[string]string{})
	if got := pick(t, e, ""); got.Error != "unavailable" || !strings.Contains(got.Message, "osascript") {
		t.Fatalf("missing osascript: %+v", got)
	}
}

// One dialog at a time: a second request answers 409 busy while the first is open.
func TestPickFolderBusy(t *testing.T) {
	chosen := t.TempDir()
	release := filepath.Join(t.TempDir(), "release")
	started := filepath.Join(t.TempDir(), "started")
	fakeTools(t, map[string]string{"zenity": `: > '` + started + `'; while [ ! -e '` + release + `' ]; do sleep 0.05; done; echo '` + chosen + `'`})
	e := pickEnv(t, "linux")
	first := make(chan pickResp, 1)
	go func() {
		var r pickResp
		status, raw := e.do(t, "POST", "/v1/fs/pick-folder", nil)
		if status == http.StatusOK {
			_ = json.Unmarshal(raw, &r)
		}
		first <- r
	}()
	waitUntil(t, "the dialog to open", func() bool { _, err := os.Stat(started); return err == nil })
	e.wantError(t, "POST", "/v1/fs/pick-folder", nil, http.StatusConflict, "busy")
	if err := os.WriteFile(release, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if got := <-first; got.Path != chosen {
		t.Fatalf("first = %+v", got)
	}
	// The lock is free again.
	if got := pick(t, e, ""); got.Path != chosen {
		t.Fatalf("after release: %+v", got)
	}
}

// When the HTTP request is cancelled the dialog is closed: its process is killed.
func TestPickFolderCancelledRequestKillsTheDialog(t *testing.T) {
	pidFile := filepath.Join(t.TempDir(), "pid")
	fakeTools(t, map[string]string{"zenity": `echo $$ > '` + pidFile + `'; exec sleep 60`})
	e := pickEnv(t, "linux")
	ctx, cancel := context.WithCancel(context.Background())
	req, err := http.NewRequestWithContext(ctx, "POST", e.url+"/v1/fs/pick-folder", nil)
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		resp, err := http.DefaultClient.Do(req)
		if resp != nil {
			_ = resp.Body.Close()
		}
		done <- err
	}()
	var pid int
	waitUntil(t, "the dialog process", func() bool {
		raw, err := os.ReadFile(pidFile)
		if err != nil {
			return false
		}
		pid, err = strconv.Atoi(strings.TrimSpace(string(raw)))
		return err == nil && pid > 0
	})
	cancel()
	<-done
	waitUntil(t, "the dialog process to be killed", func() bool { return syscall.Kill(pid, 0) != nil })
	// And the next request is not refused as busy.
	fakeTools(t, map[string]string{"zenity": "exit 1"})
	if got := pick(t, e, ""); !got.Cancelled {
		t.Fatalf("after the kill: %+v", got)
	}
}

func TestPickFolderIsLoopbackOnly(t *testing.T) {
	fakeTools(t, map[string]string{"zenity": "exit 1"})
	t.Cleanup(bridge.SetPickerGOOS("linux"))
	t.Setenv("DISPLAY", ":99")
	e := newEnvWith(t, nil, nil) // the bridge was not told it listens on loopback
	e.wantError(t, "POST", "/v1/fs/pick-folder", nil, http.StatusForbidden, "forbidden")
}
