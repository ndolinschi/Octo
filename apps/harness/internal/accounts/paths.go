package accounts

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
)

// realPath is p cleaned with its symlinks resolved; the deepest part that
// exists is resolved when the rest does not exist (yet).
func realPath(p string) string {
	p = filepath.Clean(p)
	rest := ""
	for cur := p; ; cur = filepath.Dir(cur) {
		if r, err := filepath.EvalSymlinks(cur); err == nil {
			return filepath.Join(r, rest)
		}
		if filepath.Dir(cur) == cur {
			return p
		}
		rest = filepath.Join(filepath.Base(cur), rest)
	}
}

// within reports whether p is dir or lies inside it (both real paths).
func within(p, dir string) bool {
	rel, err := filepath.Rel(dir, p)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}

// deletable reports whether Octo may delete the folder of account a: Octo created it (Owned), the path the record names is a plain folder
// (not a symlink, so nothing it points at is touched), and that folder is not
// a place a hand-edited record could make dangerous: the file system root, the
// home folder or one holding it, the data folder or one holding it, the
// agent's default folder (defaultDir), or the folder of another account.
// Caller holds s.mu.
func (s *Store) deletable(defaultDir string, a plugins.Account) bool {
	if !a.Owned {
		return false
	}
	dir := filepath.Clean(plugins.ExpandAccountDir(a.ConfigDir))
	if !filepath.IsAbs(dir) {
		return false
	}
	if fi, err := os.Lstat(dir); err != nil || !fi.IsDir() || fi.Mode()&os.ModeSymlink != 0 {
		return false
	}
	real := realPath(dir)
	if filepath.Dir(real) == real {
		return false
	}
	if home, err := os.UserHomeDir(); err == nil && home != "" && within(realPath(home), real) {
		return false
	}
	if s.path != "" && within(realPath(filepath.Dir(s.path)), real) {
		return false
	}
	if defaultDir != "" && real == realPath(plugins.ExpandAccountDir(defaultDir)) {
		return false
	}
	for _, o := range s.list {
		if (o.Agent != a.Agent || o.ID != a.ID) && within(realPath(plugins.ExpandAccountDir(o.ConfigDir)), real) {
			return false
		}
	}
	return true
}
