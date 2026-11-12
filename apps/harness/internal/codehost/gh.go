package codehost

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/childenv"
)

// GH is the GitHub adapter. It runs the `gh` found on PATH when a call is
// made, as the user the CLI is logged in as; the harness never holds a token.
// GH_* variables of the harness environment are passed to that one command
// (and to nothing else the harness starts).
type GH struct {
	// Environ is the environment gh is started from; nil means os.Environ().
	Environ func() []string
	// Timeout bounds one call (default 90 s).
	Timeout time.Duration

	mu      sync.Mutex
	viewers map[string]viewerEntry
}

// NewGH returns the GitHub adapter.
func NewGH() *GH { return &GH{} }

func (g *GH) Name() string { return "github" }

const (
	maxBody         = 64 << 10
	maxConversation = 200
	maxCommits      = 250
)

// hostFor is the host name gh must talk to for dir: the host of the remote the
// call is about (see WithRepoHint), "" when no remote names a code host (gh then
// decides by itself, from GH_HOST or its default).
func (g *GH) hostFor(ctx context.Context, dir string) string {
	if r, ok := PickRemote(Remotes(ctx, dir), repoHint(ctx)); ok {
		return r.Host
	}
	return ""
}

func (g *GH) env(host string) []string {
	environ := os.Environ()
	if g.Environ != nil {
		environ = g.Environ()
	}
	env := childenv.Build(environ, nil)
	for _, kv := range environ {
		if k, _, ok := strings.Cut(kv, "="); ok && strings.HasPrefix(strings.ToUpper(k), "GH_") {
			env = append(env, kv)
		}
	}
	if host != "" {
		// The repository's own host wins over a GH_HOST left in the environment:
		// an enterprise remote must not be asked of github.com, nor the reverse.
		env = append(env, "GH_HOST="+host)
	}
	return append(env, "GH_PROMPT_DISABLED=1", "GH_NO_UPDATE_NOTIFIER=1", "GH_SPINNER_DISABLED=1", "NO_COLOR=1", "CLICOLOR=0")
}

var (
	reNotLoggedIn = regexp.MustCompile(`(?i)gh auth login|not logged in|GH_TOKEN|authentication required|HTTP 401|bad credentials`)
	reNoRepo      = regexp.MustCompile(`(?i)none of the git remotes|not a git repository|no git remotes|could not determine|unable to determine base repository|no default remote|resolve to a github repo|known github host`)
)

// run runs gh in dir with args and optional stdin; it maps "not installed", "not
// logged in" and "no GitHub remote" to *Unavailable.
func (g *GH) run(ctx context.Context, dir string, stdin []byte, args ...string) (stdout, stderr []byte, exit int, err error) {
	bin, lerr := exec.LookPath("gh")
	if lerr != nil {
		return nil, nil, 0, &Unavailable{Reason: ReasonNotInstalled,
			Message: "The GitHub CLI (gh) is not installed.", Command: CommandInstall}
	}
	timeout := g.Timeout
	if timeout <= 0 {
		timeout = 90 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, args...)
	cmd.Dir = dir
	cmd.Env = g.env(g.hostFor(ctx, dir))
	if stdin != nil {
		cmd.Stdin = bytes.NewReader(stdin)
	}
	var out, errb bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &capWriter{w: &errb, max: 16 << 10}
	runErr := cmd.Run()
	exit = 0
	if runErr != nil {
		var ee *exec.ExitError
		if errors.As(runErr, &ee) {
			exit = ee.ExitCode()
		} else {
			return out.Bytes(), errb.Bytes(), -1, &Error{Op: "gh " + args[0], Message: runErr.Error()}
		}
	}
	if exit != 0 {
		msg := strings.TrimSpace(errb.String())
		switch {
		case reNotLoggedIn.MatchString(msg):
			return out.Bytes(), errb.Bytes(), exit, &Unavailable{Reason: ReasonNotLoggedIn,
				Message: "The GitHub CLI is not logged in.", Command: CommandLogin}
		case reNoRepo.MatchString(msg):
			return out.Bytes(), errb.Bytes(), exit, &Unavailable{Reason: ReasonNoRepo,
				Message: "This folder has no GitHub remote.", Command: CommandNoRepoRemote}
		}
	}
	return out.Bytes(), errb.Bytes(), exit, nil
}

type capWriter struct {
	w   io.Writer
	max int
	n   int
}

func (c *capWriter) Write(p []byte) (int, error) {
	if c.n < c.max {
		room := c.max - c.n
		q := p
		if len(q) > room {
			q = q[:room]
		}
		_, _ = c.w.Write(q)
		c.n += len(q)
	}
	return len(p), nil
}

// ok runs gh and turns a non-zero exit into an *Error carrying gh's message.
func (g *GH) ok(ctx context.Context, dir string, stdin []byte, args ...string) ([]byte, error) {
	out, errb, exit, err := g.run(ctx, dir, stdin, args...)
	if err != nil {
		return nil, err
	}
	if exit != 0 {
		return nil, &Error{Op: "gh " + strings.Join(opWords(args), " "), Message: trimMsg(string(errb))}
	}
	return out, nil
}

func opWords(args []string) []string {
	var w []string
	for _, a := range args {
		if strings.HasPrefix(a, "-") {
			break
		}
		w = append(w, a)
		if len(w) == 2 {
			break
		}
	}
	return w
}

func trimMsg(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return "failed"
	}
	if len(s) > 600 {
		s = strings.ToValidUTF8(s[:600], "") + "..."
	}
	return s
}

func (g *GH) Repo(ctx context.Context, dir string) (Repo, error) {
	out, err := g.ok(ctx, dir, nil, "repo", "view", "--json", "name,owner,url")
	if err != nil {
		return Repo{}, err
	}
	var v struct {
		Name  string `json:"name"`
		Owner struct {
			Login string `json:"login"`
		} `json:"owner"`
		URL string `json:"url"`
	}
	if err := json.Unmarshal(out, &v); err != nil || v.Name == "" || v.Owner.Login == "" {
		return Repo{}, &Error{Op: "gh repo view", Message: "unexpected output"}
	}
	host := g.hostFor(ctx, dir)
	if h, _, _, ok := ParseRemoteURL(v.URL); ok {
		host = h
	}
	return Repo{Owner: v.Owner.Login, Name: v.Name, URL: v.URL, Host: host}, nil
}

type ghAuthor struct {
	Login string `json:"login"`
	Name  string `json:"name"`
}

func (a ghAuthor) who() string {
	if a.Login != "" {
		return a.Login
	}
	return a.Name
}

type ghPR struct {
	Number         int      `json:"number"`
	Title          string   `json:"title"`
	Author         ghAuthor `json:"author"`
	IsDraft        bool     `json:"isDraft"`
	URL            string   `json:"url"`
	HeadRefName    string   `json:"headRefName"`
	BaseRefName    string   `json:"baseRefName"`
	HeadRefOid     string   `json:"headRefOid"`
	BaseRefOid     string   `json:"baseRefOid"`
	Additions      int      `json:"additions"`
	Deletions      int      `json:"deletions"`
	ChangedFiles   int      `json:"changedFiles"`
	CreatedAt      string   `json:"createdAt"`
	UpdatedAt      string   `json:"updatedAt"`
	ReviewDecision string   `json:"reviewDecision"`
	State          string   `json:"state"`
	Mergeable      string   `json:"mergeable"`
	Labels         []struct {
		Name string `json:"name"`
	} `json:"labels"`
	// Comments and LatestReviews are asked for by the list only.
	Comments      []json.RawMessage `json:"comments"`
	LatestReviews []struct {
		Author ghAuthor `json:"author"`
		Body   string   `json:"body"`
		State  string   `json:"state"`
		Commit struct {
			Oid string `json:"oid"`
		} `json:"commit"`
	} `json:"latestReviews"`
	Rollup []struct {
		Typename   string `json:"__typename"`
		Status     string `json:"status"`
		Conclusion string `json:"conclusion"`
		State      string `json:"state"`
	} `json:"statusCheckRollup"`
}

func (p ghPR) pr() PR {
	out := PR{
		Number: p.Number, Title: p.Title, Author: p.Author.who(), Draft: p.IsDraft, URL: p.URL,
		HeadRef: p.HeadRefName, BaseRef: p.BaseRefName, HeadSHA: p.HeadRefOid,
		Additions: p.Additions, Deletions: p.Deletions, Files: p.ChangedFiles,
		CreatedAt: p.CreatedAt, UpdatedAt: p.UpdatedAt, ReviewDecision: p.ReviewDecision, Checks: "none",
	}
	for _, l := range p.Labels {
		out.Labels = append(out.Labels, l.Name)
	}
	pending, failed := false, false
	for _, c := range p.Rollup {
		switch strings.ToUpper(c.Conclusion) {
		case "FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE":
			failed = true
		}
		switch strings.ToUpper(c.State) {
		case "FAILURE", "ERROR":
			failed = true
		case "PENDING", "EXPECTED":
			pending = true
		}
		if c.Typename == "CheckRun" && strings.ToUpper(c.Status) != "COMPLETED" {
			pending = true
		}
	}
	switch {
	case failed:
		out.Checks = "failure"
	case pending:
		out.Checks = "pending"
	case len(p.Rollup) > 0:
		out.Checks = "success"
	}
	return out
}

const listFields = "number,title,author,isDraft,url,headRefName,baseRefName,headRefOid,additions,deletions,changedFiles,createdAt,updatedAt,reviewDecision,labels,statusCheckRollup"

// MaxListed bounds the open pull requests read in one list (the UI pages them).
const MaxListed = 300

// viewer is the login of the signed-in user on host, cached for a while (it
// needs one extra gh call and does not change).
func (g *GH) viewer(ctx context.Context, dir, host string) string {
	g.mu.Lock()
	if v, ok := g.viewers[host]; ok && time.Since(v.at) < 30*time.Minute {
		g.mu.Unlock()
		return v.login
	}
	g.mu.Unlock()
	args := []string{"api", "user"}
	if host != "" {
		args = append(args, "--hostname", host)
	}
	out, err := g.ok(ctx, dir, nil, args...)
	if err != nil {
		return ""
	}
	var u struct {
		Login string `json:"login"`
	}
	if json.Unmarshal(out, &u) != nil || u.Login == "" {
		return ""
	}
	g.mu.Lock()
	if g.viewers == nil {
		g.viewers = map[string]viewerEntry{}
	}
	g.viewers[host] = viewerEntry{login: u.Login, at: time.Now()}
	g.mu.Unlock()
	return u.Login
}

type viewerEntry struct {
	login string
	at    time.Time
}

func (g *GH) ListPRs(ctx context.Context, dir string) ([]PR, error) {
	out, err := g.ok(ctx, dir, nil, "pr", "list", "--state", "open", "--limit", fmt.Sprint(MaxListed), "--json", listFields+",comments,latestReviews")
	if err != nil {
		return nil, err
	}
	var list []ghPR
	if err := json.Unmarshal(out, &list); err != nil {
		return nil, &Error{Op: "gh pr list", Message: "unexpected output"}
	}
	// The ones that ask for this user's review (a second, narrow query: the
	// reviewRequests field names teams as well and would need the user's login).
	mine := map[int]bool{}
	if out, err := g.ok(ctx, dir, nil, "pr", "list", "--state", "open", "--limit", fmt.Sprint(MaxListed),
		"--search", "review-requested:@me", "--json", "number"); err == nil {
		var nums []struct {
			Number int `json:"number"`
		}
		if json.Unmarshal(out, &nums) == nil {
			for _, n := range nums {
				mine[n.Number] = true
			}
		}
	} else if u, ok := IsUnavailable(err); ok {
		return nil, u
	}
	me := g.viewer(ctx, dir, g.hostFor(ctx, dir))
	res := make([]PR, 0, len(list))
	for _, p := range list {
		pr := p.pr()
		pr.ReviewRequested = mine[p.Number]
		pr.Comments = len(p.Comments)
		for _, r := range p.LatestReviews {
			if strings.TrimSpace(r.Body) != "" {
				pr.Comments++
			}
			if me != "" && strings.EqualFold(r.Author.who(), me) {
				pr.ReviewedByMe = true
				if r.Commit.Oid != "" && p.HeadRefOid != "" && r.Commit.Oid != p.HeadRefOid {
					pr.NewSinceMyReview = true
				}
			}
		}
		pr.Mine = me != "" && strings.EqualFold(p.Author.who(), me)
		res = append(res, pr)
	}
	return res, nil
}

func (g *GH) View(ctx context.Context, dir string, repo Repo, number int) (PRDetail, error) {
	ctx = WithRepoHint(ctx, repo.String())
	out, err := g.ok(ctx, dir, nil, "pr", "view", fmt.Sprint(number), "--json",
		listFields+",body,state,baseRefOid,mergeable,commits,comments,reviews")
	if err != nil {
		return PRDetail{}, err
	}
	var v struct {
		ghPR
		Body    string `json:"body"`
		Commits []struct {
			Oid             string     `json:"oid"`
			MessageHeadline string     `json:"messageHeadline"`
			CommittedDate   string     `json:"committedDate"`
			Authors         []ghAuthor `json:"authors"`
		} `json:"commits"`
		Comments []struct {
			Author    ghAuthor `json:"author"`
			Body      string   `json:"body"`
			CreatedAt string   `json:"createdAt"`
		} `json:"comments"`
		Reviews []struct {
			Author      ghAuthor `json:"author"`
			Body        string   `json:"body"`
			State       string   `json:"state"`
			SubmittedAt string   `json:"submittedAt"`
		} `json:"reviews"`
	}
	if err := json.Unmarshal(out, &v); err != nil {
		return PRDetail{}, &Error{Op: "gh pr view", Message: "unexpected output"}
	}
	d := PRDetail{PR: v.ghPR.pr(), State: strings.ToLower(v.State), BaseSHA: v.BaseRefOid, Mergeable: strings.ToLower(v.Mergeable)}
	d.Body = v.Body
	d.Comments = len(v.Comments)
	if len(d.Body) > maxBody {
		d.Body, d.BodyCut = strings.ToValidUTF8(d.Body[:maxBody], ""), true
	}
	for i, c := range v.Commits {
		if i >= maxCommits {
			break
		}
		pc := PRCommit{SHA: c.Oid, Subject: c.MessageHeadline, Date: c.CommittedDate}
		if len(c.Authors) > 0 {
			pc.Author = c.Authors[0].who()
		}
		d.Commits = append(d.Commits, pc)
	}
	for _, c := range v.Comments {
		d.Conversation = append(d.Conversation, Conversation{Kind: "comment", Author: c.Author.who(), Body: capText(c.Body), CreatedAt: c.CreatedAt})
	}
	for _, r := range v.Reviews {
		d.Conversation = append(d.Conversation, Conversation{Kind: "review", Author: r.Author.who(), Body: capText(r.Body), State: r.State, CreatedAt: r.SubmittedAt})
	}
	if len(d.Conversation) > maxConversation {
		d.Conversation = d.Conversation[len(d.Conversation)-maxConversation:]
	}
	return d, nil
}

func capText(s string) string {
	if len(s) > 16<<10 {
		return strings.ToValidUTF8(s[:16<<10], "")
	}
	return s
}

func (g *GH) Checks(ctx context.Context, dir string, repo Repo, number int) ([]Check, error) {
	ctx = WithRepoHint(ctx, repo.String())
	// `gh pr checks` exits 8 while checks are pending and 1 with "no checks
	// reported"; its JSON on stdout is what matters.
	out, errb, exit, err := g.run(ctx, dir, nil, "pr", "checks", fmt.Sprint(number), "--json", "name,state,bucket,link,workflow")
	if err != nil {
		return nil, err
	}
	if exit != 0 && len(bytes.TrimSpace(out)) == 0 {
		if strings.Contains(strings.ToLower(string(errb)), "no checks") {
			return nil, nil
		}
		return nil, &Error{Op: "gh pr checks", Message: trimMsg(string(errb))}
	}
	var list []struct {
		Name     string `json:"name"`
		State    string `json:"state"`
		Bucket   string `json:"bucket"`
		Link     string `json:"link"`
		Workflow string `json:"workflow"`
	}
	if err := json.Unmarshal(out, &list); err != nil {
		return nil, &Error{Op: "gh pr checks", Message: "unexpected output"}
	}
	res := make([]Check, 0, len(list))
	for _, c := range list {
		res = append(res, Check{Name: c.Name, State: c.State, Bucket: c.Bucket, Workflow: c.Workflow, URL: c.Link})
	}
	return res, nil
}

type ghReviewBody struct {
	CommitID string            `json:"commit_id,omitempty"`
	Body     string            `json:"body,omitempty"`
	Event    string            `json:"event"`
	Comments []ghReviewComment `json:"comments,omitempty"`
}

type ghReviewComment struct {
	Path        string `json:"path"`
	Body        string `json:"body"`
	Line        int    `json:"line,omitempty"`
	Side        string `json:"side,omitempty"`
	StartLine   int    `json:"start_line,omitempty"`
	StartSide   string `json:"start_side,omitempty"`
	SubjectType string `json:"subject_type,omitempty"`
}

// Payload is the exact JSON PostReview sends to the API (exported so a preview
// can show the user what will be posted).
func Payload(r Review) ([]byte, error) {
	ev, ok := map[string]string{
		VerdictComment: "COMMENT", VerdictApprove: "APPROVE", VerdictRequestChanges: "REQUEST_CHANGES",
	}[r.Verdict]
	if !ok {
		return nil, fmt.Errorf("unknown verdict %q", r.Verdict)
	}
	b := ghReviewBody{CommitID: r.CommitID, Body: r.Body, Event: ev}
	for _, c := range r.Comments {
		gc := ghReviewComment{Path: c.Path, Body: withSuggestion(c.Body, c.Suggestion)}
		side := "RIGHT"
		if c.Side == "old" {
			side = "LEFT"
		}
		switch {
		case c.Line == 0:
			gc.SubjectType = "file"
		case c.StartLine > 0 && c.StartLine < c.Line:
			gc.StartLine, gc.StartSide, gc.Line, gc.Side = c.StartLine, side, c.Line, side
		default:
			gc.Line, gc.Side = c.Line, side
		}
		b.Comments = append(b.Comments, gc)
	}
	return json.Marshal(b)
}

// withSuggestion appends a suggested change block (a fence longer than any
// backtick run inside the suggestion).
func withSuggestion(body, suggestion string) string {
	if suggestion == "" {
		return body
	}
	fence, run := 3, 0
	for _, r := range suggestion {
		if r == '`' {
			run++
			if run >= fence {
				fence = run + 1
			}
		} else {
			run = 0
		}
	}
	f := strings.Repeat("`", fence)
	sep := "\n\n"
	if body == "" {
		sep = ""
	}
	return body + sep + f + "suggestion\n" + strings.TrimSuffix(suggestion, "\n") + "\n" + f
}

// apiArgs adds --hostname for the repository's host: `gh api` does not infer
// it from the folder's remote the way `gh pr` does.
func (g *GH) apiArgs(ctx context.Context, dir string, args ...string) []string {
	if h := g.hostFor(ctx, dir); h != "" {
		args = append(args, "--hostname", h)
	}
	return args
}

func (g *GH) PostReview(ctx context.Context, dir string, repo Repo, number int, r Review) (Posted, error) {
	ctx = WithRepoHint(ctx, repo.String())
	payload, err := Payload(r)
	if err != nil {
		return Posted{}, err
	}
	out, err := g.ok(ctx, dir, payload, g.apiArgs(ctx, dir, "api", "--method", "POST",
		fmt.Sprintf("repos/%s/%s/pulls/%d/reviews", repo.Owner, repo.Name, number), "--input", "-")...)
	if err != nil {
		return Posted{}, err
	}
	var v struct {
		ID      json.Number `json:"id"`
		HTMLURL string      `json:"html_url"`
	}
	_ = json.Unmarshal(out, &v)
	return Posted{ID: v.ID.String(), URL: v.HTMLURL}, nil
}

var reDigits = regexp.MustCompile(`^[0-9]{1,20}$`)

// PostReply posts a reply to the review thread whose first comment is
// rootCommentID.
func (g *GH) PostReply(ctx context.Context, dir string, repo Repo, number int, rootCommentID, body string) (Posted, error) {
	ctx = WithRepoHint(ctx, repo.String())
	if !reDigits.MatchString(rootCommentID) {
		return Posted{}, &Error{Op: "gh api", Message: "invalid comment id"}
	}
	payload, _ := json.Marshal(map[string]string{"body": body})
	out, err := g.ok(ctx, dir, payload, g.apiArgs(ctx, dir, "api", "--method", "POST",
		fmt.Sprintf("repos/%s/%s/pulls/%d/comments/%s/replies", repo.Owner, repo.Name, number, rootCommentID), "--input", "-")...)
	if err != nil {
		return Posted{}, err
	}
	var v struct {
		ID      json.Number `json:"id"`
		HTMLURL string      `json:"html_url"`
	}
	_ = json.Unmarshal(out, &v)
	return Posted{ID: v.ID.String(), URL: v.HTMLURL}, nil
}

// threadsQuery is a read-only GraphQL query (no mutation); a test asserts it.
const threadsQuery = `query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:50,after:$after){pageInfo{hasNextPage endCursor}nodes{id isResolved isOutdated path line startLine originalLine originalStartLine diffSide startDiffSide comments(first:100){nodes{databaseId author{login} body createdAt url line originalLine commit{oid} originalCommit{oid} replyTo{databaseId}}}}}}}}`

// ThreadsQuery is the GraphQL text Threads sends.
func ThreadsQuery() string { return threadsQuery }

const maxThreadPages = 10

type ghThreadNode struct {
	ID                string `json:"id"`
	IsResolved        bool   `json:"isResolved"`
	IsOutdated        bool   `json:"isOutdated"`
	Path              string `json:"path"`
	Line              int    `json:"line"`
	StartLine         int    `json:"startLine"`
	OriginalLine      int    `json:"originalLine"`
	OriginalStartLine int    `json:"originalStartLine"`
	DiffSide          string `json:"diffSide"`
	Comments          struct {
		Nodes []struct {
			DatabaseID   json.Number `json:"databaseId"`
			Author       ghAuthor    `json:"author"`
			Body         string      `json:"body"`
			CreatedAt    string      `json:"createdAt"`
			URL          string      `json:"url"`
			Line         int         `json:"line"`
			OriginalLine int         `json:"originalLine"`
			Commit       struct {
				Oid string `json:"oid"`
			} `json:"commit"`
			ReplyTo *struct {
				DatabaseID json.Number `json:"databaseId"`
			} `json:"replyTo"`
		} `json:"nodes"`
	} `json:"comments"`
}

func (n ghThreadNode) thread() Thread {
	t := Thread{ID: n.ID, Path: n.Path, Side: "new", Line: n.Line, OriginalLine: n.OriginalLine,
		Resolved: n.IsResolved, Outdated: n.IsOutdated, Comments: []ThreadComment{}}
	if strings.EqualFold(n.DiffSide, "LEFT") {
		t.Side = "old"
	}
	start := n.StartLine
	if t.Line == 0 { // an outdated thread keeps only its original position
		t.Line, start = n.OriginalLine, n.OriginalStartLine
	}
	if start > 0 && start < t.Line {
		t.StartLine = start
	}
	for _, c := range n.Comments.Nodes {
		tc := ThreadComment{ID: c.DatabaseID.String(), Author: c.Author.who(), Body: capText(c.Body),
			CreatedAt: c.CreatedAt, URL: c.URL, Commit: c.Commit.Oid, Line: c.Line, OriginalLine: c.OriginalLine}
		if c.ReplyTo != nil {
			tc.InReplyTo = c.ReplyTo.DatabaseID.String()
		}
		t.Comments = append(t.Comments, tc)
	}
	return t
}

func (g *GH) Threads(ctx context.Context, dir string, repo Repo, number int) ([]Thread, error) {
	ctx = WithRepoHint(ctx, repo.String())
	res := []Thread{}
	after := ""
	for page := 0; page < maxThreadPages; page++ {
		args := []string{"api", "graphql", "-f", "query=" + threadsQuery,
			"-f", "owner=" + repo.Owner, "-f", "name=" + repo.Name, "-F", fmt.Sprintf("number=%d", number)}
		if after != "" {
			args = append(args, "-f", "after="+after)
		}
		out, err := g.ok(ctx, dir, nil, g.apiArgs(ctx, dir, args...)...)
		if err != nil {
			return nil, err
		}
		var v struct {
			Data struct {
				Repository struct {
					PullRequest struct {
						ReviewThreads struct {
							PageInfo struct {
								HasNextPage bool   `json:"hasNextPage"`
								EndCursor   string `json:"endCursor"`
							} `json:"pageInfo"`
							Nodes []ghThreadNode `json:"nodes"`
						} `json:"reviewThreads"`
					} `json:"pullRequest"`
				} `json:"repository"`
			} `json:"data"`
			Errors []struct {
				Message string `json:"message"`
			} `json:"errors"`
		}
		dec := json.NewDecoder(bytes.NewReader(out))
		dec.UseNumber()
		if err := dec.Decode(&v); err != nil {
			return nil, &Error{Op: "gh api graphql", Message: "unexpected output"}
		}
		if len(v.Errors) > 0 {
			return nil, &Error{Op: "gh api graphql", Message: trimMsg(v.Errors[0].Message)}
		}
		rt := v.Data.Repository.PullRequest.ReviewThreads
		for _, n := range rt.Nodes {
			if t := n.thread(); len(t.Comments) > 0 {
				res = append(res, t)
			}
		}
		if !rt.PageInfo.HasNextPage || rt.PageInfo.EndCursor == "" {
			break
		}
		after = rt.PageInfo.EndCursor
	}
	return res, nil
}
