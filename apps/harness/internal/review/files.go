package review

import (
	"context"
	"errors"
	"strings"

	"github.com/ndolinschi/Octo/apps/harness/internal/gitx"
)

// File is one changed file of a review, in reading order.
type File struct {
	Path    string `json:"path"`
	OldPath string `json:"old_path,omitempty"` // set for a rename or copy
	// Status is added, modified, deleted, renamed, copied or typechange.
	Status  string `json:"status"`
	Added   int    `json:"added"`
	Removed int    `json:"removed"`
	Binary  bool   `json:"binary"`
	// Image is the content type of an image file ("" otherwise).
	Image   string `json:"image,omitempty"`
	OldSize int64  `json:"old_size"` // bytes before; -1 when the file did not exist
	NewSize int64  `json:"new_size"` // bytes after; -1 when deleted
	Blob    string `json:"blob,omitempty"`
	OldBlob string `json:"old_blob,omitempty"`
	// Similarity is the percentage of a rename or copy.
	Similarity int `json:"similarity,omitempty"`

	// Group is core, callers, tests, other or mechanical; Reason says why.
	Group  string `json:"group"`
	Reason string `json:"reason"`
	// Order is the position in the reading order (0 first).
	Order int `json:"order"`
	// Folded is true for files the UI should collapse (mechanical changes).
	Folded bool `json:"folded"`
	// Large marks a file whose diff is not sent as hunks (see FileDiff.TooLarge).
	Large bool `json:"large,omitempty"`

	Viewed             bool `json:"viewed"`
	ChangedSinceViewed bool `json:"changed_since_viewed"`
	// ChangedSinceSubmitted is set when the review was submitted before and the
	// file differs from the head that was submitted.
	ChangedSinceSubmitted bool `json:"changed_since_submitted"`
	PendingComments       int  `json:"pending_comments"`
	Findings              int  `json:"findings"`
}

// Files is the response of the file list.
type Files struct {
	Base       string `json:"base_commit"`
	Head       string `json:"head_commit"`
	Files      []File `json:"files"`
	Total      Totals `json:"totals"`
	ViewedN    int    `json:"viewed_count"`
	LargePR    bool   `json:"large_pr"`
	LastSubmit string `json:"last_submitted_head,omitempty"`
}

// Totals sum the diff.
type Totals struct {
	Files   int `json:"files"`
	Added   int `json:"added"`
	Removed int `json:"removed"`
	// Mechanical counts files folded away (lock files, generated, renames, formatting).
	Mechanical int `json:"mechanical"`
}

// Large pull-request thresholds from the design: above either, a pass reviews by groups.
const (
	LargeFiles = 60
	LargeLines = 3000
	// largeDiffLines: a single file whose diff has more changed lines than this is
	// reported as too large to send as hunks.
	largeDiffLines = 20000
)

// computeFiles lists and orders the files between two commits (no per-user state).
func computeFiles(ctx context.Context, dir, base, head string) ([]File, error) {
	raw, err := gitx.Diff(ctx, dir, base, head)
	if err != nil {
		return nil, err
	}
	files := make([]File, 0, len(raw))
	for _, r := range raw {
		f := File{
			Path: r.Path, OldPath: r.OldPath, Status: r.Status, Added: r.Added, Removed: r.Removed, Binary: r.Binary,
			Image: ImageType(r.Path), Blob: r.NewBlob, OldBlob: r.OldBlob, Similarity: r.Sim, OldSize: -1, NewSize: -1,
		}
		files = append(files, f)
	}
	if len(files) == 0 {
		return files, nil
	}

	// Sizes.
	var specs []string
	for _, f := range files {
		specs = append(specs, blobSpec(f.OldBlob), blobSpec(f.Blob))
	}
	if sizes, err := gitx.BlobSizes(ctx, dir, specs); err == nil {
		for i := range files {
			files[i].OldSize, files[i].NewSize = sizes[2*i], sizes[2*i+1]
		}
	}

	ws, _ := gitx.IgnoringWhitespace(ctx, dir, base, head)

	// Content sniffing for generated files: only text files that look like source.
	var sniff []int
	var sniffSpecs []string
	for i, f := range files {
		if f.Binary || f.Status == "deleted" || f.NewSize < 0 || isLockfile(f.Path) || isGeneratedPath(f.Path) {
			continue
		}
		sniff = append(sniff, i)
		sniffSpecs = append(sniffSpecs, f.Blob)
		if len(sniff) >= 500 {
			break
		}
	}
	generatedByContent := map[int]bool{}
	if heads, err := gitx.BlobHeads(ctx, dir, sniffSpecs, 1024, 1<<20); err == nil {
		for k, i := range sniff {
			if hasGeneratedMarker(heads[k]) {
				generatedByContent[i] = true
			}
		}
	}

	var cands []int
	for i := range files {
		f := &files[i]
		f.Group, f.Reason = classify(f, ws, generatedByContent[i])
		if f.Group == GroupCore {
			cands = append(cands, i)
		}
		f.Folded = f.Group == GroupMechanical
		if f.Added+f.Removed > largeDiffLines {
			f.Large = true
		}
	}
	if len(cands) >= 2 {
		if text, ok, err := gitx.ChangedText(ctx, dir, base, head); err == nil && ok {
			analyseCallers(files, cands, text)
		}
	}
	orderFiles(files)
	return files, nil
}

func blobSpec(blob string) string {
	if blob == "" {
		return "" // an empty line: reported as missing (-1)
	}
	return blob
}

func classify(f *File, ws map[string][2]int, generatedContent bool) (group, reason string) {
	p := f.Path
	switch {
	case isLockfile(p):
		return GroupMechanical, ReasonLockfile
	case isGeneratedPath(p) || generatedContent:
		return GroupMechanical, ReasonGenerated
	case f.Status == "renamed" && f.Similarity == 100 && f.Added == 0 && f.Removed == 0:
		return GroupMechanical, ReasonRename
	}
	if !f.Binary && (f.Added+f.Removed) > 0 && (f.Status == "modified" || f.Status == "renamed") {
		// git omits a file from the -w numstat when nothing but whitespace differs.
		if w, ok := ws[p]; ws != nil && (!ok || w[0] == 0 && w[1] == 0) {
			return GroupMechanical, ReasonFormatting
		}
	}
	switch {
	case isTestPath(p):
		return GroupTests, ReasonTest
	case f.Binary:
		return GroupOther, ReasonAsset
	}
	if r := otherReason(p); r != "" {
		return GroupOther, r
	}
	return GroupCore, ReasonCore
}

// FileDiff is the diff of one file.
type FileDiff struct {
	File
	Hunks []gitx.Hunk `json:"hunks"`
	// TooLarge: the diff was not read (no hunks); Binary files have no hunks either.
	TooLarge          bool `json:"too_large"`
	WhitespaceIgnored bool `json:"whitespace_ignored"`
	Context           int  `json:"context"`
	// Since is set when the diff is from a commit other than the review's base.
	Since string `json:"since,omitempty"`
}

// ErrNoFile says the path is not part of the review's diff.
var ErrNoFile = errors.New("file is not part of this review")

func samePathSet(files []File, p string) (File, bool) {
	for _, f := range files {
		if f.Path == p {
			return f, true
		}
	}
	return File{}, false
}

func cleanPath(p string) (string, bool) {
	if p == "" || strings.ContainsRune(p, 0) || strings.HasPrefix(p, "/") {
		return "", false
	}
	for _, seg := range strings.Split(p, "/") {
		if seg == ".." {
			return "", false
		}
	}
	return p, true
}
