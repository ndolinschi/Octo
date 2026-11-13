// Package codehost is the small interface the PR review feature uses to talk
// to a code host, and its first adapter (GitHub through the user's own `gh`).
//
// Everything a host returns about a pull request (title, description,
// comments, branch names) is untrusted text: it is stored and handed to the UI
// as data and is never interpreted by the harness. Nothing is written to a host
// except through PostReview, which only the review service's submit calls.
package codehost

import (
	"context"
	"errors"
	"fmt"
)

// Host is a code host reached through a CLI the user is logged in with.
type Host interface {
	// Name is the adapter id ("github").
	Name() string
	// Repo is the host's own default repository for dir. Only used when the
	// folder has no remote that names a code host; it never picks among remotes.
	Repo(ctx context.Context, dir string) (Repo, error)
	// RepoInfo says whether repo is a fork and of which repository.
	RepoInfo(ctx context.Context, dir string, repo Repo) (RepoInfo, error)
	// ListPRs lists open pull requests of repo; those that ask for the current
	// user's review are flagged.
	ListPRs(ctx context.Context, dir string, repo Repo) ([]PR, error)
	// View is the metadata of one pull request.
	View(ctx context.Context, dir string, repo Repo, number int) (PRDetail, error)
	// Checks are the CI checks of a pull request (empty when it has none).
	Checks(ctx context.Context, dir string, repo Repo, number int) ([]Check, error)
	// PostReview posts one review: a verdict, a body and line comments. It is the
	// only write the interface has.
	PostReview(ctx context.Context, dir string, repo Repo, number int, r Review) (Posted, error)
	// Threads are the review threads already on a pull request (read only).
	Threads(ctx context.Context, dir string, repo Repo, number int) ([]Thread, error)
	// PostReply posts one reply to an existing review thread (the comment id is
	// the thread's first comment). Like PostReview it is a write that only the
	// review service's submit calls.
	PostReply(ctx context.Context, dir string, repo Repo, number int, rootCommentID, body string) (Posted, error)
}

// Repo names a repository on a host.
type Repo struct {
	Owner string `json:"owner"`
	Name  string `json:"name"`
	// URL is the web address of the repository.
	URL string `json:"url,omitempty"`
	// Host is the host name of the code host ("github.com", "ghe.example.com").
	Host string `json:"host,omitempty"`
}

func (r Repo) String() string { return r.Owner + "/" + r.Name }

// RepoInfo is what the host says about a repository: whether it is a fork,
// and its parent when it is.
type RepoInfo struct {
	Repo   Repo
	IsFork bool
	Parent *Repo
}

// Reason codes of an Unavailable error.
const (
	ReasonNotInstalled  = "gh_not_installed"
	ReasonNotLoggedIn   = "not_logged_in"
	ReasonNoRepo        = "no_github_repo"
	ReasonNotSupported  = "unsupported_host"
	CommandInstall      = "brew install gh   (or https://cli.github.com)"
	CommandLogin        = "gh auth login"
	CommandNoRepoRemote = "git remote add origin https://github.com/OWNER/REPO.git"
)

// Unavailable says the host cannot be used right now and what to do about it.
type Unavailable struct {
	Reason  string
	Message string
	// Command is what the user can run to fix it ("" when there is none).
	Command string
}

func (u *Unavailable) Error() string { return u.Message }

// IsUnavailable unwraps an *Unavailable.
func IsUnavailable(err error) (*Unavailable, bool) {
	var u *Unavailable
	if errors.As(err, &u) {
		return u, true
	}
	return nil, false
}

// Error is a failed host call; Message is the CLI's own (capped) text.
type Error struct {
	Op      string
	Message string
}

func (e *Error) Error() string { return fmt.Sprintf("%s: %s", e.Op, e.Message) }

// PR is a pull request in a list.
type PR struct {
	Number    int    `json:"number"`
	Title     string `json:"title"`
	Author    string `json:"author"`
	Draft     bool   `json:"draft"`
	URL       string `json:"url"`
	HeadRef   string `json:"head_ref"`
	BaseRef   string `json:"base_ref"`
	HeadSHA   string `json:"head_sha"`
	Additions int    `json:"additions"`
	Deletions int    `json:"deletions"`
	Files     int    `json:"changed_files"`
	CreatedAt string `json:"created_at"`
	UpdatedAt string `json:"updated_at"`
	// Checks is "success", "failure", "pending" or "none".
	Checks          string   `json:"checks"`
	ReviewRequested bool     `json:"review_requested"`
	ReviewDecision  string   `json:"review_decision,omitempty"`
	Labels          []string `json:"labels,omitempty"`
	// Comments counts the conversation comments plus the reviews that carry a text.
	Comments int `json:"comments"`
	// Mine: the signed-in user opened it. ReviewedByMe: the user has a review on
	// it. NewSinceMyReview: it has commits newer than the user's last review.
	Mine             bool `json:"mine"`
	ReviewedByMe     bool `json:"reviewed_by_me"`
	NewSinceMyReview bool `json:"new_since_my_review"`
}

// PRDetail is one pull request with its description and conversation.
type PRDetail struct {
	PR
	State        string         `json:"state"` // open, closed, merged
	Body         string         `json:"body"`
	BodyCut      bool           `json:"body_truncated,omitempty"`
	BaseSHA      string         `json:"base_sha,omitempty"`
	Commits      []PRCommit     `json:"commits,omitempty"`
	Conversation []Conversation `json:"conversation,omitempty"`
	Mergeable    string         `json:"mergeable,omitempty"`
}

// PRCommit is a commit of a pull request.
type PRCommit struct {
	SHA     string `json:"sha"`
	Subject string `json:"subject"`
	Author  string `json:"author,omitempty"`
	Date    string `json:"date,omitempty"`
}

// Conversation is one comment or review already on the pull request.
type Conversation struct {
	Kind      string `json:"kind"` // comment, review
	Author    string `json:"author"`
	Body      string `json:"body"`
	State     string `json:"state,omitempty"` // for a review: APPROVED, CHANGES_REQUESTED, COMMENTED
	CreatedAt string `json:"created_at,omitempty"`
}

// Check is one CI check.
type Check struct {
	Name     string `json:"name"`
	State    string `json:"state"`  // the host's own word
	Bucket   string `json:"bucket"` // pass, fail, pending, skipping, cancel
	Workflow string `json:"workflow,omitempty"`
	URL      string `json:"url,omitempty"`
}

// Verdicts of a review.
const (
	VerdictComment        = "comment"
	VerdictApprove        = "approve"
	VerdictRequestChanges = "request_changes"
)

// ValidVerdict reports whether v is one of the three verdicts.
func ValidVerdict(v string) bool {
	return v == VerdictComment || v == VerdictApprove || v == VerdictRequestChanges
}

// Review is what PostReview sends: exactly this and nothing else.
type Review struct {
	Verdict  string          `json:"verdict"`
	Body     string          `json:"body"`
	CommitID string          `json:"commit_id"`
	Comments []ReviewComment `json:"comments"`
}

// ReviewComment is one inline comment. Line is the last line (new side unless
// Side is "old"); StartLine is set for a range; both zero means a file-level
// comment. Suggestion, when set, is rendered as a suggested change.
type ReviewComment struct {
	Path       string `json:"path"`
	Line       int    `json:"line,omitempty"`
	StartLine  int    `json:"start_line,omitempty"`
	Side       string `json:"side,omitempty"` // "new" (default) or "old"
	Body       string `json:"body"`
	Suggestion string `json:"suggestion,omitempty"`
}

// Posted is the host's answer to PostReview.
type Posted struct {
	ID  string `json:"id,omitempty"`
	URL string `json:"url,omitempty"`
}

// Thread is one review thread of a pull request: the comments anchored at one
// place of the diff, with the host's resolved and outdated state. Everything in
// the comments is untrusted text.
type Thread struct {
	// ID is the host's id of the thread (what a reply names).
	ID   string `json:"id"`
	Path string `json:"path"`
	// Side is "new" (the added or unchanged side) or "old" (the removed side).
	Side      string `json:"side"`
	Line      int    `json:"line,omitempty"`
	StartLine int    `json:"start_line,omitempty"`
	// OriginalLine is the line when the thread was written (an outdated thread's Line is its last known).
	OriginalLine int             `json:"original_line,omitempty"`
	Resolved     bool            `json:"resolved"`
	Outdated     bool            `json:"outdated"`
	Comments     []ThreadComment `json:"comments"`
}

// ThreadComment is one comment of a thread.
type ThreadComment struct {
	// ID is the host's numeric id of the comment (the first comment's id is what a reply names).
	ID        string `json:"id"`
	Author    string `json:"author"`
	Body      string `json:"body"`
	CreatedAt string `json:"created_at"`
	URL       string `json:"url,omitempty"`
	// Commit is the commit the comment was written on; OriginalCommit the one it was made against.
	Commit       string `json:"commit,omitempty"`
	InReplyTo    string `json:"in_reply_to,omitempty"`
	Line         int    `json:"line,omitempty"`
	OriginalLine int    `json:"original_line,omitempty"`
}
