package local

import (
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
