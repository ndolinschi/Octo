package review

import (
	"context"
	"errors"
	"mime"
	"path"

	"github.com/ndolinschi/Octo/apps/harness/internal/gitx"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

func (s *Service) invalidate(rid string) {
	s.mu.Lock()
	delete(s.cache, rid)
	s.mu.Unlock()
}

// repoDir is the repository the review's objects live in.
func (s *Service) repoDir(ctx context.Context, db *projectstore.DB, r projectstore.Review) (string, error) {
	_, dir, err := s.folder(ctx, db, r.Folder)
	return dir, err
}

// files returns the ordered file list of a review (cached per base and head).
func (s *Service) files(ctx context.Context, db *projectstore.DB, r projectstore.Review) ([]File, error) {
	key := r.BaseCommit + ".." + r.HeadCommit
	s.mu.Lock()
	if c, ok := s.cache[r.ID]; ok && c.key == key {
		s.mu.Unlock()
		return append([]File(nil), c.files...), nil
	}
	s.mu.Unlock()
	dir, err := s.repoDir(ctx, db, r)
	if err != nil {
		return nil, err
	}
	files, err := computeFiles(ctx, dir, r.BaseCommit, r.HeadCommit)
	if err != nil {
		return nil, gitErr(err)
	}
	s.mu.Lock()
	s.cache[r.ID] = cachedFiles{key: key, files: files}
	s.mu.Unlock()
	return append([]File(nil), files...), nil
}

// overlay adds the per-user state: viewed marks, pending comments, findings,
// and what changed since the last submitted review.
func (s *Service) overlay(ctx context.Context, db *projectstore.DB, r projectstore.Review, files []File) error {
	marks, err := db.Viewed(ctx, r.ID)
	if err != nil {
		return err
	}
	comments, err := db.Comments(ctx, r.ID, projectstore.CommentPending)
	if err != nil {
		return err
	}
	findings, err := db.Findings(ctx, r.ID)
	if err != nil {
		return err
	}
	pend := map[string]int{}
	for _, c := range comments {
		if c.Path != "" {
			pend[c.Path]++
		}
	}
	fnd := map[string]int{}
	for _, f := range findings {
		if f.Status != projectstore.FindingDismissed {
			fnd[f.Path]++
		}
	}
	var changedSince map[string]bool
	if r.LastSubmittedHead != "" && r.LastSubmittedHead != r.HeadCommit {
		if dir, err := s.repoDir(ctx, db, r); err == nil {
			// Paths that differ between what was submitted and the head now.
			changedSince, _ = gitx.ChangedPaths(ctx, dir, r.LastSubmittedHead, r.HeadCommit)
		}
	}
	for i := range files {
		f := &files[i]
		if m, ok := marks[f.Path]; ok {
			if m.Blob == f.Blob {
				f.Viewed = true
			} else {
				f.ChangedSinceViewed = true
			}
		}
		f.PendingComments = pend[f.Path]
		f.Findings = fnd[f.Path]
		f.ChangedSinceSubmitted = changedSince[f.Path]
	}
	return nil
}

// Files lists the review's changed files in reading order.
func (s *Service) Files(ctx context.Context, pid, rid string) (Files, error) {
	db, err := s.db(ctx, pid)
	if err != nil {
		return Files{}, err
	}
	r, err := s.review(ctx, db, rid)
	if err != nil {
		return Files{}, err
	}
	_ = db.TouchReview(ctx, rid)
	files, err := s.files(ctx, db, r)
	if err != nil {
		return Files{}, err
	}
	if err := s.overlay(ctx, db, r, files); err != nil {
		return Files{}, err
	}
	out := Files{Base: r.BaseCommit, Head: r.HeadCommit, Files: files, Total: totalsOf(files), LastSubmit: r.LastSubmittedHead}
	if out.Files == nil {
		out.Files = []File{}
	}
	for _, f := range files {
		if f.Viewed {
			out.ViewedN++
		}
	}
	out.LargePR = out.Total.Files > LargeFiles || out.Total.Added+out.Total.Removed > LargeLines
	return out, nil
}

// DiffOptions tune FileDiff.
type DiffOptions struct {
	Context          int  // lines of context (default 3, max 1000)
	IgnoreWhitespace bool // -w
	// Since, when set, diffs from that commit instead of the review's base
	// (use last_submitted_head to see only what changed since the review).
	Since string
}

// FileDiff returns the hunks of one file of the review.
func (s *Service) FileDiff(ctx context.Context, pid, rid, p string, o DiffOptions) (FileDiff, error) {
	db, err := s.db(ctx, pid)
	if err != nil {
		return FileDiff{}, err
	}
	r, err := s.review(ctx, db, rid)
	if err != nil {
		return FileDiff{}, err
	}
	if _, ok := cleanPath(p); !ok {
		return FileDiff{}, invalid("invalid_path", "invalid path")
	}
	files, err := s.files(ctx, db, r)
	if err != nil {
		return FileDiff{}, err
	}
	if err := s.overlay(ctx, db, r, files); err != nil {
		return FileDiff{}, err
	}
	f, ok := samePathSet(files, p)
	if !ok {
		return FileDiff{}, notFound("file")
	}
	_ = db.TouchReview(ctx, rid)
	dir, err := s.repoDir(ctx, db, r)
	if err != nil {
		return FileDiff{}, err
	}
	ctxLines := o.Context
	switch {
	case ctxLines <= 0:
		ctxLines = 3
	case ctxLines > 1000:
		ctxLines = 1000
	}
	base, oldPath := r.BaseCommit, f.OldPath
	out := FileDiff{File: f, Hunks: []gitx.Hunk{}, WhitespaceIgnored: o.IgnoreWhitespace, Context: ctxLines}
	if o.Since != "" {
		c, err := gitx.Resolve(ctx, dir, o.Since)
		if err != nil {
			return FileDiff{}, invalid("unknown_ref", "unknown commit %q", o.Since)
		}
		base, oldPath, out.Since = c, "", c
	}
	if f.Binary {
		return out, nil
	}
	res, err := gitx.FilePatch(ctx, dir, base, r.HeadCommit, oldPath, f.Path, gitx.PatchOptions{Context: ctxLines, IgnoreWhitespace: o.IgnoreWhitespace})
	if err != nil {
		return FileDiff{}, gitErr(err)
	}
	out.TooLarge, out.Binary = res.TooLarge, f.Binary || res.Binary
	if res.Hunks != nil {
		out.Hunks = res.Hunks
	}
	return out, nil
}

// MaxRaw caps a raw blob download (an image next to its diff).
const MaxRaw = 10 << 20

// Raw is the content of a file at the review's head ("new") or base ("old").
func (s *Service) Raw(ctx context.Context, pid, rid, p, side string) ([]byte, string, error) {
	db, err := s.db(ctx, pid)
	if err != nil {
		return nil, "", err
	}
	r, err := s.review(ctx, db, rid)
	if err != nil {
		return nil, "", err
	}
	files, err := s.files(ctx, db, r)
	if err != nil {
		return nil, "", err
	}
	f, ok := samePathSet(files, p)
	if !ok {
		return nil, "", notFound("file")
	}
	dir, err := s.repoDir(ctx, db, r)
	if err != nil {
		return nil, "", err
	}
	commit, name := r.HeadCommit, f.Path
	switch side {
	case "new", "head", "":
		if f.Status == "deleted" {
			return nil, "", notFound("file")
		}
	case "old", "base":
		if f.Status == "added" {
			return nil, "", notFound("file")
		}
		commit = r.BaseCommit
		if f.OldPath != "" {
			name = f.OldPath
		}
	default:
		return nil, "", invalid("invalid_request", "side must be new or old")
	}
	b, err := gitx.ShowBlob(ctx, dir, commit, name, MaxRaw)
	switch {
	case errors.Is(err, gitx.ErrNoBlob):
		return nil, "", notFound("file")
	case errors.Is(err, gitx.ErrBlobTooLarge):
		return nil, "", &Error{Kind: KindTooLarge, Code: "file_too_large", Message: "file is larger than 10 MiB"}
	case err != nil:
		return nil, "", gitErr(err)
	}
	ct := ImageType(f.Path)
	if ct == "" {
		ct = mime.TypeByExtension(path.Ext(f.Path))
	}
	if ct == "" {
		ct = "application/octet-stream"
	}
	return b, ct, nil
}

// SetViewed marks a file viewed (at the head's version of it) or clears the mark.
func (s *Service) SetViewed(ctx context.Context, pid, rid, p string, viewed bool) (File, error) {
	db, err := s.db(ctx, pid)
	if err != nil {
		return File{}, err
	}
	r, err := s.review(ctx, db, rid)
	if err != nil {
		return File{}, err
	}
	files, err := s.files(ctx, db, r)
	if err != nil {
		return File{}, err
	}
	f, ok := samePathSet(files, p)
	if !ok {
		return File{}, notFound("file")
	}
	if viewed {
		err = db.SetViewed(ctx, rid, f.Path, f.Blob, r.HeadCommit)
	} else {
		err = db.ClearViewed(ctx, rid, f.Path)
	}
	if err != nil {
		return File{}, err
	}
	_ = db.TouchReview(ctx, rid)
	one := []File{f}
	if err := s.overlay(ctx, db, r, one); err != nil {
		return File{}, err
	}
	if cur, err := db.Review(ctx, rid); err == nil {
		s.publish(ctx, db, pid, cur, "viewed")
	}
	return one[0], nil
}
