package bridge

import (
	"errors"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
)

// maxDirEntries caps GET /v1/fs/dirs; maxRecentFolders caps GET /v1/fs/recent.
const (
	maxDirEntries    = 50
	maxRecentFolders = 8
)

type gitInfo struct {
	Branch string `json:"branch"`
}

type dirEntry struct {
	Name string   `json:"name"`
	Path string   `json:"path"`
	Git  *gitInfo `json:"git"`
}

// fsDirs completes a directory path for the folder picker: the child
// directories (never files) of the path's directory whose names start with its
// last segment. Loopback only, like settings.
func (s *Server) fsDirs(w http.ResponseWriter, r *http.Request) {
	if !s.loopbackGuard(w, r, "folder listings") {
		return
	}
	base, entries, problem := listDirs(r.URL.Query().Get("path"))
	out := map[string]any{"base": base, "entries": entries}
	if problem != "" {
		out["error"] = problem
	}
	writeJSON(w, http.StatusOK, out)
}

// fsRecent lists the folders of existing projects, newest first.
func (s *Server) fsRecent(w http.ResponseWriter, r *http.Request) {
	if !s.loopbackGuard(w, r, "folder listings") {
		return
	}
	paths, err := s.svc.RecentFolders(r.Context(), maxRecentFolders)
	if err != nil {
		writeErr(w, err)
		return
	}
	entries := make([]dirEntry, 0, len(paths))
	for _, p := range paths {
		entries = append(entries, dirEntry{Name: filepath.Base(p), Path: p, Git: readGit(p)})
	}
	writeJSON(w, http.StatusOK, map[string]any{"entries": entries})
}

// expandHome turns "", "~" and "~/x" into paths under the home directory.
func expandHome(p string) (string, bool) {
	if p != "" && p != "~" && !strings.HasPrefix(p, "~/") && !strings.HasPrefix(p, `~\`) {
		return p, true
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return "", false
	}
	if p == "" || p == "~" {
		return home + string(filepath.Separator), true
	}
	return filepath.Join(home, p[2:]) + trailingSep(p), true
}

func trailingSep(p string) string {
	if strings.HasSuffix(p, "/") || strings.HasSuffix(p, string(filepath.Separator)) {
		return string(filepath.Separator)
	}
	return ""
}

// listDirs does the work of fsDirs. problem is "not_found" or "not_readable".
func listDirs(path string) (base string, entries []dirEntry, problem string) {
	entries = []dirEntry{}
	p, ok := expandHome(path)
	if !ok || !filepath.IsAbs(p) {
		return "", entries, "not_found"
	}
	prefix := ""
	if trailingSep(p) != "" {
		base = filepath.Clean(p)
	} else {
		base, prefix = filepath.Dir(p), filepath.Base(p)
	}
	st, err := os.Stat(base) // follows a symlink to a directory, fails on a loop
	switch {
	case err != nil && errors.Is(err, fs.ErrPermission):
		return base, entries, "not_readable"
	case err != nil || !st.IsDir():
		return base, entries, "not_found"
	}
	list, err := os.ReadDir(base)
	if err != nil {
		return base, entries, "not_readable"
	}
	showHidden := strings.HasPrefix(prefix, ".")
	want := strings.ToLower(prefix)
	var names []string
	for _, e := range list {
		n := e.Name()
		if strings.HasPrefix(n, ".") && !showHidden || !strings.HasPrefix(strings.ToLower(n), want) {
			continue
		}
		// Stat, not the entry type: a symlink counts when it leads to a directory;
		// a link to a file, a dangling link or a loop is skipped.
		if st, err := os.Stat(filepath.Join(base, n)); err != nil || !st.IsDir() {
			continue
		}
		names = append(names, n)
	}
	slices.SortFunc(names, func(a, b string) int {
		if c := strings.Compare(strings.ToLower(a), strings.ToLower(b)); c != 0 {
			return c
		}
		return strings.Compare(a, b)
	})
	if len(names) > maxDirEntries {
		names = names[:maxDirEntries]
	}
	for _, n := range names {
		full := filepath.Join(base, n)
		entries = append(entries, dirEntry{Name: n, Path: full, Git: readGit(full)})
	}
	return base, entries, ""
}

// readGit reads the branch of a git work tree from .git/HEAD without running
// git; .git may be a file pointing at the real directory (worktrees, submodules).
func readGit(dir string) *gitInfo {
	dot := filepath.Join(dir, ".git")
	st, err := os.Stat(dot)
	if err != nil {
		return nil
	}
	gitDir := dot
	if !st.IsDir() {
		raw, err := os.ReadFile(dot)
		if err != nil || len(raw) > 4096 {
			return nil
		}
		line := strings.TrimSpace(string(raw))
		rest, ok := strings.CutPrefix(line, "gitdir:")
		if !ok {
			return nil
		}
		gitDir = strings.TrimSpace(rest)
		if !filepath.IsAbs(gitDir) {
			gitDir = filepath.Join(dir, gitDir)
		}
	}
	raw, err := os.ReadFile(filepath.Join(gitDir, "HEAD"))
	if err != nil || len(raw) > 4096 {
		return &gitInfo{}
	}
	head := strings.TrimSpace(string(raw))
	if ref, ok := strings.CutPrefix(head, "ref:"); ok {
		return &gitInfo{Branch: strings.TrimPrefix(strings.TrimSpace(ref), "refs/heads/")}
	}
	if len(head) > 7 {
		head = head[:7] // detached: the short commit id
	}
	return &gitInfo{Branch: head}
}
