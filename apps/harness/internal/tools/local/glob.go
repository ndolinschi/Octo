package local

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/childenv"
	"github.com/ndolinschi/Octo/apps/harness/internal/globx"
	"github.com/ndolinschi/Octo/apps/harness/internal/tools"
)

const (
	globMaxResults = 200
	globMaxVisited = 50000
)

// globSkipDirs are not walked in a folder that is not a git work tree (a work
// tree uses its own ignore rules, like the change tracker's walk).
var globSkipDirs = map[string]bool{
	".git": true, "node_modules": true, "target": true, "__pycache__": true, ".venv": true, "venv": true, ".cache": true,
}

// GlobFiles lists the regular files under dir (absolute, inside root) whose path
// relative to dir matches pattern: slash paths relative to root, sorted. A git
// work tree is listed through git (tracked and untracked files that .gitignore
// does not exclude), any other folder by walking it without the usual
// dependency and build directories. Symlinks are never followed or listed.
// more reports that the result was cut at max.
func GlobFiles(ctx context.Context, root, dir, pattern string, max int) (files []string, more bool, err error) {
	if pattern == "" || !globx.Valid(pattern) {
		return nil, false, fmt.Errorf("pattern must be a valid glob such as **/*.go")
	}
	pattern = strings.TrimPrefix(filepath.ToSlash(pattern), "./")
	if strings.HasPrefix(pattern, "/") || pattern == ".." || strings.HasPrefix(pattern, "../") || strings.Contains(pattern, "/../") {
		return nil, false, fmt.Errorf("pattern must be relative and stay inside the folder")
	}
	relDir, err := filepath.Rel(root, dir)
	if err != nil {
		return nil, false, err
	}
	relDir = filepath.ToSlash(relDir)
	if relDir == "." {
		relDir = ""
	}
	var all []string
	if listed, ok := gitFiles(ctx, root, relDir); ok {
		all = listed
	} else {
		visited := 0
		walkErr := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
			if cerr := ctx.Err(); cerr != nil {
				return cerr
			}
			if err != nil {
				return nil
			}
			if d.IsDir() {
				if p != dir && globSkipDirs[d.Name()] {
					return filepath.SkipDir
				}
				return nil
			}
			if !d.Type().IsRegular() {
				return nil
			}
			if visited++; visited > globMaxVisited {
				return filepath.SkipAll
			}
			rel, rerr := filepath.Rel(root, p)
			if rerr == nil {
				all = append(all, filepath.ToSlash(rel))
			}
			return nil
		})
		if walkErr != nil {
			return nil, false, walkErr
		}
	}
	prefix := ""
	if relDir != "" {
		prefix = relDir + "/"
	}
	for _, f := range all {
		if !strings.HasPrefix(f, prefix) {
			continue
		}
		if globx.Match(pattern, strings.TrimPrefix(f, prefix)) {
			files = append(files, f)
		}
	}
	slices.Sort(files)
	if len(files) > max {
		files, more = files[:max], true
	}
	return files, more, nil
}

// gitFiles lists the files git knows (tracked, or untracked and not ignored)
// under relDir of root; ok is false outside a work tree or without git.
func gitFiles(ctx context.Context, root, relDir string) ([]string, bool) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	args := []string{"-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"}
	if relDir != "" {
		args = append(args, "--", relDir)
	}
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Env = append(childenv.Build(os.Environ(), nil), "GIT_OPTIONAL_LOCKS=0")
	var out bytes.Buffer
	cmd.Stdout = &out
	if err := cmd.Run(); err != nil {
		return nil, false
	}
	var paths []string
	for _, p := range strings.Split(out.String(), "\x00") {
		if p == "" || p == ".git" || strings.HasPrefix(p, ".git/") {
			continue
		}
		fi, err := os.Lstat(filepath.Join(root, filepath.FromSlash(p)))
		if err != nil || !fi.Mode().IsRegular() { // gone, a submodule or a symlink
			continue
		}
		paths = append(paths, p)
	}
	return paths, true
}

func globHandler(rs *rootSet) tools.Handler {
	return func(ctx context.Context, input json.RawMessage) (string, bool, error) {
		var in struct {
			Pattern string `json:"pattern"`
			Path    string `json:"path"`
			Folder  string `json:"folder"`
		}
		if err := json.Unmarshal(input, &in); err != nil {
			return err.Error(), true, nil
		}
		rel := in.Path
		if rel == "" {
			rel = "."
		}
		root, dir, err := rs.resolve(in.Folder, rel)
		if err != nil {
			return err.Error(), true, nil
		}
		if fi, err := os.Stat(dir); err != nil || !fi.IsDir() {
			return in.Path + ": not a directory", true, nil
		}
		files, more, err := GlobFiles(ctx, root, dir, in.Pattern, globMaxResults)
		if err != nil {
			return err.Error(), true, nil
		}
		if len(files) == 0 {
			return "no files match", false, nil
		}
		out := strings.Join(files, "\n") + "\n"
		if more {
			out += fmt.Sprintf("[glob: stopped at %d files; narrow the pattern or the path]\n", len(files))
		}
		return out, false, nil
	}
}
