package gitx

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"io"
	"strconv"
	"strings"
)

// RawFile is one changed file between two commits.
type RawFile struct {
	Status  string // added, modified, deleted, renamed, copied, typechange
	Path    string // the path at the new side (the old one for a deletion)
	OldPath string // set for a rename or copy
	Sim     int    // similarity percent for a rename or copy
	OldBlob string // "" when the file did not exist before
	NewBlob string // "" when the file does not exist after
	Added   int
	Removed int
	Binary  bool
}

// Diff lists the files changed between base and head with renames paired
// (50 % similarity), blob ids and line counts. Paths are exact (NUL separated).
func Diff(ctx context.Context, dir, base, head string) ([]RawFile, error) {
	raw, err := Run(ctx, dir, "diff", "--raw", "-z", "-M50%", "--no-ext-diff", "--no-textconv", "--no-color", "--abbrev=40", base, head, "--")
	if err != nil {
		return nil, err
	}
	files, byPath, err := parseRaw(raw)
	if err != nil {
		return nil, err
	}
	num, err := Run(ctx, dir, "diff", "--numstat", "-z", "-M50%", "--no-ext-diff", "--no-textconv", "--no-color", base, head, "--")
	if err != nil {
		return nil, err
	}
	for _, n := range parseNumstat(num) {
		if i, ok := byPath[n.path]; ok {
			files[i].Added, files[i].Removed, files[i].Binary = n.added, n.removed, n.binary
		}
	}
	return files, nil
}

// IgnoringWhitespace returns, per new path, the line counts with whitespace
// differences ignored; a file whose count is 0/0 while its plain count is not
// was only reformatted.
func IgnoringWhitespace(ctx context.Context, dir, base, head string) (map[string][2]int, error) {
	num, err := Run(ctx, dir, "diff", "--numstat", "-z", "-w", "--ignore-blank-lines", "-M50%", "--no-ext-diff", "--no-textconv", "--no-color", base, head, "--")
	if err != nil {
		return nil, err
	}
	out := map[string][2]int{}
	for _, n := range parseNumstat(num) {
		if !n.binary {
			out[n.path] = [2]int{n.added, n.removed}
		}
	}
	return out, nil
}

func parseRaw(raw []byte) ([]RawFile, map[string]int, error) {
	parts := strings.Split(string(raw), "\x00")
	var files []RawFile
	byPath := map[string]int{}
	for i := 0; i < len(parts); i++ {
		meta := parts[i]
		if meta == "" {
			continue
		}
		if !strings.HasPrefix(meta, ":") {
			return nil, nil, fmt.Errorf("unexpected git diff output %q", meta)
		}
		f := strings.Fields(meta[1:])
		if len(f) < 5 {
			return nil, nil, fmt.Errorf("unexpected git diff record %q", meta)
		}
		oldBlob, newBlob, st := f[2], f[3], f[4]
		rf := RawFile{OldBlob: blobOrEmpty(oldBlob), NewBlob: blobOrEmpty(newBlob)}
		code := st[:1]
		if len(st) > 1 {
			rf.Sim, _ = strconv.Atoi(st[1:])
		}
		switch code {
		case "A":
			rf.Status = "added"
		case "D":
			rf.Status = "deleted"
		case "M":
			rf.Status = "modified"
		case "T":
			rf.Status = "typechange"
		case "R", "C":
			rf.Status = map[string]string{"R": "renamed", "C": "copied"}[code]
			if i+2 >= len(parts) {
				return nil, nil, fmt.Errorf("truncated rename record")
			}
			rf.OldPath, rf.Path = parts[i+1], parts[i+2]
			i += 2
			byPath[rf.Path] = len(files)
			files = append(files, rf)
			continue
		default:
			rf.Status = "modified"
		}
		if i+1 >= len(parts) {
			return nil, nil, fmt.Errorf("truncated diff record")
		}
		rf.Path = parts[i+1]
		i++
		byPath[rf.Path] = len(files)
		files = append(files, rf)
	}
	return files, byPath, nil
}

func blobOrEmpty(s string) string {
	if strings.Trim(s, "0") == "" {
		return ""
	}
	return s
}

type numstat struct {
	added, removed int
	binary         bool
	path           string
}

func parseNumstat(raw []byte) []numstat {
	parts := strings.Split(string(raw), "\x00")
	var out []numstat
	for i := 0; i < len(parts); i++ {
		rec := parts[i]
		if rec == "" {
			continue
		}
		f := strings.SplitN(rec, "\t", 3)
		if len(f) < 3 {
			continue
		}
		n := numstat{}
		if f[0] == "-" || f[1] == "-" {
			n.binary = true
		} else {
			n.added, _ = strconv.Atoi(f[0])
			n.removed, _ = strconv.Atoi(f[1])
		}
		if f[2] == "" {
			// A rename: the old and the new path follow as their own records.
			if i+2 >= len(parts) {
				break
			}
			n.path = parts[i+2]
			i += 2
		} else {
			n.path = f[2]
		}
		out = append(out, n)
	}
	return out
}

// ChangedLines is the added and removed lines of one file of a zero-context diff.
type ChangedLines struct {
	Added   []string
	Removed []string
}

// MaxLinesScan caps the zero-context patch read for the reading order.
const MaxLinesScan = 16 << 20

// ChangedText reads one zero-context patch of the whole range and groups the
// changed lines by new path. ok is false when the patch was too large to read.
func ChangedText(ctx context.Context, dir, base, head string) (map[string]*ChangedLines, bool, error) {
	out, err := Run(ctx, dir, "diff", "-U0", "-M50%", "--no-ext-diff", "--no-textconv", "--no-color", "--src-prefix=a/", "--dst-prefix=b/", base, head, "--")
	if err != nil {
		if strings.Contains(err.Error(), "output too large") {
			return nil, false, nil
		}
		return nil, false, err
	}
	if len(out) > MaxLinesScan {
		return nil, false, nil
	}
	res := map[string]*ChangedLines{}
	var cur *ChangedLines
	sc := bufio.NewScanner(bytes.NewReader(out))
	sc.Buffer(make([]byte, 0, 64<<10), 4<<20)
	inHunk := false
	oldPath := ""
	for sc.Scan() {
		line := sc.Text()
		switch {
		case strings.HasPrefix(line, "diff --git "):
			inHunk, cur, oldPath = false, nil, ""
		case !inHunk && strings.HasPrefix(line, "+++ "):
			p := strings.TrimPrefix(line, "+++ ")
			if strings.HasPrefix(p, "b/") {
				p = p[2:]
			} else if p == "/dev/null" && oldPath != "" {
				p = oldPath // a deletion is keyed by the path it had
			} else {
				continue
			}
			cur = &ChangedLines{}
			res[p] = cur
		case !inHunk && strings.HasPrefix(line, "--- "):
			if p := strings.TrimPrefix(line, "--- "); strings.HasPrefix(p, "a/") {
				oldPath = p[2:]
			}
		case strings.HasPrefix(line, "@@"):
			inHunk = true
		case inHunk && cur != nil && strings.HasPrefix(line, "+"):
			cur.Added = append(cur.Added, line[1:])
		case inHunk && cur != nil && strings.HasPrefix(line, "-"):
			cur.Removed = append(cur.Removed, line[1:])
		}
	}
	return res, true, nil
}

// Hunk lines.
type Line struct {
	Type string `json:"type"` // context, add, del
	Old  int    `json:"old,omitempty"`
	New  int    `json:"new,omitempty"`
	Text string `json:"text"`
	// NoNewline marks a line that has no trailing newline in its file.
	NoNewline bool `json:"no_newline,omitempty"`
}

// Hunk is one `@@` block.
type Hunk struct {
	OldStart int    `json:"old_start"`
	OldLines int    `json:"old_lines"`
	NewStart int    `json:"new_start"`
	NewLines int    `json:"new_lines"`
	Header   string `json:"header"`
	Lines    []Line `json:"lines"`
}

// PatchOptions tune FilePatch.
type PatchOptions struct {
	Context          int
	IgnoreWhitespace bool
	// MaxBytes caps the patch read; a longer patch is reported as TooLarge.
	MaxBytes int
}

// PatchResult is the parsed diff of one file.
type PatchResult struct {
	Hunks    []Hunk
	Binary   bool
	TooLarge bool
}

// FilePatch returns the hunks of path between base and head. For a rename pass
// oldPath so git pairs the two sides.
func FilePatch(ctx context.Context, dir, base, head, oldPath, path string, o PatchOptions) (PatchResult, error) {
	if o.Context < 0 {
		o.Context = 3
	}
	if o.MaxBytes <= 0 {
		o.MaxBytes = 4 << 20
	}
	args := []string{"diff", fmt.Sprintf("-U%d", o.Context), "-M50%", "--no-ext-diff", "--no-textconv", "--no-color"}
	if o.IgnoreWhitespace {
		args = append(args, "-w")
	}
	args = append(args, base, head, "--")
	if oldPath != "" && oldPath != path {
		args = append(args, oldPath)
	}
	args = append(args, path)
	out, err := Run(ctx, dir, args...)
	if err != nil {
		if strings.Contains(err.Error(), "output too large") {
			return PatchResult{TooLarge: true}, nil
		}
		return PatchResult{}, err
	}
	if len(out) > o.MaxBytes {
		return PatchResult{TooLarge: true}, nil
	}
	return ParsePatch(out), nil
}

// ParsePatch reads a unified diff of a single file.
func ParsePatch(out []byte) PatchResult {
	var res PatchResult
	sc := bufio.NewScanner(bytes.NewReader(out))
	sc.Buffer(make([]byte, 0, 64<<10), 8<<20)
	var h *Hunk
	oldN, newN := 0, 0
	for sc.Scan() {
		line := sc.Text()
		if h == nil {
			if strings.HasPrefix(line, "Binary files ") || strings.HasPrefix(line, "GIT binary patch") {
				res.Binary = true
			}
			if strings.HasPrefix(line, "@@") {
				// fallthrough to hunk header parsing below
			} else {
				continue
			}
		}
		if strings.HasPrefix(line, "@@") {
			nh, ok := parseHunkHeader(line)
			if !ok {
				continue
			}
			res.Hunks = append(res.Hunks, nh)
			h = &res.Hunks[len(res.Hunks)-1]
			oldN, newN = h.OldStart, h.NewStart
			continue
		}
		if strings.HasPrefix(line, "diff --git ") {
			h = nil
			continue
		}
		switch {
		case strings.HasPrefix(line, "+"):
			h.Lines = append(h.Lines, Line{Type: "add", New: newN, Text: line[1:]})
			newN++
		case strings.HasPrefix(line, "-"):
			h.Lines = append(h.Lines, Line{Type: "del", Old: oldN, Text: line[1:]})
			oldN++
		case strings.HasPrefix(line, " "):
			h.Lines = append(h.Lines, Line{Type: "context", Old: oldN, New: newN, Text: line[1:]})
			oldN++
			newN++
		case strings.HasPrefix(line, `\`):
			if n := len(h.Lines); n > 0 {
				h.Lines[n-1].NoNewline = true
			}
		case line == "":
			// A context line whose single space was trimmed by a tool.
			h.Lines = append(h.Lines, Line{Type: "context", Old: oldN, New: newN})
			oldN++
			newN++
		}
	}
	return res
}

func parseHunkHeader(s string) (Hunk, bool) {
	// @@ -a[,b] +c[,d] @@ optional header
	rest := strings.TrimPrefix(s, "@@ ")
	end := strings.Index(rest, " @@")
	if end < 0 {
		return Hunk{}, false
	}
	header := strings.TrimSpace(rest[end+3:])
	f := strings.Fields(rest[:end])
	if len(f) != 2 || !strings.HasPrefix(f[0], "-") || !strings.HasPrefix(f[1], "+") {
		return Hunk{}, false
	}
	oa, ob := rangeOf(f[0][1:])
	na, nb := rangeOf(f[1][1:])
	return Hunk{OldStart: oa, OldLines: ob, NewStart: na, NewLines: nb, Header: header}, true
}

func rangeOf(s string) (start, n int) {
	a, b, found := strings.Cut(s, ",")
	start, _ = strconv.Atoi(a)
	if !found {
		return start, 1
	}
	n, _ = strconv.Atoi(b)
	return start, n
}

// BlobSizes returns the sizes of objects named by specs ("<commit>:<path>" or
// blob ids); a missing object has size -1.
func BlobSizes(ctx context.Context, dir string, specs []string) ([]int64, error) {
	sizes := make([]int64, len(specs))
	if len(specs) == 0 {
		return sizes, nil
	}
	var in bytes.Buffer
	for _, s := range specs {
		if strings.ContainsAny(s, "\n") {
			in.WriteString("\n")
			continue
		}
		in.WriteString(s + "\n")
	}
	out, err := RunIn(ctx, dir, &in, "cat-file", "--batch-check")
	if err != nil {
		return nil, err
	}
	lines := strings.Split(strings.TrimRight(string(out), "\n"), "\n")
	for i := range sizes {
		sizes[i] = -1
		if i >= len(lines) {
			continue
		}
		f := strings.Fields(lines[i])
		if len(f) == 3 && f[1] == "blob" {
			if n, err := strconv.ParseInt(f[2], 10, 64); err == nil {
				sizes[i] = n
			}
		}
	}
	return sizes, nil
}

// BlobHeads returns the first n bytes of each blob named by specs (nil for a
// missing one or one larger than maxSize).
func BlobHeads(ctx context.Context, dir string, specs []string, n int, maxSize int64) ([][]byte, error) {
	res := make([][]byte, len(specs))
	if len(specs) == 0 {
		return res, nil
	}
	var in bytes.Buffer
	for _, s := range specs {
		if strings.ContainsAny(s, "\n") {
			in.WriteString("\n")
			continue
		}
		in.WriteString(s + "\n")
	}
	out, err := RunIn(ctx, dir, &in, "cat-file", "--batch")
	if err != nil {
		return nil, err
	}
	r := bufio.NewReader(bytes.NewReader(out))
	for i := range specs {
		line, err := r.ReadString('\n')
		if err != nil {
			break
		}
		f := strings.Fields(line)
		if len(f) != 3 || f[1] != "blob" {
			continue
		}
		size, _ := strconv.ParseInt(f[2], 10, 64)
		take := size
		if take > int64(n) {
			take = int64(n)
		}
		buf := make([]byte, take)
		if _, err := io.ReadFull(r, buf); err != nil {
			break
		}
		if _, err := io.CopyN(io.Discard, r, size-take+1); err != nil {
			break
		}
		if size <= maxSize {
			res[i] = buf
		}
	}
	return res, nil
}

// ShowBlob returns the content of a blob (a commit and a path), refusing more
// than max bytes.
func ShowBlob(ctx context.Context, dir, commit, path string, max int64) ([]byte, error) {
	spec := commit + ":" + path
	sizes, err := BlobSizes(ctx, dir, []string{spec})
	if err != nil {
		return nil, err
	}
	if sizes[0] < 0 {
		return nil, ErrNoBlob
	}
	if sizes[0] > max {
		return nil, ErrBlobTooLarge
	}
	return Run(ctx, dir, "cat-file", "blob", spec)
}

// Sentinels of ShowBlob.
var (
	ErrNoBlob       = fmt.Errorf("no such file at that commit")
	ErrBlobTooLarge = fmt.Errorf("file too large")
)

// ChangedPaths lists the new-side paths that differ between two commits.
func ChangedPaths(ctx context.Context, dir, a, b string) (map[string]bool, error) {
	out, err := Run(ctx, dir, "diff", "--name-only", "-z", "--no-ext-diff", a, b, "--")
	if err != nil {
		return nil, err
	}
	res := map[string]bool{}
	for _, p := range strings.Split(string(out), "\x00") {
		if p != "" {
			res[p] = true
		}
	}
	return res, nil
}
