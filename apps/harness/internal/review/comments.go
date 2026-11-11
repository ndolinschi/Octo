package review

import (
	"context"
	"errors"
	"strings"

	"github.com/ndolinschi/Octo/apps/harness/internal/gitx"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

// MaxCommentBytes caps a comment body or suggestion.
const MaxCommentBytes = 64 << 10

// CommentInput creates a comment. Kind is derived: no path = general; a path
// without a line = file; Line (and StartLine for a range) = line or range.
type CommentInput struct {
	Path       string `json:"path,omitempty"`
	Side       string `json:"side,omitempty"` // new (default) or old
	Line       int    `json:"line,omitempty"`
	StartLine  int    `json:"start_line,omitempty"`
	Body       string `json:"body"`
	Suggestion string `json:"suggestion,omitempty"`
	// FindingID links a comment kept from a finding.
	FindingID string `json:"finding_id,omitempty"`
}

// CommentUpdate edits a pending comment (nil fields stay).
type CommentUpdate struct {
	Body       *string `json:"body,omitempty"`
	Suggestion *string `json:"suggestion,omitempty"`
	Line       *int    `json:"line,omitempty"`
	StartLine  *int    `json:"start_line,omitempty"`
	Side       *string `json:"side,omitempty"`
}

func kindOf(c projectstore.ReviewComment) string {
	switch {
	case c.Path == "":
		return "general"
	case c.Line == 0:
		return "file"
	case c.StartLine > 0 && c.StartLine < c.Line:
		return "range"
	}
	return "line"
}

// validate checks a comment against the review's diff.
func (s *Service) validate(ctx context.Context, db *projectstore.DB, r projectstore.Review, c *projectstore.ReviewComment) error {
	if len(c.Body) > MaxCommentBytes || len(c.Suggestion) > MaxCommentBytes {
		return &Error{Kind: KindTooLarge, Code: "comment_too_large", Message: "a comment may be at most 64 KiB"}
	}
	if strings.TrimSpace(c.Body) == "" && c.Suggestion == "" {
		return invalid("empty_comment", "a comment needs a body or a suggestion")
	}
	if c.Side == "" {
		c.Side = "new"
	}
	if c.Side != "new" && c.Side != "old" {
		return invalid("invalid_request", "side must be new or old")
	}
	if c.Line < 0 || c.StartLine < 0 {
		return invalid("invalid_request", "line numbers start at 1")
	}
	if c.Path == "" {
		if c.Line != 0 || c.StartLine != 0 || c.Suggestion != "" {
			return invalid("invalid_request", "a general comment has no path, line or suggestion")
		}
		c.Side = "new"
		c.Kind = "general"
		return nil
	}
	if _, ok := cleanPath(c.Path); !ok {
		return invalid("invalid_path", "invalid path")
	}
	if c.Line == 0 {
		if c.StartLine != 0 || c.Suggestion != "" {
			return invalid("invalid_request", "a file comment has no line or suggestion")
		}
	}
	if c.StartLine > c.Line && c.Line != 0 {
		return invalid("invalid_request", "start_line must not be after line")
	}
	if c.StartLine == c.Line {
		c.StartLine = 0
	}
	files, err := s.files(ctx, db, r)
	if err != nil {
		return err
	}
	f, ok := samePathSet(files, c.Path)
	if !ok {
		return invalid("path_not_in_diff", "%s is not changed in this review", c.Path)
	}
	if c.Side == "new" && f.Status == "deleted" || c.Side == "old" && f.Status == "added" {
		return invalid("invalid_side", "the file has no %s side", c.Side)
	}
	if c.Line > 0 {
		if f.Binary {
			return invalid("line_not_in_diff", "a binary file has no lines")
		}
		dir, err := s.repoDir(ctx, db, r)
		if err != nil {
			return err
		}
		res, err := gitx.FilePatch(ctx, dir, r.BaseCommit, r.HeadCommit, f.OldPath, f.Path, gitx.PatchOptions{Context: 3})
		if err != nil {
			return gitErr(err)
		}
		if !res.TooLarge {
			if !inDiff(res.Hunks, c.Side, c.Line) || c.StartLine > 0 && !inDiff(res.Hunks, c.Side, c.StartLine) {
				return invalid("line_not_in_diff", "the code host accepts comments only on lines inside a diff hunk; line %d of %s is outside every hunk", c.Line, c.Path)
			}
		}
	}
	c.Kind = kindOf(*c)
	return nil
}

func inDiff(hunks []gitx.Hunk, side string, line int) bool {
	for _, h := range hunks {
		for _, l := range h.Lines {
			switch {
			case side == "new" && l.Type != "del" && l.New == line:
				return true
			case side == "old" && l.Type != "add" && l.Old == line:
				return true
			}
		}
	}
	return false
}

// Comments lists a review's comments (pending and submitted), oldest first.
func (s *Service) Comments(ctx context.Context, pid, rid string) ([]projectstore.ReviewComment, error) {
	db, err := s.db(ctx, pid)
	if err != nil {
		return nil, err
	}
	if _, err := s.review(ctx, db, rid); err != nil {
		return nil, err
	}
	return db.Comments(ctx, rid, "")
}

// CreateComment adds a pending comment. Nothing is posted to the code host.
func (s *Service) CreateComment(ctx context.Context, pid, rid string, in CommentInput) (projectstore.ReviewComment, error) {
	db, err := s.db(ctx, pid)
	if err != nil {
		return projectstore.ReviewComment{}, err
	}
	r, err := s.review(ctx, db, rid)
	if err != nil {
		return projectstore.ReviewComment{}, err
	}
	if r.State == projectstore.ReviewClosed {
		return projectstore.ReviewComment{}, conflict("review_closed", "the review is closed; reopen it to comment")
	}
	c := projectstore.ReviewComment{ReviewID: rid, Path: in.Path, Side: in.Side, Line: in.Line, StartLine: in.StartLine,
		Body: in.Body, Suggestion: in.Suggestion, FindingID: in.FindingID}
	if err := s.validate(ctx, db, r, &c); err != nil {
		return c, err
	}
	out, err := db.AddComment(ctx, c)
	if err != nil {
		return out, err
	}
	_ = db.TouchReview(ctx, rid)
	s.publish(ctx, db, pid, r, "comment")
	return out, nil
}

// UpdateComment edits a pending comment.
func (s *Service) UpdateComment(ctx context.Context, pid, rid, cid string, u CommentUpdate) (projectstore.ReviewComment, error) {
	db, err := s.db(ctx, pid)
	if err != nil {
		return projectstore.ReviewComment{}, err
	}
	r, err := s.review(ctx, db, rid)
	if err != nil {
		return projectstore.ReviewComment{}, err
	}
	c, err := db.Comment(ctx, rid, cid)
	if errors.Is(err, projectstore.ErrNotFound) {
		return c, notFound("comment")
	}
	if err != nil {
		return c, err
	}
	if c.State != projectstore.CommentPending {
		return c, conflict("comment_submitted", "a submitted comment cannot be changed")
	}
	if u.Body != nil {
		c.Body = *u.Body
	}
	if u.Suggestion != nil {
		c.Suggestion = *u.Suggestion
	}
	if u.Line != nil {
		c.Line = *u.Line
	}
	if u.StartLine != nil {
		c.StartLine = *u.StartLine
	}
	if u.Side != nil {
		c.Side = *u.Side
	}
	if err := s.validate(ctx, db, r, &c); err != nil {
		return c, err
	}
	out, err := db.UpdateComment(ctx, rid, cid, projectstore.CommentPatch{
		Kind: &c.Kind, Side: &c.Side, Body: &c.Body, Suggestion: &c.Suggestion, Line: &c.Line, StartLine: &c.StartLine,
	})
	if err != nil {
		return out, err
	}
	_ = db.TouchReview(ctx, rid)
	s.publish(ctx, db, pid, r, "comment")
	return out, nil
}

// DeleteComment removes a pending comment.
func (s *Service) DeleteComment(ctx context.Context, pid, rid, cid string) error {
	db, err := s.db(ctx, pid)
	if err != nil {
		return err
	}
	r, err := s.review(ctx, db, rid)
	if err != nil {
		return err
	}
	if c, err := db.Comment(ctx, rid, cid); err == nil && c.State != projectstore.CommentPending {
		return conflict("comment_submitted", "a submitted comment cannot be deleted")
	}
	if err := db.DeleteComment(ctx, rid, cid); err != nil {
		if errors.Is(err, projectstore.ErrNotFound) {
			return notFound("comment")
		}
		return err
	}
	s.publish(ctx, db, pid, r, "comment")
	return nil
}

// Findings lists a review's findings by rank.
func (s *Service) Findings(ctx context.Context, pid, rid string) ([]projectstore.ReviewFinding, error) {
	db, err := s.db(ctx, pid)
	if err != nil {
		return nil, err
	}
	if _, err := s.review(ctx, db, rid); err != nil {
		return nil, err
	}
	return db.Findings(ctx, rid)
}

// AddFindings stores findings (the AI pass of RV3 uses it; there is no HTTP
// route that creates findings).
func (s *Service) AddFindings(ctx context.Context, pid, rid string, list []projectstore.ReviewFinding) ([]projectstore.ReviewFinding, error) {
	db, err := s.db(ctx, pid)
	if err != nil {
		return nil, err
	}
	r, err := s.review(ctx, db, rid)
	if err != nil {
		return nil, err
	}
	out := make([]projectstore.ReviewFinding, 0, len(list))
	for _, f := range list {
		f.ReviewID = rid
		g, err := db.AddFinding(ctx, f)
		if err != nil {
			return out, err
		}
		out = append(out, g)
	}
	s.publish(ctx, db, pid, r, "findings")
	return out, nil
}

// FindingDecision keeps, dismisses or resets a finding.
type FindingDecision struct {
	Status string `json:"status"` // kept, dismissed, new
	Reason string `json:"reason,omitempty"`
	// Body overrides the draft comment text of a kept finding.
	Body string `json:"body,omitempty"`
}

// FindingResult is a decided finding and, for a kept one, the pending comment made from it.
type FindingResult struct {
	Finding projectstore.ReviewFinding  `json:"finding"`
	Comment *projectstore.ReviewComment `json:"comment,omitempty"`
}

// DecideFinding records the user's decision. Keeping a finding makes a pending
// comment (the user's own, editable) from it; nothing is posted.
func (s *Service) DecideFinding(ctx context.Context, pid, rid, fid string, d FindingDecision) (FindingResult, error) {
	db, err := s.db(ctx, pid)
	if err != nil {
		return FindingResult{}, err
	}
	r, err := s.review(ctx, db, rid)
	if err != nil {
		return FindingResult{}, err
	}
	f, err := db.Finding(ctx, rid, fid)
	if errors.Is(err, projectstore.ErrNotFound) {
		return FindingResult{}, notFound("finding")
	}
	if err != nil {
		return FindingResult{}, err
	}
	switch d.Status {
	case projectstore.FindingKept, projectstore.FindingDismissed, projectstore.FindingNew:
	default:
		return FindingResult{}, invalid("invalid_request", "status must be kept, dismissed or new")
	}
	var res FindingResult
	if d.Status == projectstore.FindingKept && f.Status != projectstore.FindingKept {
		body := d.Body
		if body == "" {
			body = f.Statement
		}
		in := CommentInput{Path: f.Path, Body: body, Suggestion: f.Patch, FindingID: f.ID}
		if f.EndLine > 0 {
			in.Line, in.StartLine = f.EndLine, f.StartLine
			if in.StartLine >= in.Line {
				in.StartLine = 0
			}
		}
		c, err := s.CreateComment(ctx, pid, rid, in)
		if err != nil {
			return FindingResult{}, err
		}
		res.Comment = &c
	}
	reason := d.Reason
	if d.Status != projectstore.FindingDismissed {
		reason = ""
	}
	f, err = db.SetFindingStatus(ctx, rid, fid, d.Status, reason)
	if err != nil {
		return FindingResult{}, err
	}
	res.Finding = f
	s.publish(ctx, db, pid, r, "finding")
	return res, nil
}
