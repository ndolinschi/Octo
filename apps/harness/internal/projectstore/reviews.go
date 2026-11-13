package projectstore

import (
	"context"
	"database/sql"
	"strconv"
)

// Review is one pull-request (or local branch) review of a project. Title,
// Body and everything in MetaJSON came from a code host or a person and are
// untrusted text: they are stored and returned as data, never interpreted.
type Review struct {
	ID     string `json:"id"`
	Source string `json:"source"` // github:owner/repo#n or local:base..head
	Kind   string `json:"kind"`   // github, local
	// Folder is the label of the project folder whose repository is reviewed.
	Folder string `json:"folder"`
	Repo   string `json:"repo,omitempty"`
	Number int    `json:"number,omitempty"`
	Title  string `json:"title"`
	Body   string `json:"body"`
	Author string `json:"author,omitempty"`
	URL    string `json:"url,omitempty"`

	BaseRef    string `json:"base_ref"`
	HeadRef    string `json:"head_ref"`
	BaseCommit string `json:"base_commit"`
	HeadCommit string `json:"head_commit"`

	WorktreePath      string `json:"worktree_path"`
	State             string `json:"state"` // open, closed
	LastSubmittedHead string `json:"last_submitted_head,omitempty"`
	LastSubmittedAt   string `json:"last_submitted_at,omitempty"`
	MetaJSON          string `json:"-"`
	CreatedAt         string `json:"created_at"`
	UpdatedAt         string `json:"updated_at"`
	LastUsedAt        string `json:"last_used_at"`
}

// Review states.
const (
	ReviewOpen   = "open"
	ReviewClosed = "closed"
)

// ReviewPatch holds the fields UpdateReview changes (nil leaves a field alone).
type ReviewPatch struct {
	Title, Body, Author, URL                     *string
	BaseRef, HeadRef, BaseCommit, HeadCommit     *string
	WorktreePath, State                          *string
	LastSubmittedHead, LastSubmittedAt, MetaJSON *string
	// Touch sets last_used_at to now.
	Touch bool
}

const reviewCols = `id, source, kind, folder, repo, number, title, body, author, url, base_ref, head_ref, base_commit, head_commit,
	worktree_path, state, last_submitted_head, last_submitted_at, meta_json, created_at, updated_at, last_used_at`

func scanReview(r scanner) (Review, error) {
	var v Review
	err := r.Scan(&v.ID, &v.Source, &v.Kind, &v.Folder, &v.Repo, &v.Number, &v.Title, &v.Body, &v.Author, &v.URL,
		&v.BaseRef, &v.HeadRef, &v.BaseCommit, &v.HeadCommit, &v.WorktreePath, &v.State,
		&v.LastSubmittedHead, &v.LastSubmittedAt, &v.MetaJSON, &v.CreatedAt, &v.UpdatedAt, &v.LastUsedAt)
	return v, err
}

// CreateReview inserts r (ID and timestamps are filled in).
func (d *DB) CreateReview(ctx context.Context, r Review) (Review, error) {
	now := Now()
	r.ID, r.CreatedAt, r.UpdatedAt, r.LastUsedAt = NewID("rev"), now, now, now
	if r.State == "" {
		r.State = ReviewOpen
	}
	if r.MetaJSON == "" {
		r.MetaJSON = "{}"
	}
	_, err := d.sql.ExecContext(ctx, `INSERT INTO reviews (`+reviewCols+`) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		r.ID, r.Source, r.Kind, r.Folder, r.Repo, r.Number, r.Title, r.Body, r.Author, r.URL, r.BaseRef, r.HeadRef, r.BaseCommit, r.HeadCommit,
		r.WorktreePath, r.State, r.LastSubmittedHead, r.LastSubmittedAt, r.MetaJSON, r.CreatedAt, r.UpdatedAt, r.LastUsedAt)
	return r, err
}

// Review returns one review.
func (d *DB) Review(ctx context.Context, id string) (Review, error) {
	r, err := scanReview(d.sql.QueryRowContext(ctx, `SELECT `+reviewCols+` FROM reviews WHERE id = ?`, id))
	if err == sql.ErrNoRows {
		return r, ErrNotFound
	}
	return r, err
}

// Reviews lists reviews, most recently used first; state "" means all.
func (d *DB) Reviews(ctx context.Context, state string) ([]Review, error) {
	q := `SELECT ` + reviewCols + ` FROM reviews`
	var args []any
	if state != "" {
		q += ` WHERE state = ?`
		args = append(args, state)
	}
	q += ` ORDER BY last_used_at DESC, rowid DESC`
	rows, err := d.sql.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Review{}
	for rows.Next() {
		r, err := scanReview(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// OpenReviewBySource finds the open review of a source, if any.
func (d *DB) OpenReviewBySource(ctx context.Context, source string) (Review, error) {
	r, err := scanReview(d.sql.QueryRowContext(ctx,
		`SELECT `+reviewCols+` FROM reviews WHERE source = ? AND state = 'open' ORDER BY created_at DESC LIMIT 1`, source))
	if err == sql.ErrNoRows {
		return r, ErrNotFound
	}
	return r, err
}

// UpdateReview applies a patch and returns the review.
func (d *DB) UpdateReview(ctx context.Context, id string, p ReviewPatch) (Review, error) {
	set := newSetter()
	set.str("title", p.Title)
	set.str("body", p.Body)
	set.str("author", p.Author)
	set.str("url", p.URL)
	set.str("base_ref", p.BaseRef)
	set.str("head_ref", p.HeadRef)
	set.str("base_commit", p.BaseCommit)
	set.str("head_commit", p.HeadCommit)
	set.str("worktree_path", p.WorktreePath)
	set.str("state", p.State)
	set.str("last_submitted_head", p.LastSubmittedHead)
	set.str("last_submitted_at", p.LastSubmittedAt)
	set.str("meta_json", p.MetaJSON)
	now := Now()
	set.add("updated_at", now)
	if p.Touch {
		set.add("last_used_at", now)
	}
	if err := set.exec(ctx, d.sql, "reviews", "id = ?", id); err != nil {
		return Review{}, err
	}
	return d.Review(ctx, id)
}

// TouchReview records that the review was used.
func (d *DB) TouchReview(ctx context.Context, id string) error {
	_, err := d.sql.ExecContext(ctx, `UPDATE reviews SET last_used_at = ? WHERE id = ?`, Now(), id)
	return err
}

// ReviewViewed is a "viewed" mark: the file's head blob when it was viewed.
type ReviewViewed struct {
	Path       string `json:"path"`
	Blob       string `json:"blob"`
	HeadCommit string `json:"head_commit"`
	ViewedAt   string `json:"viewed_at"`
}

// SetViewed marks a file viewed at the given blob and head commit.
func (d *DB) SetViewed(ctx context.Context, reviewID, path, blob, head string) error {
	_, err := d.sql.ExecContext(ctx, `INSERT INTO review_viewed (review_id, path, blob, head_commit, viewed_at) VALUES (?,?,?,?,?)
		ON CONFLICT(review_id, path) DO UPDATE SET blob = excluded.blob, head_commit = excluded.head_commit, viewed_at = excluded.viewed_at`,
		reviewID, path, blob, head, Now())
	return err
}

// ClearViewed removes a viewed mark.
func (d *DB) ClearViewed(ctx context.Context, reviewID, path string) error {
	_, err := d.sql.ExecContext(ctx, `DELETE FROM review_viewed WHERE review_id = ? AND path = ?`, reviewID, path)
	return err
}

// Viewed returns the marks of a review by path.
func (d *DB) Viewed(ctx context.Context, reviewID string) (map[string]ReviewViewed, error) {
	rows, err := d.sql.QueryContext(ctx, `SELECT path, blob, head_commit, viewed_at FROM review_viewed WHERE review_id = ?`, reviewID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]ReviewViewed{}
	for rows.Next() {
		var v ReviewViewed
		if err := rows.Scan(&v.Path, &v.Blob, &v.HeadCommit, &v.ViewedAt); err != nil {
			return nil, err
		}
		out[v.Path] = v
	}
	return out, rows.Err()
}

// ReviewFinding is one finding of the AI pass (RV3 fills them; RV1 stores them).
type ReviewFinding struct {
	ID        string `json:"id"`
	ReviewID  string `json:"review_id"`
	Path      string `json:"path"`
	StartLine int    `json:"start_line"`
	EndLine   int    `json:"end_line"`
	Severity  string `json:"severity"` // critical, high, medium, low, info
	Statement string `json:"statement"`
	Scenario  string `json:"scenario,omitempty"`
	Patch     string `json:"patch,omitempty"`
	Evidence  string `json:"evidence,omitempty"`
	// Verdict is the verifier's: confirmed, plausible or "" (not verified yet).
	Verdict       string `json:"verdict,omitempty"`
	Rank          int    `json:"rank"`
	Status        string `json:"status"` // new, kept, dismissed
	DismissReason string `json:"dismiss_reason,omitempty"`
	CreatedAt     string `json:"created_at"`
	UpdatedAt     string `json:"updated_at"`
}

// Finding statuses.
const (
	FindingNew       = "new"
	FindingKept      = "kept"
	FindingDismissed = "dismissed"
)

const findingCols = `id, review_id, path, start_line, end_line, severity, statement, scenario, patch, evidence, verdict, rank, status, dismiss_reason, created_at, updated_at`

func scanFinding(r scanner) (ReviewFinding, error) {
	var f ReviewFinding
	err := r.Scan(&f.ID, &f.ReviewID, &f.Path, &f.StartLine, &f.EndLine, &f.Severity, &f.Statement, &f.Scenario, &f.Patch,
		&f.Evidence, &f.Verdict, &f.Rank, &f.Status, &f.DismissReason, &f.CreatedAt, &f.UpdatedAt)
	return f, err
}

// AddFinding stores a finding of a review.
func (d *DB) AddFinding(ctx context.Context, f ReviewFinding) (ReviewFinding, error) {
	now := Now()
	f.ID, f.CreatedAt, f.UpdatedAt = NewID("fnd"), now, now
	if f.Status == "" {
		f.Status = FindingNew
	}
	if f.Severity == "" {
		f.Severity = "info"
	}
	_, err := d.sql.ExecContext(ctx, `INSERT INTO review_findings (`+findingCols+`) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		f.ID, f.ReviewID, f.Path, f.StartLine, f.EndLine, f.Severity, f.Statement, f.Scenario, f.Patch, f.Evidence, f.Verdict,
		f.Rank, f.Status, f.DismissReason, f.CreatedAt, f.UpdatedAt)
	return f, err
}

// Findings lists a review's findings by rank, then creation.
func (d *DB) Findings(ctx context.Context, reviewID string) ([]ReviewFinding, error) {
	rows, err := d.sql.QueryContext(ctx, `SELECT `+findingCols+` FROM review_findings WHERE review_id = ? ORDER BY rank, created_at, rowid`, reviewID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ReviewFinding{}
	for rows.Next() {
		f, err := scanFinding(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

// Finding returns one finding of a review.
func (d *DB) Finding(ctx context.Context, reviewID, id string) (ReviewFinding, error) {
	f, err := scanFinding(d.sql.QueryRowContext(ctx, `SELECT `+findingCols+` FROM review_findings WHERE review_id = ? AND id = ?`, reviewID, id))
	if err == sql.ErrNoRows {
		return f, ErrNotFound
	}
	return f, err
}

// SetFindingStatus records keep or dismiss (with the reason).
func (d *DB) SetFindingStatus(ctx context.Context, reviewID, id, status, reason string) (ReviewFinding, error) {
	res, err := d.sql.ExecContext(ctx, `UPDATE review_findings SET status = ?, dismiss_reason = ?, updated_at = ? WHERE review_id = ? AND id = ?`,
		status, reason, Now(), reviewID, id)
	if err != nil {
		return ReviewFinding{}, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ReviewFinding{}, ErrNotFound
	}
	return d.Finding(ctx, reviewID, id)
}

// ReviewComment is a comment of the user's review. It stays pending until a
// submit posts it.
type ReviewComment struct {
	ID       string `json:"id"`
	ReviewID string `json:"review_id"`
	// Kind is line, range, file, general or reply.
	Kind       string `json:"kind"`
	Path       string `json:"path,omitempty"`
	Side       string `json:"side,omitempty"` // new (default) or old
	Line       int    `json:"line,omitempty"`
	StartLine  int    `json:"start_line,omitempty"`
	Body       string `json:"body"`
	Suggestion string `json:"suggestion,omitempty"`
	// FindingID is set when the comment was kept from a finding.
	FindingID string `json:"finding_id,omitempty"`
	// InReplyTo is the id of the review thread (of the code host) this comment replies to; Kind is then "reply".
	InReplyTo    string `json:"in_reply_to,omitempty"`
	State        string `json:"state"` // pending, submitted
	SubmissionID string `json:"submission_id,omitempty"`
	CreatedAt    string `json:"created_at"`
	UpdatedAt    string `json:"updated_at"`
	SubmittedAt  string `json:"submitted_at,omitempty"`
}

// Comment states.
const (
	CommentPending   = "pending"
	CommentSubmitted = "submitted"
)

const commentCols = `id, review_id, kind, path, side, line, start_line, body, suggestion, finding_id, in_reply_to, state, submission_id, created_at, updated_at, submitted_at`

func scanComment(r scanner) (ReviewComment, error) {
	var c ReviewComment
	err := r.Scan(&c.ID, &c.ReviewID, &c.Kind, &c.Path, &c.Side, &c.Line, &c.StartLine, &c.Body, &c.Suggestion, &c.FindingID, &c.InReplyTo,
		&c.State, &c.SubmissionID, &c.CreatedAt, &c.UpdatedAt, &c.SubmittedAt)
	return c, err
}

// AddComment stores a pending comment.
func (d *DB) AddComment(ctx context.Context, c ReviewComment) (ReviewComment, error) {
	now := Now()
	c.ID, c.CreatedAt, c.UpdatedAt, c.State = NewID("rcm"), now, now, CommentPending
	_, err := d.sql.ExecContext(ctx, `INSERT INTO review_comments (`+commentCols+`) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		c.ID, c.ReviewID, c.Kind, c.Path, c.Side, c.Line, c.StartLine, c.Body, c.Suggestion, c.FindingID, c.InReplyTo, c.State, c.SubmissionID,
		c.CreatedAt, c.UpdatedAt, c.SubmittedAt)
	return c, err
}

// Comments lists a review's comments in creation order; state "" means all.
func (d *DB) Comments(ctx context.Context, reviewID, state string) ([]ReviewComment, error) {
	q := `SELECT ` + commentCols + ` FROM review_comments WHERE review_id = ?`
	args := []any{reviewID}
	if state != "" {
		q += ` AND state = ?`
		args = append(args, state)
	}
	q += ` ORDER BY created_at, rowid`
	rows, err := d.sql.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ReviewComment{}
	for rows.Next() {
		c, err := scanComment(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// Comment returns one comment of a review.
func (d *DB) Comment(ctx context.Context, reviewID, id string) (ReviewComment, error) {
	c, err := scanComment(d.sql.QueryRowContext(ctx, `SELECT `+commentCols+` FROM review_comments WHERE review_id = ? AND id = ?`, reviewID, id))
	if err == sql.ErrNoRows {
		return c, ErrNotFound
	}
	return c, err
}

// CommentPatch holds the fields UpdateComment changes.
type CommentPatch struct {
	Kind, Path, Side, Body, Suggestion *string
	Line, StartLine                    *int
}

// UpdateComment edits a pending comment.
func (d *DB) UpdateComment(ctx context.Context, reviewID, id string, p CommentPatch) (ReviewComment, error) {
	set := newSetter()
	set.str("kind", p.Kind)
	set.str("path", p.Path)
	set.str("side", p.Side)
	set.str("body", p.Body)
	set.str("suggestion", p.Suggestion)
	if p.Line != nil {
		set.add("line", *p.Line)
	}
	if p.StartLine != nil {
		set.add("start_line", *p.StartLine)
	}
	set.add("updated_at", Now())
	if err := set.exec(ctx, d.sql, "review_comments", "review_id = ? AND id = ? AND state = 'pending'", reviewID, id); err != nil {
		return ReviewComment{}, err
	}
	return d.Comment(ctx, reviewID, id)
}

// DeleteComment removes a pending comment.
func (d *DB) DeleteComment(ctx context.Context, reviewID, id string) error {
	res, err := d.sql.ExecContext(ctx, `DELETE FROM review_comments WHERE review_id = ? AND id = ? AND state = 'pending'`, reviewID, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// PendingComments counts the comments a review has not submitted.
func (d *DB) PendingComments(ctx context.Context, reviewID string) (int, error) {
	var n int
	err := d.sql.QueryRowContext(ctx, `SELECT COUNT(*) FROM review_comments WHERE review_id = ? AND state = 'pending'`, reviewID).Scan(&n)
	return n, err
}

// MarkSubmitted marks the given pending comments submitted and records the
// head they were submitted against, atomically.
func (d *DB) MarkSubmitted(ctx context.Context, reviewID string, ids []string, submissionID, head string) error {
	tx, err := d.sql.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	now := Now()
	for _, id := range ids {
		if _, err := tx.ExecContext(ctx, `UPDATE review_comments SET state = 'submitted', submission_id = ?, submitted_at = ?, updated_at = ?
			WHERE review_id = ? AND id = ? AND state = 'pending'`, submissionID, now, now, reviewID, id); err != nil {
			return err
		}
	}
	if _, err := tx.ExecContext(ctx, `UPDATE reviews SET last_submitted_head = ?, last_submitted_at = ?, updated_at = ?, last_used_at = ? WHERE id = ?`,
		head, now, now, now, reviewID); err != nil {
		return err
	}
	return tx.Commit()
}

// DeleteReview removes a review with its viewed marks, findings and comments.
func (d *DB) DeleteReview(ctx context.Context, id string) error {
	tx, err := d.sql.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	for _, q := range []string{
		`DELETE FROM review_viewed WHERE review_id = ?`, `DELETE FROM review_findings WHERE review_id = ?`,
		`DELETE FROM review_comments WHERE review_id = ?`, `DELETE FROM review_threads WHERE review_id = ?`, `DELETE FROM reviews WHERE id = ?`,
	} {
		if _, err := tx.ExecContext(ctx, q, id); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// GitHubSource builds the source string of a GitHub review.
func GitHubSource(repo string, number int) string {
	return "github:" + repo + "#" + strconv.Itoa(number)
}

// LocalSource builds the source string of a local-branch review.
func LocalSource(base, head string) string { return "local:" + base + ".." + head }
