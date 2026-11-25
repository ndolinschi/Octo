// Package files reads, lists and writes files under a confined folder root.
package files

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/ndolinschi/Octo/apps/harness/internal/tools/local"
)

// MaxReadBytes is the largest file Read returns.
const MaxReadBytes = 2 << 20

var (
	ErrInvalidPath = errors.New("files: invalid path")
	ErrNotFound    = errors.New("files: not found")
	ErrNotFile     = errors.New("files: not a regular file")
	ErrTooLarge    = errors.New("files: file too large")
	ErrBinary      = errors.New("files: not UTF-8 text")
	ErrChanged     = errors.New("files: changed on disk")
	// ErrGitPath: a write names a path inside .git (local.ErrGitPath).
	ErrGitPath = local.ErrGitPath
)

type Entry struct {
	Name string `json:"name"`
	Path string `json:"path"`
	Type string `json:"type"`
	Size int64  `json:"size"`
	// Chain names, for a directory, the directories below it while each is the only entry of its parent
	// (`.git` aside) and a real directory: ["main", "java", "com"] for src/ when src/main/java/com/ hold
	// nothing else. It lets a client draw "compact folders" with one listing per visible row. At most
	// MaxChain names; never set on a file or a symlinked directory, and it never descends through a symlink.
	Chain []string `json:"chain,omitempty"`
}

// MaxChain bounds Entry.Chain.
const MaxChain = 32

// chain follows abs down while it holds exactly one entry (`.git` aside) and that entry is a real directory.
func chain(abs string) []string {
	var out []string
	for len(out) < MaxChain {
		name, ok := onlyChildDir(abs)
		if !ok {
			break
		}
		out = append(out, name)
		abs = filepath.Join(abs, name)
	}
	return out
}

// onlyChildDir reads at most three entries: enough to tell "one besides .git" from "more".
func onlyChildDir(abs string) (string, bool) {
	d, err := os.Open(abs)
	if err != nil {
		return "", false
	}
	defer d.Close()
	ents, _ := d.ReadDir(3) // an unreadable directory ends the chain; listing it reports the error
	var only os.DirEntry
	n := 0
	for _, e := range ents {
		if e.Name() == ".git" {
			continue
		}
		n++
		only = e
	}
	if n != 1 || !only.Type().IsDir() {
		return "", false
	}
	return only.Name(), true
}

// Info describes a file: its folder-relative slash path, size and modification time.
type Info struct {
	Path  string
	Size  int64
	MTime time.Time
}

// FormatTime renders t in the API's RFC 3339 form with nanoseconds, in UTC.
func FormatTime(t time.Time) string { return t.UTC().Format(time.RFC3339Nano) }

// resolve confines rel under root; the empty path names the root itself.
func resolve(root, rel string) (abs, clean string, err error) {
	return resolveWith(local.Resolve, root, rel)
}

// resolveWrite is resolve for a write: a path inside .git is ErrGitPath.
func resolveWrite(root, rel string) (abs, clean string, err error) {
	return resolveWith(local.ResolveWritable, root, rel)
}

func resolveWith(confine func(root, rel string) (string, error), root, rel string) (abs, clean string, err error) {
	if rel == "" {
		rel = "."
	}
	abs, err = confine(root, rel)
	if errors.Is(err, local.ErrGitPath) {
		return "", "", ErrGitPath
	}
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return "", "", ErrNotFound
		}
		return "", "", fmt.Errorf("%w: %v", ErrInvalidPath, err)
	}
	clean = filepath.ToSlash(filepath.Clean(rel))
	if clean == "." {
		clean = ""
	}
	return abs, clean, nil
}

// List returns one directory level: directories first, then by name; .git is omitted.
func List(root, rel string) ([]Entry, error) {
	abs, clean, err := resolve(root, rel)
	if err != nil {
		return nil, err
	}
	if fi, err := os.Stat(abs); err != nil || !fi.IsDir() {
		if err == nil || errors.Is(err, fs.ErrNotExist) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	dirents, err := os.ReadDir(abs)
	if err != nil {
		return nil, err
	}
	out := make([]Entry, 0, len(dirents))
	for _, d := range dirents {
		if d.Name() == ".git" {
			continue
		}
		typ := d.Type()
		if typ&os.ModeSymlink != 0 {
			entryPath := path.Join(clean, d.Name())
			if _, _, err := resolve(root, entryPath); err != nil {
				continue
			}
			fi, err := os.Stat(filepath.Join(abs, d.Name()))
			if err != nil {
				continue
			}
			e := Entry{Name: d.Name(), Path: entryPath, Type: "file", Size: fi.Size()}
			if fi.IsDir() {
				e.Type, e.Size = "dir", 0
			}
			out = append(out, e)
			continue
		}
		e := Entry{Name: d.Name(), Path: path.Join(clean, d.Name()), Type: "file"}
		if typ.IsDir() {
			e.Type = "dir"
			e.Chain = chain(filepath.Join(abs, d.Name()))
		} else {
			fi, err := d.Info()
			if err != nil {
				continue
			}
			e.Size = fi.Size()
		}
		out = append(out, e)
	}
	slices.SortFunc(out, func(a, b Entry) int {
		if (a.Type == "dir") != (b.Type == "dir") {
			if a.Type == "dir" {
				return -1
			}
			return 1
		}
		return strings.Compare(a.Name, b.Name)
	})
	return out, nil
}

// Read returns a UTF-8 text file's content and info.
func Read(root, rel string) (string, Info, error) {
	data, info, err := ReadBytes(root, rel)
	if err != nil {
		return "", Info{}, err
	}
	if !utf8.Valid(data) || bytes.IndexByte(data, 0) >= 0 {
		return "", Info{}, ErrBinary
	}
	return string(data), info, nil
}

// ReadBytes returns any regular file's bytes and info, with the same path
// checks and size limit as Read (used to preview images).
func ReadBytes(root, rel string) ([]byte, Info, error) {
	abs, clean, err := resolve(root, rel)
	if err != nil {
		return nil, Info{}, err
	}
	f, err := os.Open(abs)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, Info{}, ErrNotFound
		}
		return nil, Info{}, err
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return nil, Info{}, err
	}
	if !fi.Mode().IsRegular() {
		return nil, Info{}, ErrNotFile
	}
	size := fi.Size()
	if size > MaxReadBytes {
		return nil, Info{}, ErrTooLarge
	}
	capHint := int64(512)
	if size > 0 {
		capHint = min(size+1, MaxReadBytes+1)
	}
	buf := bytes.NewBuffer(make([]byte, 0, capHint))
	if _, err := io.Copy(buf, io.LimitReader(f, MaxReadBytes+1)); err != nil {
		return nil, Info{}, err
	}
	data := buf.Bytes()
	if len(data) > MaxReadBytes {
		return nil, Info{}, ErrTooLarge
	}
	return data, Info{Path: clean, Size: int64(len(data)), MTime: fi.ModTime()}, nil
}
