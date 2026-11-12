package codehost

import (
	"context"
	"net/url"
	"sort"
	"strings"

	"github.com/ndolinschi/Octo/apps/harness/internal/gitx"
)

// Remote is a git remote parsed into the host, owner and repository it names.
type Remote struct {
	Name  string
	Host  string // "github.com", "ghe.example.com", "ghe.example.com:8443"
	Owner string
	Repo  string
	// URL is the remote's address as configured (not rewritten by url.<base>.insteadOf).
	URL string
}

// ParseRemoteURL reads the host, owner and repository out of a remote URL:
// https://host/o/r(.git), ssh://git@host[:port]/o/r, git@host:o/r. A local path
// or anything else is not a code-host remote (ok is false). A nested path
// (GitLab groups) keeps its last two segments.
func ParseRemoteURL(raw string) (host, owner, repo string, ok bool) {
	raw = strings.TrimSpace(raw)
	var path string
	if strings.Contains(raw, "://") {
		u, err := url.Parse(raw)
		if err != nil || u.Host == "" || u.Scheme == "file" {
			return "", "", "", false
		}
		host, path = u.Host, u.Path
	} else {
		// scp-like: [user@]host:owner/repo
		left, right, found := strings.Cut(raw, ":")
		if !found || left == "" || strings.ContainsAny(left, `/\`) || strings.HasPrefix(right, "/") {
			return "", "", "", false
		}
		host, path = left, right
		if len(host) == 1 { // a Windows drive letter, not a host
			return "", "", "", false
		}
	}
	if i := strings.LastIndex(host, "@"); i >= 0 {
		host = host[i+1:]
	}
	path = strings.TrimSuffix(strings.Trim(path, "/"), ".git")
	segs := strings.Split(path, "/")
	if len(segs) < 2 || segs[len(segs)-1] == "" || segs[len(segs)-2] == "" || host == "" {
		return "", "", "", false
	}
	return strings.ToLower(host), segs[len(segs)-2], segs[len(segs)-1], true
}

// Remotes lists the folder's remotes by their configured (not rewritten) URL,
// sorted by name. A URL that `url.<base>.insteadOf` rewrites is still read as
// written, because that is the address gh matches to a host.
func Remotes(ctx context.Context, dir string) []Remote {
	out, err := gitx.Run(ctx, dir, "config", "--get-regexp", `^remote\..+\.url$`)
	if err != nil {
		return nil
	}
	var res []Remote
	for _, line := range strings.Split(string(out), "\n") {
		key, val, ok := strings.Cut(strings.TrimSpace(line), " ")
		if !ok {
			continue
		}
		name := strings.TrimSuffix(strings.TrimPrefix(key, "remote."), ".url")
		if h, o, r, ok := ParseRemoteURL(val); ok {
			res = append(res, Remote{Name: name, Host: h, Owner: o, Repo: r, URL: strings.TrimSpace(val)})
		}
	}
	sort.Slice(res, func(i, j int) bool { return res[i].Name < res[j].Name })
	return res
}

// PickRemote chooses the remote a call about repo ("owner/name", may be "")
// belongs to: the one that names the repository, else origin, else the first.
func PickRemote(remotes []Remote, repo string) (Remote, bool) {
	if len(remotes) == 0 {
		return Remote{}, false
	}
	if repo != "" {
		for _, r := range remotes {
			if strings.EqualFold(r.Owner+"/"+r.Repo, repo) {
				return r, true
			}
		}
	}
	for _, r := range remotes {
		if r.Name == "origin" {
			return r, true
		}
	}
	return remotes[0], true
}

type repoCtxKey struct{}

// WithRepo tells the adapter which repository a call is about, so a folder
// with several remotes (a fork and its parent) uses the right repository and host.
func WithRepo(ctx context.Context, repo Repo) context.Context {
	return context.WithValue(ctx, repoCtxKey{}, repo)
}

// WithRepoHint is WithRepo for a bare "owner/name".
func WithRepoHint(ctx context.Context, repo string) context.Context {
	o, n, _ := strings.Cut(repo, "/")
	return WithRepo(ctx, Repo{Owner: o, Name: n})
}

func ctxRepo(ctx context.Context) Repo {
	r, _ := ctx.Value(repoCtxKey{}).(Repo)
	return r
}

// RepoArg is the value of gh's --repo flag: [HOST/]OWNER/REPO.
func RepoArg(r Repo) string {
	if r.Host != "" {
		return r.Host + "/" + r.String()
	}
	return r.String()
}

// SameRepo reports whether a and b name the same repository (case-insensitive;
// the host counts only when both have one).
func SameRepo(a, b Repo) bool {
	if !strings.EqualFold(a.Owner, b.Owner) || !strings.EqualFold(a.Name, b.Name) {
		return false
	}
	return a.Host == "" || b.Host == "" || strings.EqualFold(a.Host, b.Host)
}

// FetchURL is the address to fetch repo's pull requests from: the URL of the
// remote that names the repository, else that of another remote on the same
// host with owner and name replaced (so the scheme and the credentials a
// person set up for the host keep working), else https. ok is false when the
// folder has no code-host remote at all.
func FetchURL(remotes []Remote, repo Repo) (string, bool) {
	if len(remotes) == 0 {
		return "", false
	}
	for _, r := range remotes {
		if r.URL != "" && strings.EqualFold(r.Owner, repo.Owner) && strings.EqualFold(r.Repo, repo.Name) &&
			(repo.Host == "" || strings.EqualFold(r.Host, repo.Host)) {
			return r.URL, true
		}
	}
	var tmpl *Remote
	for i := range remotes {
		if repo.Host == "" || strings.EqualFold(remotes[i].Host, repo.Host) {
			if tmpl == nil || remotes[i].Name == "origin" {
				tmpl = &remotes[i]
			}
		}
	}
	if tmpl == nil {
		host := repo.Host
		if host == "" {
			host = remotes[0].Host
		}
		return "https://" + host + "/" + repo.String() + ".git", true
	}
	trimmed := strings.TrimRight(tmpl.URL, "/")
	suffix := ""
	if strings.HasSuffix(trimmed, ".git") {
		suffix = ".git"
	}
	u := strings.TrimSuffix(trimmed, ".git")
	old := tmpl.Owner + "/" + tmpl.Repo
	if len(u) >= len(old) && strings.EqualFold(u[len(u)-len(old):], old) {
		return u[:len(u)-len(old)] + repo.String() + suffix, true
	}
	return "https://" + tmpl.Host + "/" + repo.String() + ".git", true
}
