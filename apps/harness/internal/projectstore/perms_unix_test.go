//go:build !windows

package projectstore

import (
	"context"
	"io/fs"
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

// The data directory holds every conversation, tool output and secret reference: other users of the machine must
// not read it. Directories are 0700 and files 0600, for new projects (database, WAL, SHM) and for an existing data
// directory written with the old modes, which Open tightens (security review finding 6).
func TestDataDirIsPrivate(t *testing.T) {
	old := syscall.Umask(0o022)
	defer syscall.Umask(old)
	ctx := context.Background()
	dir := t.TempDir()
	if err := os.Chmod(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	st, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	db, err := st.Create(ctx, NewProject{Name: "p", ModelsJSON: "{}", MaxDepth: 3})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Orchestrator(ctx); err != nil {
		t.Fatal(err)
	}
	pdir := st.ProjectDir(db.ID())
	// What an older harness left behind: world-readable directories and files, a backup and a trace.
	for _, p := range []string{filepath.Join(dir, "traces"), filepath.Join(pdir, "worktrees")} {
		if err := os.MkdirAll(p, 0o755); err != nil {
			t.Fatal(err)
		}
		_ = os.Chmod(p, 0o755)
	}
	for _, p := range []string{filepath.Join(pdir, "project.sqlite.pre-m6"), filepath.Join(dir, "traces", "acp-1.log")} {
		if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if fi, err := os.Stat(dir); err != nil || fi.Mode().Perm() != 0o700 {
		t.Fatalf("data directory mode = %v (%v), want 0700", fi.Mode().Perm(), err)
	}
	checkPrivate(t, dir, false)
	_ = st.Close()

	st, err = Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	if _, err := st.Get(ctx, db.ID()); err != nil {
		t.Fatal(err)
	}
	checkPrivate(t, dir, true)
}

// checkPrivate reports every entry under dir (three levels deep) open to group or others. Before the restart the
// files planted with old modes are expected to be open (all=false skips them).
func checkPrivate(t *testing.T, dir string, all bool) {
	t.Helper()
	planted := map[string]bool{"traces": true, "worktrees": true, "project.sqlite.pre-m6": true, "acp-1.log": true}
	_ = filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		fi, err := os.Lstat(p)
		if err != nil || fi.Mode()&os.ModeSymlink != 0 {
			return nil
		}
		if !all && planted[d.Name()] {
			return nil
		}
		if fi.Mode().Perm()&0o077 != 0 {
			t.Errorf("%s is %v", p, fi.Mode().Perm())
		}
		return nil
	})
}
