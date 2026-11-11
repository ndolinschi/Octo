package review

import (
	"context"
	"encoding/json"
	"sort"
	"strings"

	"github.com/ndolinschi/Octo/apps/harness/internal/codehost"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

// SubmitRequest is the user's explicit decision to post.
type SubmitRequest struct {
	// Verdict is comment, approve or request_changes.
	Verdict string `json:"verdict"`
	// Body is the review's summary text (optional).
	Body string `json:"body,omitempty"`
	// CommentIDs, when given, must be exactly the pending comments: it makes the
	// call fail with 409 comments_changed when the user's summary is out of date.
	CommentIDs []string `json:"comment_ids,omitempty"`
}

// Preview is what a submit would post, word for word.
type Preview struct {
	Verdict  string                       `json:"verdict"`
	Body     string                       `json:"body"`
	Comments []projectstore.ReviewComment `json:"comments"`
	// Payload is the exact JSON sent to the code host (GitHub), "" for a local review.
	Payload json.RawMessage `json:"payload,omitempty"`
	// Posts is false for a local review: submit marks the comments submitted and posts nowhere.
	Posts      bool   `json:"posts"`
	HeadCommit string `json:"head_commit"`
}

// SubmitResult is the outcome of a submit.
type SubmitResult struct {
	Preview
	Posted       bool   `json:"posted"`
	SubmissionID string `json:"submission_id"`
	URL          string `json:"url,omitempty"`
	Review       View   `json:"review"`
}

// compose builds what would be posted from the pending comments.
func (s *Service) compose(ctx context.Context, db *projectstore.DB, r projectstore.Review, req SubmitRequest) (codehost.Review, []projectstore.ReviewComment, error) {
	var zero codehost.Review
	if !codehost.ValidVerdict(req.Verdict) {
		return zero, nil, invalid("invalid_verdict", "verdict must be comment, approve or request_changes")
	}
	if len(req.Body) > MaxCommentBytes {
		return zero, nil, &Error{Kind: KindTooLarge, Code: "comment_too_large", Message: "the review body may be at most 64 KiB"}
	}
	pending, err := db.Comments(ctx, r.ID, projectstore.CommentPending)
	if err != nil {
		return zero, nil, err
	}
	if req.CommentIDs != nil {
		want, have := append([]string(nil), req.CommentIDs...), make([]string, 0, len(pending))
		for _, c := range pending {
			have = append(have, c.ID)
		}
		sort.Strings(want)
		sort.Strings(have)
		if strings.Join(want, ",") != strings.Join(have, ",") {
			return zero, nil, conflict("comments_changed", "the pending comments changed since the summary was shown; review them again")
		}
	}
	out := codehost.Review{Verdict: req.Verdict, CommitID: r.HeadCommit, Comments: []codehost.ReviewComment{}}
	body := []string{}
	if t := strings.TrimSpace(req.Body); t != "" {
		body = append(body, req.Body)
	}
	for _, c := range pending {
		if c.Kind == "general" {
			body = append(body, c.Body)
			continue
		}
		out.Comments = append(out.Comments, codehost.ReviewComment{
			Path: c.Path, Line: c.Line, StartLine: c.StartLine, Side: c.Side, Body: c.Body, Suggestion: c.Suggestion,
		})
	}
	out.Body = strings.Join(body, "\n\n")
	if len(out.Comments) == 0 && out.Body == "" && req.Verdict != codehost.VerdictApprove {
		return zero, nil, invalid("empty_review", "there is nothing to post: add a comment or a summary, or approve")
	}
	return out, pending, nil
}

// SubmitPreview returns what Submit would post. It posts nothing.
func (s *Service) SubmitPreview(ctx context.Context, pid, rid string, req SubmitRequest) (Preview, error) {
	db, err := s.db(ctx, pid)
	if err != nil {
		return Preview{}, err
	}
	r, err := s.review(ctx, db, rid)
	if err != nil {
		return Preview{}, err
	}
	rv, pending, err := s.compose(ctx, db, r, req)
	if err != nil {
		return Preview{}, err
	}
	p := Preview{Verdict: rv.Verdict, Body: rv.Body, Comments: pending, Posts: r.Kind == "github", HeadCommit: r.HeadCommit}
	if p.Posts {
		if b, err := codehost.Payload(rv); err == nil {
			p.Payload = b
		}
	}
	return p, nil
}

// Submit posts the pending comments and the verdict as one review through the
// code host. This is the only place in the harness that writes to a code host;
// it runs only when the user's HTTP call for it arrives. A failed post leaves
// every comment pending. A local review posts nowhere: the comments are marked
// submitted and returned.
func (s *Service) Submit(ctx context.Context, pid, rid string, req SubmitRequest) (SubmitResult, error) {
	db, err := s.db(ctx, pid)
	if err != nil {
		return SubmitResult{}, err
	}
	unlock := s.lock(rid)
	defer unlock()
	r, err := s.review(ctx, db, rid)
	if err != nil {
		return SubmitResult{}, err
	}
	if r.State == projectstore.ReviewClosed {
		return SubmitResult{}, conflict("review_closed", "the review is closed; reopen it to submit")
	}
	rv, pending, err := s.compose(ctx, db, r, req)
	if err != nil {
		return SubmitResult{}, err
	}
	res := SubmitResult{SubmissionID: projectstore.NewID("sub")}
	res.Preview = Preview{Verdict: rv.Verdict, Body: rv.Body, Comments: pending, Posts: r.Kind == "github", HeadCommit: r.HeadCommit}
	if res.Posts {
		if s.host == nil {
			return SubmitResult{}, conflict("no_host", "no code host is configured")
		}
		repo, ok := parseRepo(r.Repo)
		if !ok {
			return SubmitResult{}, conflict("invalid_review", "review has no repository")
		}
		_, dir, err := s.folder(ctx, db, r.Folder)
		if err != nil {
			return SubmitResult{}, err
		}
		if b, err := codehost.Payload(rv); err == nil {
			res.Payload = b
		}
		posted, err := s.host.PostReview(ctx, dir, repo, r.Number, rv)
		if err != nil {
			return SubmitResult{}, hostErr(err)
		}
		res.Posted, res.URL = true, posted.URL
	}
	ids := make([]string, 0, len(pending))
	for _, c := range pending {
		ids = append(ids, c.ID)
	}
	if err := db.MarkSubmitted(ctx, rid, ids, res.SubmissionID, r.HeadCommit); err != nil {
		return SubmitResult{}, err
	}
	for i := range res.Comments {
		res.Comments[i].State = projectstore.CommentSubmitted
		res.Comments[i].SubmissionID = res.SubmissionID
	}
	cur, err := db.Review(ctx, rid)
	if err != nil {
		return res, err
	}
	s.invalidate(rid)
	res.Review, _ = s.view(ctx, db, cur)
	s.publish(ctx, db, pid, cur, "submitted")
	return res, nil
}
