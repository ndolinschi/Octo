package files

import (
	"bufio"
	"bytes"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"unicode/utf8"
)

const (
	newDirMode      fs.FileMode = 0o755
	maxSearchBytes  int64       = 512 << 10
	maxSearchFiles              = 10_000
	maxPreviewRunes             = 160
)

var (
	// ErrExists reports that a create or rename target already exists.
	ErrExists = errors.New("files: already exists")
)

var skipSearchDirs = map[string]bool{
	".git":         true,
	"node_modules": true,
	"target":       true,
	"dist":         true,
	"build":        true,
	".next":        true,
	".turbo":       true,
	".svelte-kit":  true,
	"vendor":       true,
	".venv":        true,
	"__pycache__":  true,
}

// SearchMatch is a single filename or content search match inside a folder root.
type SearchMatch struct {
	Path    string `json:"path"`
	Line    int    `json:"line,omitempty"`
	Column  int    `json:"column,omitempty"`
	Preview string `json:"preview,omitempty"`
}

// Mkdir creates a directory (and missing parents) at rel under root.
// Refuses empty paths, traversal, symlink escape, and paths inside .git.
func Mkdir(root, rel string) (string, error) {
	if strings.TrimSpace(rel) == "" {
		return "", ErrInvalidPath
	}
	abs, clean, err := resolveWrite(root, rel)
	if err != nil {
		return "", err
	}
	if clean == "" {
		return "", ErrInvalidPath
	}
	if _, err := os.Lstat(abs); err == nil {
		return "", ErrExists
	} else if !errors.Is(err, fs.ErrNotExist) {
		return "", err
	}
	if err := os.MkdirAll(abs, newDirMode); err != nil {
		return "", err
	}
	return clean, nil
}

// Rename moves a file or folder from fromRel to toRel within root.
// Refuses empty paths, .git paths, traversal, symlink escape, and overwriting an existing target.
func Rename(root, fromRel, toRel string) (string, error) {
	if strings.TrimSpace(fromRel) == "" || strings.TrimSpace(toRel) == "" {
		return "", ErrInvalidPath
	}
	fromAbs, fromClean, err := resolveWrite(root, fromRel)
	if err != nil {
		return "", err
	}
	toAbs, toClean, err := resolveWrite(root, toRel)
	if err != nil {
		return "", err
	}
	if fromClean == "" || toClean == "" {
		return "", ErrInvalidPath
	}
	if fromClean == toClean {
		return toClean, nil
	}
	if _, err := os.Lstat(fromAbs); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return "", ErrNotFound
		}
		return "", err
	}
	if _, err := os.Lstat(toAbs); err == nil {
		return "", ErrExists
	} else if !errors.Is(err, fs.ErrNotExist) {
		return "", err
	}
	parent := filepath.Dir(toAbs)
	if fi, err := os.Stat(parent); err != nil || !fi.IsDir() {
		if err == nil || errors.Is(err, fs.ErrNotExist) {
			return "", ErrNotFound
		}
		return "", err
	}
	if err := os.Rename(fromAbs, toAbs); err != nil {
		return "", err
	}
	return toClean, nil
}

// Delete removes a file or directory tree at rel under root.
// Refuses the root itself, .git paths, traversal, and symlink escape.
func Delete(root, rel string) (string, error) {
	if strings.TrimSpace(rel) == "" {
		return "", ErrInvalidPath
	}
	abs, clean, err := resolveWrite(root, rel)
	if err != nil {
		return "", err
	}
	if clean == "" {
		return "", ErrInvalidPath
	}
	if _, err := os.Lstat(abs); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return "", ErrNotFound
		}
		return "", err
	}
	if err := os.RemoveAll(abs); err != nil {
		return "", err
	}
	return clean, nil
}

// Search searches files under root by filename (mode "name") or line content (mode "content").
func Search(root, query, mode string, limit int) ([]SearchMatch, error) {
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}
	if mode == "" {
		mode = "name"
	}
	if mode != "name" && mode != "content" {
		return nil, ErrInvalidPath
	}
	q := strings.ToLower(strings.TrimSpace(query))
	if mode == "content" && q == "" {
		return []SearchMatch{}, nil
	}
	absRoot, _, err := resolve(root, "")
	if err != nil {
		return nil, err
	}
	if mode == "name" {
		return searchByName(absRoot, q, limit)
	}
	return searchByContent(absRoot, q, limit)
}

type scoredPath struct {
	path  string
	score int
}

func searchByName(absRoot, q string, limit int) ([]SearchMatch, error) {
	var hits []scoredPath
	seen := 0
	err := filepath.WalkDir(absRoot, func(p string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return nil
		}
		if p == absRoot {
			return nil
		}
		name := d.Name()
		if d.IsDir() {
			if skipSearchDirs[name] {
				return filepath.SkipDir
			}
			return nil
		}
		if d.Type()&os.ModeSymlink != 0 {
			return nil
		}
		seen++
		if seen > maxSearchFiles {
			return filepath.SkipAll
		}
		rel, err := filepath.Rel(absRoot, p)
		if err != nil {
			return nil
		}
		rel = filepath.ToSlash(rel)
		if q == "" {
			hits = append(hits, scoredPath{path: rel, score: 0})
			if len(hits) >= limit*4 {
				return filepath.SkipAll
			}
			return nil
		}
		lowRel := strings.ToLower(rel)
		lowBase := strings.ToLower(name)
		score := -1
		switch {
		case lowBase == q:
			score = 0
		case strings.HasPrefix(lowBase, q):
			score = 1
		case strings.Contains(lowBase, q):
			score = 2
		case strings.Contains(lowRel, q):
			score = 3
		case fuzzySubseq(lowRel, q):
			score = 4
		}
		if score >= 0 {
			hits = append(hits, scoredPath{path: rel, score: score})
		}
		return nil
	})
	if err != nil && !errors.Is(err, filepath.SkipAll) {
		return nil, err
	}
	slices.SortFunc(hits, func(a, b scoredPath) int {
		if a.score != b.score {
			return a.score - b.score
		}
		if len(a.path) != len(b.path) {
			return len(a.path) - len(b.path)
		}
		return strings.Compare(a.path, b.path)
	})
	if len(hits) > limit {
		hits = hits[:limit]
	}
	out := make([]SearchMatch, len(hits))
	for i, h := range hits {
		out[i] = SearchMatch{Path: h.path}
	}
	return out, nil
}

func fuzzySubseq(haystack, needle string) bool {
	if needle == "" {
		return true
	}
	j := 0
	for i := 0; i < len(haystack) && j < len(needle); i++ {
		if haystack[i] == needle[j] {
			j++
		}
	}
	return j == len(needle)
}

func searchByContent(absRoot, q string, limit int) ([]SearchMatch, error) {
	var out []SearchMatch
	seen := 0
	err := filepath.WalkDir(absRoot, func(p string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return nil
		}
		if p == absRoot {
			return nil
		}
		name := d.Name()
		if d.IsDir() {
			if skipSearchDirs[name] {
				return filepath.SkipDir
			}
			return nil
		}
		if d.Type()&os.ModeSymlink != 0 {
			return nil
		}
		seen++
		if seen > maxSearchFiles {
			return filepath.SkipAll
		}
		fi, err := d.Info()
		if err != nil || !fi.Mode().IsRegular() || fi.Size() == 0 || fi.Size() > maxSearchBytes {
			return nil
		}
		data, err := os.ReadFile(p)
		if err != nil || len(data) == 0 || bytes.IndexByte(data, 0) >= 0 || !utf8.Valid(data) {
			return nil
		}
		rel, err := filepath.Rel(absRoot, p)
		if err != nil {
			return nil
		}
		rel = filepath.ToSlash(rel)
		sc := bufio.NewScanner(bytes.NewReader(data))
		sc.Buffer(make([]byte, 0, 16<<10), int(maxSearchBytes))
		lineNo := 0
		for sc.Scan() {
			lineNo++
			line := sc.Text()
			idx := strings.Index(strings.ToLower(line), q)
			if idx < 0 {
				continue
			}
			out = append(out, SearchMatch{
				Path:    rel,
				Line:    lineNo,
				Column:  idx + 1,
				Preview: trimPreview(line),
			})
			if len(out) >= limit {
				return filepath.SkipAll
			}
		}
		return nil
	})
	if err != nil && !errors.Is(err, filepath.SkipAll) {
		return nil, err
	}
	return out, nil
}

func trimPreview(line string) string {
	s := strings.TrimSpace(line)
	runes := []rune(s)
	if len(runes) <= maxPreviewRunes {
		return s
	}
	return string(runes[:maxPreviewRunes]) + "…"
}
