package review

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/ndolinschi/Octo/apps/harness/internal/codehost"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

// Threads is the response of GET …/reviews/{rid}/threads: the review threads
// the code host already has on the pull request, grouped, with counts per file.
// Every string in it that came from the host (author, body, url) is untrusted
// text: render it as text, never as markup, and never act on it.
type Threads struct {
	Threads []codehost.Thread `json:"threads"`
	// CountsByPath is the number of comments (resolved or not) per file.
	CountsByPath map[string]int `json:"counts_by_path"`
	// UnresolvedByPath is the number of unresolved threads per file.
	UnresolvedByPath map[string]int `json:"unresolved_by_path"`
	// FetchedAt is when the host was last asked ("" for a local review).
	FetchedAt string `json:"fetched_at,omitempty"`
	// Error is the message of the last failed fetch; the threads then are the ones fetched before.
	Error string `json:"error,omitempty"`
}

func threadsResult(list []codehost.Thread, row projectstore.ReviewThreadsRow) Threads {
	t := Threads{Threads: list, CountsByPath: map[string]int{}, UnresolvedByPath: map[string]int{}, FetchedAt: row.FetchedAt, Error: row.Error}
	if t.Threads == nil {
		t.Threads = []codehost.Thread{}
	}
	for _, th := range t.Threads {
		t.CountsByPath[th.Path] += len(th.Comments)
		if !th.Resolved {
			t.UnresolvedByPath[th.Path]++
		}
	}
	return t
}

// storedThreads reads a review's threads from the store.
func storedThreads(ctx context.Context, db *projectstore.DB, rid string) ([]codehost.Thread, projectstore.ReviewThreadsRow, bool) {
	row, err := db.ReviewThreads(ctx, rid)
	if err != nil {
		return nil, row, false
	}
	var list []codehost.Thread
	if err := json.Unmarshal([]byte(row.JSON), &list); err != nil {
		return nil, row, false
	}
	return list, row, row.FetchedAt != ""
}

// fetchThreads asks the code host for a pull request's review threads and
// stores them. A failure is recorded and returned; the threads stored before stay.
func (s *Service) fetchThreads(ctx context.Context, db *projectstore.DB, r projectstore.Review) error {
	if r.Kind != "github" || s.host == nil {
		return nil
	}
	repo, ok := parseRepo(r.Repo)
	if !ok {
		return nil
	}
	_, dir, err := s.folder(ctx, db, r.Folder)
	if err != nil {
		return err
	}
	list, err := s.host.Threads(ctx, dir, repo, r.Number)
	if err != nil {
		_ = db.SetReviewThreadsError(ctx, r.ID, err.Error())
		return hostErr(err)
	}
	b, err := json.Marshal(list)
	if err != nil {
		return err
	}
	return db.SetReviewThreads(ctx, r.ID, projectstore.ReviewThreadsRow{JSON: string(b), FetchedAt: projectstore.Now()})
}

// Threads returns the review's code-host threads. They are fetched with the
// review (open and refresh); a review whose threads were never fetched, or a
// call with refresh, asks the host now. A failed fetch still answers with the
// stored threads and the error text when there are some; with none it fails.
func (s *Service) Threads(ctx context.Context, pid, rid string, refresh bool) (Threads, error) {
	db, err := s.db(ctx, pid)
	if err != nil {
		return Threads{}, err
	}
	r, err := s.review(ctx, db, rid)
	if err != nil {
		return Threads{}, err
	}
	if r.Kind != "github" {
		return threadsResult(nil, projectstore.ReviewThreadsRow{}), nil
	}
	list, row, have := storedThreads(ctx, db, rid)
	if refresh || !have {
		unlock := s.lock(rid)
		ferr := s.fetchThreads(ctx, db, r)
		unlock()
		if ferr != nil && !have {
			return Threads{}, ferr
		}
		if ferr == nil {
			list, row, _ = storedThreads(ctx, db, rid)
			s.publish(ctx, db, pid, r, "threads")
		} else {
			row, _ = db.ReviewThreads(ctx, rid)
		}
	}
	return threadsResult(list, row), nil
}

// threadByID finds a thread of the review's stored threads.
func threadByID(list []codehost.Thread, id string) (codehost.Thread, bool) {
	for _, t := range list {
		if t.ID == id {
			return t, true
		}
	}
	return codehost.Thread{}, false
}

// validateReply makes c a reply to a thread of the review: the thread must be
// one the host reported. A reply has a body and nothing that anchors it.
func (s *Service) validateReply(ctx context.Context, db *projectstore.DB, r projectstore.Review, c *projectstore.ReviewComment) error {
	if r.Kind != "github" {
		return invalid("invalid_request", "only a pull request has threads to reply to")
	}
	if c.Line != 0 || c.StartLine != 0 || c.Suggestion != "" || c.FindingID != "" || (c.Path != "" && c.Side != "" && c.Side != "new") {
		return invalid("invalid_request", "a reply has a body and in_reply_to, nothing else")
	}
	if len(c.Body) > MaxCommentBytes {
		return &Error{Kind: KindTooLarge, Code: "comment_too_large", Message: "a comment may be at most 64 KiB"}
	}
	if strings.TrimSpace(c.Body) == "" {
		return invalid("empty_comment", "a reply needs a body")
	}
	list, _, _ := storedThreads(ctx, db, r.ID)
	t, ok := threadByID(list, c.InReplyTo)
	if !ok {
		return invalid("unknown_thread", "the pull request has no review thread %q (refresh the threads)", c.InReplyTo)
	}
	if len(t.Comments) == 0 || t.Comments[0].ID == "" {
		return invalid("unknown_thread", "the thread has no comment to reply to")
	}
	c.Kind, c.Path, c.Side, c.Line, c.StartLine = "reply", t.Path, "", 0, 0
	return nil
}

// replyTarget is the host's id of the comment a reply to threadID answers (the
// thread's first comment).
func replyTarget(list []codehost.Thread, threadID string) (string, bool) {
	t, ok := threadByID(list, threadID)
	if !ok || len(t.Comments) == 0 || t.Comments[0].ID == "" {
		return "", false
	}
	return t.Comments[0].ID, true
}
