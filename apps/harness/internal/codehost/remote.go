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
			res = append(res, Remote{Name: name, Host: h, Owner: o, Repo: r})
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

type repoHintKey struct{}

// WithRepoHint tells the adapter which repository ("owner/name") a call is
// about, so a folder with several remotes uses the right host.
func WithRepoHint(ctx context.Context, repo string) context.Context {
	return context.WithValue(ctx, repoHintKey{}, repo)
}

func repoHint(ctx context.Context) string {
	s, _ := ctx.Value(repoHintKey{}).(string)
	return s
}
