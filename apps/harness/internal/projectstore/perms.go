package projectstore

import (
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
)

// The data directory holds conversations, tool output and secret references: it is private to the user who runs
// the harness. Directories are created 0700 and files 0600 (on Windows the modes mean nothing and this is a no-op).
const (
	privateDir  = 0o700
	privateFile = 0o600
)

// makePrivate removes group and other access from path (a missing path is fine). The user's own bits are kept, so
// an executable stays executable.
func makePrivate(path string) {
	if runtime.GOOS == "windows" {
		return
	}
	fi, err := os.Lstat(path)
	if err != nil || fi.Mode()&os.ModeSymlink != 0 {
		return
	}
	if perm := fi.Mode().Perm(); perm&0o077 != 0 {
		if err := os.Chmod(path, perm&^0o077); err != nil {
			slog.Warn("could not make a data file private", "path", path, "err", err)
		}
	}
}

// makeSQLitePrivate makes a database and its WAL and shared-memory files private.
func makeSQLitePrivate(path string) {
	for _, p := range []string{path, path + "-wal", path + "-shm", path + "-journal"} {
		makePrivate(p)
	}
}

// tightenTree makes root and everything up to depth levels below it private: the data directory, its files
// (registry, traces, logs, the API token) and each project's directory and files (database, WAL, SHM, backups,
// worktree and attachment directories). Deeper entries (a worktree's checked-out files) are left as they are: the
// private directories above them already close them to other users.
func tightenTree(root string, depth int) {
	if runtime.GOOS == "windows" {
		return
	}
	makePrivate(root)
	if depth == 0 {
		return
	}
	ents, err := os.ReadDir(root)
	if err != nil {
		return
	}
	for _, e := range ents {
		p := filepath.Join(root, e.Name())
		if e.Type()&os.ModeSymlink != 0 {
			continue
		}
		if e.IsDir() {
			tightenTree(p, depth-1)
		} else {
			makePrivate(p)
		}
	}
}
