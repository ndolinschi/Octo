package local

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

var (
	protectedMu sync.RWMutex
	protected   []string
)

// ProtectDir closes dir (the harness data directory, which holds the bridge
// API token) to every path this package resolves, wherever a project folder
// sits, including a folder that contains the data directory. It is for the
// harness's own file tools and file API; a shell command is not confined.
func ProtectDir(dir string) {
	abs, err := filepath.Abs(dir)
	if err != nil {
		return
	}
	protectedMu.Lock()
	defer protectedMu.Unlock()
	protected = append(protected, abs)
	if real, err := filepath.EvalSymlinks(abs); err == nil && real != abs {
		protected = append(protected, real)
	}
}

// isProtected reports whether p (an absolute path) is in or under a protected directory.
func isProtected(p string) bool {
	protectedMu.RLock()
	defer protectedMu.RUnlock()
	for _, d := range protected {
		if pathWithinRoot(p, d) {
			return true
		}
	}
	return false
}

// Resolve returns the absolute path of rel under root, rejecting absolute
// paths, traversal and symlink escape. An empty rel is an error.
func Resolve(root, rel string) (string, error) { return resolveUnderWorkspace(root, rel) }

// ErrGitPath: a write, delete, rename or revert names a path inside a Git
// directory (or a worktree's or submodule's .git file). Git runs programs
// named there (core.fsmonitor, hooks, ...) on the harness's own git calls,
// so a file write must never reach it; reads are allowed.
var ErrGitPath = errors.New("path is inside .git: Octo does not change Git's own files")

// ResolveWritable is Resolve for a path about to be written, deleted,
// renamed or restored: it also refuses any path with a .git segment, matched
// case-insensitively (case-insensitive file systems), both as named and after
// symlinks are followed.
func ResolveWritable(root, rel string) (string, error) {
	abs, err := resolveUnderWorkspace(root, rel)
	if err != nil {
		return "", err
	}
	if hasGitSegment(filepath.Clean(rel)) {
		return "", ErrGitPath
	}
	realRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "", err
	}
	realTarget, err := resolveRealPath(abs)
	if err != nil {
		return "", err
	}
	if inside, err := filepath.Rel(realRoot, realTarget); err != nil || hasGitSegment(inside) {
		return "", ErrGitPath
	}
	return abs, nil
}

func hasGitSegment(p string) bool {
	for _, seg := range strings.Split(filepath.ToSlash(p), "/") {
		if strings.EqualFold(seg, ".git") {
			return true
		}
	}
	return false
}

func resolveUnderWorkspace(workspace, rel string) (string, error) {
	if rel == "" {
		return "", fmt.Errorf("path required")
	}
	if filepath.IsAbs(rel) {
		return "", fmt.Errorf("path must be relative to workspace")
	}
	clean := filepath.Clean(rel)
	if clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("path escapes workspace")
	}
	joined := filepath.Join(workspace, clean)
	absTarget, err := filepath.Abs(joined)
	if err != nil {
		return "", err
	}
	absWorkspace, err := filepath.Abs(workspace)
	if err != nil {
		return "", err
	}
	if absTarget != absWorkspace && !strings.HasPrefix(absTarget, absWorkspace+string(filepath.Separator)) {
		return "", fmt.Errorf("path escapes workspace")
	}
	realWorkspace, err := filepath.EvalSymlinks(absWorkspace)
	if err != nil {
		return "", err
	}
	realTarget, err := resolveRealPath(absTarget)
	if err != nil {
		return "", err
	}
	if !pathWithinRoot(realTarget, realWorkspace) {
		return "", fmt.Errorf("path escapes workspace")
	}
	if isProtected(realTarget) || isProtected(absTarget) {
		return "", fmt.Errorf("path is not available: it is inside the harness data directory")
	}
	return absTarget, nil
}

func resolveRealPath(absPath string) (string, error) {
	if _, err := os.Lstat(absPath); err == nil {
		return filepath.EvalSymlinks(absPath)
	} else if !os.IsNotExist(err) {
		return "", err
	}
	parent := filepath.Dir(absPath)
	base := filepath.Base(absPath)
	if parent == absPath {
		return "", fmt.Errorf("path not found")
	}
	realParent, err := resolveRealPath(parent)
	if err != nil {
		return "", err
	}
	return filepath.Join(realParent, base), nil
}

func pathWithinRoot(path, root string) bool {
	if path == root {
		return true
	}
	sep := string(filepath.Separator)
	return strings.HasPrefix(path, root+sep)
}
