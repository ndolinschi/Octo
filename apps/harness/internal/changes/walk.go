package changes

import (
	"bytes"
	"context"
	"io/fs"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/childenv"
)

// skipDirs are not walked in a folder that is not a git work tree (a git work
// tree uses its own ignore rules instead).
var skipDirs = map[string]bool{
	".git": true, "node_modules": true, "target": true, "__pycache__": true, ".venv": true, "venv": true, ".cache": true,
}

type stamp struct {
	size  int64
	mtime int64
}

func stampOf(fi fs.FileInfo) stamp { return stamp{fi.Size(), fi.ModTime().UnixNano()} }

// list returns the regular files under root (slash paths relative to it) with
// size and mtime, and whether the walk stopped at MaxFiles.
func list(ctx context.Context, root string) (map[string]stamp, bool) {
	if paths, ok := gitList(ctx, root); ok {
		return statAll(root, paths)
	}
	out := map[string]stamp{}
	truncated := false
	_ = filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			if p != root && skipDirs[d.Name()] {
				return filepath.SkipDir
			}
			return nil
		}
		if !d.Type().IsRegular() {
			return nil
		}
		if len(out) >= MaxFiles {
			truncated = true
			return filepath.SkipAll
		}
		if fi, err := d.Info(); err == nil {
			rel, _ := filepath.Rel(root, p)
			out[filepath.ToSlash(rel)] = stamp{fi.Size(), fi.ModTime().UnixNano()}
		}
		return nil
	})
	return out, truncated
}

// gitList asks git for the tracked and untracked-but-not-ignored files, which
// respects .gitignore, .git/info/exclude and the global excludes. ok is false
// when root is not inside a git work tree (or git is missing).
func gitList(ctx context.Context, root string) ([]string, bool) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", "-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard")
	cmd.Env = append(childenv.Build(os.Environ(), nil), "GIT_OPTIONAL_LOCKS=0")
	var out bytes.Buffer
	cmd.Stdout = &out
	if err := cmd.Run(); err != nil {
		return nil, false
	}
	var paths []string
	for _, p := range strings.Split(out.String(), "\x00") {
		if p != "" && p != ".git" && !strings.HasPrefix(p, ".git/") {
			paths = append(paths, p)
		}
	}
	return paths, true
}

// statAll lstat's the listed paths: files git still lists but that are gone,
// directories (submodules) and symlinks are left out.
func statAll(root string, paths []string) (map[string]stamp, bool) {
	out := make(map[string]stamp, len(paths))
	truncated := false
	for _, rel := range paths {
		if len(out) >= MaxFiles {
			truncated = true
			break
		}
		fi, err := os.Lstat(filepath.Join(root, filepath.FromSlash(rel)))
		if err != nil || !fi.Mode().IsRegular() {
			continue
		}
		out[rel] = stamp{fi.Size(), fi.ModTime().UnixNano()}
	}
	return out, truncated
}

func warnTruncated(root string) {
	slog.Warn("change tracking: folder has more files than the snapshot walk covers; changes beyond the first files are not detected",
		"folder", root, "max_files", MaxFiles)
}
