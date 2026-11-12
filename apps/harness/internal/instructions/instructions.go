// Package instructions reads a project's instruction files (AGENTS.md and
// CLAUDE.md) for the built-in agent loop. The files of each project folder's
// root come first; for a task that names files, the directories between the
// root and those files follow, the nearest last. Every file is read fresh,
// capped at MaxFile bytes (a marker says so) and the whole set at MaxTotal.
// ACP agents read their own instruction files: nothing here is ever sent to one.
package instructions

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/ndolinschi/Octo/apps/harness/internal/tools/local"
)

// Caps on what the agent is given.
const (
	MaxFile  = 32 << 10
	MaxTotal = 64 << 10
	// MaxPaths bounds how many file paths of a request are looked at.
	MaxPaths = 24
)

// Names are the instruction file names looked for in each directory, in this order.
var Names = []string{"AGENTS.md", "CLAUDE.md"}

// TruncMarker ends a file that was cut at the cap.
const TruncMarker = "\n[... truncated by the harness: the file is larger than its 32 kB cap ...]\n"

// Folder is a project folder.
type Folder struct{ Label, Path string }

// File is one instruction file as the agent gets it.
type File struct {
	// Path is "<folder label>:<path relative to the folder>", slashes.
	Path string `json:"path"`
	// Size is the file's size on disk; Used what of it the agent gets (the
	// truncation marker not counted); Truncated says the rest was cut.
	Size      int  `json:"size"`
	Used      int  `json:"used"`
	Truncated bool `json:"truncated"`
	text      string
}

// Set is the files found, root first and nearest last.
type Set struct {
	Files []File
}

// Empty reports that no file was found.
func (s Set) Empty() bool { return len(s.Files) == 0 }

// Render is the block for the system prompt ("" for an empty set). redact, when
// set, scrubs the text of stored secrets.
func (s Set) Render(redact func(string) string) string {
	if s.Empty() {
		return ""
	}
	var b strings.Builder
	b.WriteString("\nProject instruction files (AGENTS.md / CLAUDE.md). They are the project's own rules for working in it, " +
		"listed from the project root to the directories closest to the files in question; where two disagree, the later one wins.\n")
	for _, f := range s.Files {
		t := f.text
		if redact != nil {
			t = redact(t)
		}
		b.WriteString("\n### " + f.Path + "\n")
		b.WriteString(strings.TrimRight(t, "\n"))
		b.WriteString("\n")
	}
	return b.String()
}

// Collect reads the instruction files of the folders' roots and of the
// directories between each root and the given paths (absolute, or relative to
// the first folder or to any folder; ones that name nothing inside a folder are
// ignored). Never fails: an unreadable file is skipped.
func Collect(folders []Folder, paths []string) Set {
	type cand struct {
		folder string
		dirRel string // slash path of the directory relative to the folder root, "" = root
		name   string
		abs    string
	}
	var cands []cand
	for _, f := range folders {
		dirs := []string{""}
		for _, p := range paths {
			rel, ok := relIn(f.Path, p)
			if !ok {
				continue
			}
			d := path2dir(f.Path, rel)
			for d != "" {
				dirs = append(dirs, d)
				d = path2parent(d)
			}
		}
		dirs = uniq(dirs)
		// Root first, then by depth: the nearest directory comes last.
		slices.SortStableFunc(dirs, func(a, b string) int {
			da, db := depth(a), depth(b)
			if da != db {
				return da - db
			}
			return strings.Compare(a, b)
		})
		for _, d := range dirs {
			for _, n := range Names {
				rel := n
				if d != "" {
					rel = d + "/" + n
				}
				abs, err := local.Resolve(f.Path, rel)
				if err != nil {
					continue
				}
				// Resolve confined the path to the folder (a symlink out of it is refused).
				if fi, err := os.Stat(abs); err != nil || !fi.Mode().IsRegular() {
					continue
				}
				cands = append(cands, cand{folder: f.Label, dirRel: d, name: n, abs: abs})
			}
		}
	}
	// Read, cap each file, then fit the total: the nearest files win.
	files := make([]File, 0, len(cands))
	for _, c := range cands {
		data, err := readCapped(c.abs, MaxFile)
		if err != nil {
			continue
		}
		rel := c.name
		if c.dirRel != "" {
			rel = c.dirRel + "/" + c.name
		}
		text := string(data.head)
		f := File{Path: c.folder + ":" + rel, Size: data.size, Used: len(data.head), Truncated: data.size > len(data.head)}
		if f.Truncated {
			text += TruncMarker
		}
		if strings.TrimSpace(text) == "" {
			continue
		}
		f.text = text
		files = append(files, f)
	}
	remaining := MaxTotal
	keep := make([]bool, len(files))
	for i := len(files) - 1; i >= 0; i-- {
		f := &files[i]
		n := len(f.text)
		switch {
		case n <= remaining:
			keep[i] = true
			remaining -= n
		case remaining > len(TruncMarker)+512:
			cut := clipUTF8(f.text[:max(remaining-len(TruncMarker), 0)], remaining-len(TruncMarker))
			f.text = cut + TruncMarker
			f.Used, f.Truncated = len(cut), true
			keep[i] = true
			remaining = 0
		}
	}
	var out Set
	for i, f := range files {
		if keep[i] {
			out.Files = append(out.Files, f)
		}
	}
	return out
}

type capped struct {
	head []byte
	size int
}

func readCapped(path string, max int) (capped, error) {
	f, err := os.Open(path)
	if err != nil {
		return capped{}, err
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return capped{}, err
	}
	buf := make([]byte, max)
	n, err := f.Read(buf)
	if err != nil && n == 0 && fi.Size() > 0 {
		return capped{}, err
	}
	buf = buf[:n]
	if len(buf) == max {
		buf = []byte(clipUTF8(string(buf), max))
	}
	if !utf8.Valid(buf) {
		buf = []byte(strings.ToValidUTF8(string(buf), "�"))
	}
	return capped{head: buf, size: int(fi.Size())}, nil
}

// clipUTF8 cuts s to at most n bytes without splitting a rune.
func clipUTF8(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n]
}

// relIn maps p (absolute, or relative to root) to a slash path inside root.
func relIn(root, p string) (string, bool) {
	if p == "" {
		return "", false
	}
	abs := p
	if !filepath.IsAbs(p) {
		abs = filepath.Join(root, p)
	}
	rel, err := filepath.Rel(root, filepath.Clean(abs))
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", false
	}
	return filepath.ToSlash(rel), true
}

// path2dir is the directory part of rel: rel itself when it names a directory on disk.
func path2dir(root, rel string) string {
	if fi, err := os.Stat(filepath.Join(root, filepath.FromSlash(rel))); err == nil && fi.IsDir() {
		return rel
	}
	d := filepath.ToSlash(filepath.Dir(filepath.FromSlash(rel)))
	if d == "." {
		return ""
	}
	return d
}

func path2parent(d string) string {
	i := strings.LastIndexByte(d, '/')
	if i < 0 {
		return ""
	}
	return d[:i]
}

func depth(d string) int {
	if d == "" {
		return 0
	}
	return strings.Count(d, "/") + 1
}

func uniq(l []string) []string {
	slices.Sort(l)
	return slices.Compact(l)
}

// PathsIn finds the file paths a piece of text names: words that, taken as a
// path (absolute inside a folder, or relative to one), exist on disk. It looks
// at no more than MaxPaths words and returns paths as written.
func PathsIn(folders []Folder, text string) []string {
	if len(folders) == 0 || text == "" {
		return nil
	}
	seen := map[string]bool{}
	var out []string
	for _, w := range strings.FieldsFunc(text, func(r rune) bool {
		return strings.ContainsRune(" \t\r\n\"'`()[]{}<>,;|", r)
	}) {
		w = strings.TrimRight(w, ".:!?")
		if i := strings.LastIndex(w, ":"); i > 0 && allDigits(w[i+1:]) { // path:line
			w = w[:i]
		}
		if w == "" || seen[w] || !strings.ContainsAny(w, "/.") || strings.Contains(w, "://") {
			continue
		}
		seen[w] = true
		if len(seen) > MaxPaths*4 {
			break
		}
		for _, f := range folders {
			rel, ok := relIn(f.Path, w)
			if !ok {
				continue
			}
			if _, err := os.Stat(filepath.Join(f.Path, filepath.FromSlash(rel))); err == nil {
				out = append(out, w)
				break
			}
		}
		if len(out) >= MaxPaths {
			break
		}
	}
	return out
}

func allDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// IsInstructionFile reports whether a slash path names an instruction file (by its base name).
func IsInstructionFile(p string) bool {
	return slices.Contains(Names, filepath.Base(filepath.FromSlash(p)))
}
