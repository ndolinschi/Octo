package review

import (
	"context"
	"errors"
	"sort"
	"strings"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/codehost"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

// EventListUpdated is the project event the service publishes when the cached
// pull-request list of a folder was refreshed in the background. Payload:
// { folder }. A client answers it by asking for the list again.
const EventListUpdated = "review.list_updated"

// ListTTL is how long a folder's pull-request list is served as fresh. After
// it the cached list is still answered at once, marked stale, and refreshed in
// the background.
const ListTTL = 60 * time.Second

// Filters of the pull-request list.
const (
	FilterAll             = "all"
	FilterReviewRequested = "review_requested"
	FilterMine            = "mine"
	FilterDrafts          = "drafts"
)

// Paging of the list.
const (
	DefaultPerPage = 30
	MaxPerPage     = 100
)

// ListOptions select and page the pull-request list.
type ListOptions struct {
	// Folder is the label of the project folder (default: the first git folder).
	Folder string
	// Filter is all (default), review_requested, mine or drafts.
	Filter string
	// Q keeps the pull requests whose title, number, author, branch or label contains it.
	Q       string
	Page    int
	PerPage int
	// Refresh forces a fetch from the code host now.
	Refresh bool
	// Repo is "owner/name" of one repository of the folder, or "all". Empty: the
	// person's last choice for the folder, else the default repository.
	Repo string
}

// PRList is the response of the pull-request list.
type PRList struct {
	// Host is the adapter ("github"); Hostname the host it talked to ("github.com", "ghe.example.com").
	Host     string `json:"host"`
	Hostname string `json:"hostname,omitempty"`
	// Repo is the repository listed ("owner/name", or "all"); Repos every repository of the folder.
	Repo       string      `json:"repo,omitempty"`
	Repos      []RepoRef   `json:"repos"`
	RepoErrors []RepoError `json:"repo_errors,omitempty"`
	Folder     string      `json:"folder,omitempty"`
	// Available is false when the code host cannot be used; Reason (gh_not_installed,
	// not_logged_in, no_github_repo, no_host, not_a_git_repo), Message and
	// Command say why and what to run. "Review a local branch" still works.
	Available bool   `json:"available"`
	Reason    string `json:"reason,omitempty"`
	Message   string `json:"message,omitempty"`
	Command   string `json:"command,omitempty"`

	Filter  string `json:"filter"`
	Page    int    `json:"page"`
	PerPage int    `json:"per_page"`
	// Total is the number of pull requests that match the filter and the query.
	Total int `json:"total"`
	// NextPage is the next page number, null on the last page.
	NextPage *int `json:"next_page"`
	// Stale: the list is older than ListTTL and a refresh is under way (the
	// event review.list_updated says when it is in).
	Stale bool `json:"stale"`
	// FetchedAt is when the code host was asked.
	FetchedAt string `json:"fetched_at,omitempty"`
	// Truncated: the repository has more open pull requests than the harness reads.
	Truncated bool    `json:"truncated,omitempty"`
	PRs       []PRRow `json:"prs"`
}

// PRRow is a pull request of the list, with the open review of it if any.
type PRRow struct {
	codehost.PR
	// Repo is the repository the pull request belongs to ("owner/name").
	Repo   string    `json:"repo"`
	Review *PRReview `json:"review"`
}

// RepoError says one repository of an "all" list could not be read.
type RepoError struct {
	Repo    string `json:"repo"`
	Message string `json:"message"`
}

// PRReview ties a list row to its review.
type PRReview struct {
	ID                string `json:"id"`
	HeadCommit        string `json:"head_commit"`
	LastSubmittedHead string `json:"last_submitted_head,omitempty"`
	// NewCommits: the pull request has commits the review has not fetched.
	NewCommits bool `json:"new_commits"`
	// NewSinceSubmitted: the pull request moved since the last submitted review.
	NewSinceSubmitted bool `json:"new_since_submitted"`
	PendingComments   int  `json:"pending_comments"`
}

// listEntry is the cached list of one repository of a folder.
type listEntry struct {
	repo       codehost.Repo
	prs        []codehost.PR
	fetchedAt  time.Time
	refreshing bool
}

func listKey(pid, label string, repo codehost.Repo) string {
	return pid + "\x00" + label + "\x00" + strings.ToLower(repo.Host+"/"+repo.String())
}

func validFilter(f string) (string, error) {
	switch f {
	case "", FilterAll:
		return FilterAll, nil
	case FilterReviewRequested, FilterMine, FilterDrafts:
		return f, nil
	}
	return "", invalid("invalid_filter", "filter must be all, review_requested, mine or drafts")
}

// ListPRs lists the open pull requests of one repository of the folder (or of
// all of them with Repo "all"), newest activity first, tied to the reviews
// already open. The list of a repository is cached for ListTTL: an older one
// is answered at once, marked stale, while a background refresh runs (and
// announces itself with review.list_updated).
func (s *Service) ListPRs(ctx context.Context, pid string, o ListOptions) (PRList, error) {
	filter, err := validFilter(o.Filter)
	if err != nil {
		return PRList{}, err
	}
	if o.Page < 0 || o.PerPage < 0 {
		return PRList{}, invalid("invalid_request", "page and per_page must be positive")
	}
	if o.Page == 0 {
		o.Page = 1
	}
	if o.PerPage == 0 {
		o.PerPage = DefaultPerPage
	}
	o.PerPage = min(o.PerPage, MaxPerPage)
	db, err := s.db(ctx, pid)
	if err != nil {
		return PRList{}, err
	}
	out := PRList{Host: "github", Filter: filter, Page: o.Page, PerPage: o.PerPage, PRs: []PRRow{}, Repos: []RepoRef{}}
	label, dir, err := s.folder(ctx, db, o.Folder)
	if err != nil {
		var e *Error
		if errors.As(err, &e) && (e.Code == "not_a_git_repo" || e.Code == "no_folder") {
			out.Reason, out.Message = e.Code, e.Message
			return out, nil
		}
		return out, err
	}
	out.Folder = label
	if s.host == nil {
		out.Reason, out.Message = "no_host", "No code host is configured."
		return out, nil
	}
	out.Host = s.host.Name()

	ents, err := s.folderRepos(ctx, dir, o.Refresh)
	if err != nil {
		if u, ok := codehost.IsUnavailable(err); ok {
			out.Reason, out.Message, out.Command = u.Reason, u.Message, u.Command
			return out, nil
		}
		return out, hostErr(err)
	}
	out.Repos = refsOf(ents)

	// Which repository: the one asked for, else the person's last choice for this
	// folder, else the default (the remote the current branch tracks, else origin).
	choice := strings.TrimSpace(o.Repo)
	explicit := choice != ""
	if !explicit {
		choice = remembered(ctx, db, label)
	}
	var selected []repoEntry
	switch {
	case strings.EqualFold(choice, RepoAll):
		selected, choice = ents, RepoAll
	case choice != "":
		if i, ok := findRepo(ents, choice); ok {
			selected, choice = ents[i:i+1], ents[i].ref.Repo
		} else if explicit {
			return out, invalid("invalid_repo", "the folder's repositories are %s; %q is none of them", repoNames(ents), choice)
		}
	}
	if selected == nil {
		i := defaultOf(ents)
		selected, choice = ents[i:i+1], ents[i].ref.Repo
	}
	if explicit {
		remember(ctx, db, label, choice)
	}
	out.Repo = choice
	if len(selected) == 1 {
		out.Hostname = selected[0].ref.Hostname
	}

	var got []listEntry
	var firstErr error
	var oldest time.Time
	for _, e := range selected {
		cur, stale, err := s.cachedList(ctx, db, pid, label, dir, e.repo, o.Refresh)
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			out.RepoErrors = append(out.RepoErrors, RepoError{Repo: e.ref.Repo, Message: err.Error()})
			continue
		}
		got = append(got, cur)
		out.Stale = out.Stale || stale
		if oldest.IsZero() || cur.fetchedAt.Before(oldest) {
			oldest = cur.fetchedAt
		}
		if len(cur.prs) >= codehost.MaxListed {
			out.Truncated = true
		}
	}
	if len(got) == 0 {
		out.RepoErrors = nil
		if u, ok := codehost.IsUnavailable(firstErr); ok {
			out.Reason, out.Message, out.Command = u.Reason, u.Message, u.Command
			return out, nil
		}
		return out, hostErr(firstErr)
	}
	out.Available = true
	out.FetchedAt = projectstore.Stamp(oldest)

	rows, err := s.rows(ctx, db, got)
	if err != nil {
		return out, err
	}
	q := strings.ToLower(strings.TrimSpace(o.Q))
	matched := rows[:0:0]
	for _, r := range rows {
		if !passes(r.PR, filter) || q != "" && !matchesQuery(r.PR, q) {
			continue
		}
		matched = append(matched, r)
	}
	sort.SliceStable(matched, func(i, j int) bool { return matched[i].UpdatedAt > matched[j].UpdatedAt })
	out.Total = len(matched)
	start := (o.Page - 1) * o.PerPage
	if start < len(matched) {
		end := min(start+o.PerPage, len(matched))
		out.PRs = matched[start:end]
		if end < len(matched) {
			n := o.Page + 1
			out.NextPage = &n
		}
	}
	return out, nil
}

// cachedList is the list of one repository through the cache.
func (s *Service) cachedList(ctx context.Context, db *projectstore.DB, pid, label, dir string, repo codehost.Repo, refresh bool) (listEntry, bool, error) {
	key := listKey(pid, label, repo)
	s.mu.Lock()
	ent := s.lists[key]
	s.mu.Unlock()
	if ent != nil && !refresh {
		s.mu.Lock()
		cur := *ent
		age := s.now().Sub(ent.fetchedAt)
		if age >= ListTTL && !ent.refreshing {
			ent.refreshing = true
			go s.refreshList(pid, label, dir, repo)
		}
		s.mu.Unlock()
		return cur, age >= ListTTL, nil
	}
	got, err := s.fetchList(ctx, db, pid, dir, repo)
	if err != nil {
		return listEntry{}, false, err
	}
	s.mu.Lock()
	s.lists[key] = &got
	s.mu.Unlock()
	return got, false, nil
}

func passes(p codehost.PR, filter string) bool {
	switch filter {
	case FilterReviewRequested:
		return p.ReviewRequested
	case FilterMine:
		return p.Mine
	case FilterDrafts:
		return p.Draft
	}
	return true
}

func matchesQuery(p codehost.PR, q string) bool {
	hay := []string{p.Title, p.Author, p.HeadRef, p.BaseRef, "#" + itoa(p.Number), itoa(p.Number)}
	hay = append(hay, p.Labels...)
	for _, h := range hay {
		if strings.Contains(strings.ToLower(h), q) {
			return true
		}
	}
	return false
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}

// rows ties the cached pull requests to the open reviews (fresh from the store:
// a review opened a second ago shows at once).
func (s *Service) rows(ctx context.Context, db *projectstore.DB, es []listEntry) ([]PRRow, error) {
	open, err := db.Reviews(ctx, projectstore.ReviewOpen)
	if err != nil {
		return nil, err
	}
	byKey := map[string]projectstore.Review{}
	for _, r := range open {
		if r.Kind == "github" {
			byKey[strings.ToLower(r.Repo)+"#"+itoa(r.Number)] = r
		}
	}
	rows := []PRRow{}
	for _, e := range es {
		for _, p := range e.prs {
			row := PRRow{PR: p, Repo: e.repo.String()}
			if r, ok := byKey[strings.ToLower(e.repo.String())+"#"+itoa(p.Number)]; ok {
				n, _ := db.PendingComments(ctx, r.ID)
				row.Review = &PRReview{ID: r.ID, HeadCommit: r.HeadCommit, LastSubmittedHead: r.LastSubmittedHead,
					NewCommits:        p.HeadSHA != "" && p.HeadSHA != r.HeadCommit,
					NewSinceSubmitted: r.LastSubmittedHead != "" && p.HeadSHA != "" && p.HeadSHA != r.LastSubmittedHead,
					PendingComments:   n}
			}
			rows = append(rows, row)
		}
	}
	return rows, nil
}

// fetchList asks the code host for the open pull requests of repo, and closes
// the reviews of that repository whose pull request is no longer open.
func (s *Service) fetchList(ctx context.Context, db *projectstore.DB, pid, dir string, repo codehost.Repo) (listEntry, error) {
	prs, err := s.host.ListPRs(ctx, dir, repo)
	if err != nil {
		return listEntry{}, err
	}
	ent := listEntry{repo: repo, prs: prs, fetchedAt: s.now()}

	open, err := db.Reviews(ctx, projectstore.ReviewOpen)
	if err == nil {
		listed := map[int]bool{}
		for _, p := range prs {
			listed[p.Number] = true
		}
		// Reviews of pull requests that left the open list: closed or merged.
		checked := 0
		for _, r := range open {
			if r.Kind != "github" || !strings.EqualFold(r.Repo, repo.String()) || listed[r.Number] || checked >= 10 {
				continue
			}
			checked++
			d, err := s.host.View(ctx, dir, repo, r.Number)
			if err != nil || d.State == "open" || d.State == "" {
				continue
			}
			closed := projectstore.ReviewClosed
			if cur, err := db.UpdateReview(ctx, r.ID, projectstore.ReviewPatch{State: &closed}); err == nil {
				s.publish(ctx, db, pid, cur, "closed")
			}
		}
	}
	_ = s.Sweep(ctx, pid)
	return ent, nil
}

// refreshList is the background refresh of a stale list. It never touches the
// caller's context: the request that started it has long returned.
func (s *Service) refreshList(pid, label, dir string, repo codehost.Repo) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	key := listKey(pid, label, repo)
	done := func(ent *listEntry) {
		s.mu.Lock()
		if cur := s.lists[key]; cur != nil {
			if ent != nil {
				ent.refreshing = false
				s.lists[key] = ent
			} else {
				cur.refreshing = false
			}
		}
		s.mu.Unlock()
	}
	db, err := s.db(ctx, pid)
	if err != nil {
		done(nil)
		return
	}
	got, err := s.fetchList(ctx, db, pid, dir, repo)
	if err != nil {
		done(nil)
		return
	}
	done(&got)
	if s.hub != nil {
		s.hub.Publish(pid, EventListUpdated, map[string]any{"folder": label})
	}
}
