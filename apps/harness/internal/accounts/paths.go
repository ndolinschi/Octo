package accounts

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
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

// dirUsed reports whether a folder the user chose is already the folder of an
// account, comparing cleaned paths with their symlinks resolved.
func (s *Service) dirUsed(dir string) bool {
	want := realPath(dir)
	return slices.ContainsFunc(s.f.Accounts, func(a Account) bool { return realPath(a.Dir) == want })
}

// deletable reports whether Octo may delete acc's folder: it created it
// (Owned), the record's folder is exactly {data}/accounts/<agent>/<id>, that
// folder is not a symlink, and the folder it lies in still resolves to a place
// inside the real {data}/accounts. A hand-edited record, or a symlinked agent
// folder, therefore never makes Octo delete anything else.
func (s *Service) deletable(acc Account) bool {
	if !acc.Owned || acc.Agent == "" || acc.ID == "" || acc.Agent != filepath.Base(acc.Agent) ||
		acc.Dir != filepath.Join(s.root, acc.Agent, acc.ID) {
		return false
	}
	if fi, err := os.Lstat(acc.Dir); err != nil || !fi.IsDir() {
		return false
	}
	root, err := filepath.EvalSymlinks(s.root)
	if err != nil {
		return false
	}
	parent, err := filepath.EvalSymlinks(filepath.Dir(acc.Dir))
	if err != nil {
		return false
	}
	rel, err := filepath.Rel(root, parent)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}
