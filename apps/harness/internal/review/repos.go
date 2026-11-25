package review

import (
	"context"
	"encoding/json"
	"sort"
	"strings"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/codehost"
	"github.com/ndolinschi/Octo/apps/harness/internal/gitx"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

// Roles of a repository of a folder.
const (
	RoleOrigin   = "origin"
	RoleUpstream = "upstream"
	RoleParent   = "parent"
	RoleOther    = "other"
)

// RepoAll is the value of the `repo` parameter that merges every repository.
const RepoAll = "all"

// settingRepoChoice is the project setting that remembers the person's last
// repository choice per folder: {"<folder label>": "owner/name" | "all"}.
const settingRepoChoice = "review.repo"

// RepoRef is one repository a folder works with: a remote, or the parent of a
// remote that is a fork.
type RepoRef struct {
	// Host is the adapter ("github"); Hostname the host it talks to.
	Host     string `json:"host"`
	Hostname string `json:"hostname,omitempty"`
	// Repo is "owner/name".
	Repo string `json:"repo"`
	// Remote is the git remote that points at it ("" for a parent without a remote).
	Remote  string `json:"remote,omitempty"`
	Role    string `json:"role"`
	Default bool   `json:"default"`
}

type repoEntry struct {
	ref  RepoRef
	repo codehost.Repo
}

// folderRepos lists the repositories of a folder (rule 1) and the index of the
// default one (rule 2). The code host's own default repository is used only
// when no remote names a code host.
func (s *Service) folderRepos(ctx context.Context, dir string, refresh bool) ([]repoEntry, error) {
	s.mu.Lock()
	c, ok := s.repoCache[dir]
	s.mu.Unlock()
	if ok && !refresh && s.now().Sub(c.at) < ListTTL {
		return append([]repoEntry(nil), c.ents...), nil
	}
	ents, err := s.loadFolderRepos(ctx, dir)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	s.repoCache[dir] = cachedRepos{ents: ents, at: s.now()}
	s.mu.Unlock()
	return append([]repoEntry(nil), ents...), nil
}

type cachedRepos struct {
	ents []repoEntry
	at   time.Time
}

func (s *Service) loadFolderRepos(ctx context.Context, dir string) ([]repoEntry, error) {
	adapter := s.host.Name()
	remotes := codehost.Remotes(ctx, dir)
	rank := func(n string) int {
		switch n {
		case "origin":
			return 0
		case "upstream":
			return 1
		}
		return 2
	}
	sort.SliceStable(remotes, func(i, j int) bool { return rank(remotes[i].Name) < rank(remotes[j].Name) })

	var out []repoEntry
	has := func(r codehost.Repo) bool {
		for _, e := range out {
			if codehost.SameRepo(e.repo, r) {
				return true
			}
		}
		return false
	}
	add := func(r codehost.Repo, remote, role string) {
		if has(r) {
			return
		}
		out = append(out, repoEntry{repo: r, ref: RepoRef{Host: adapter, Hostname: r.Host, Repo: r.String(), Remote: remote, Role: role}})
	}
	if len(remotes) == 0 {
		// Nothing names a code host (an ssh alias, say): the only candidate is gh's own answer.
		r, err := s.host.Repo(ctx, dir)
		if err != nil {
			return nil, err
		}
		// gh's own answer is the only candidate: keep the host for display only, so the
		// calls still leave a GH_HOST of the person's environment alone.
		h := r.Host
		r.Host = ""
		add(r, "", RoleOrigin)
		out[0].ref.Hostname = h
	}
	for _, rm := range remotes {
		role := RoleOther
		switch rm.Name {
		case "origin":
			role = RoleOrigin
		case "upstream":
			role = RoleUpstream
		}
		add(codehost.Repo{Owner: rm.Owner, Name: rm.Repo, Host: rm.Host, URL: "https://" + rm.Host + "/" + rm.Owner + "/" + rm.Repo}, rm.Name, role)
	}
	// The parent of a remote that is a fork (a failed lookup is not an error).
	for _, e := range append([]repoEntry(nil), out...) {
		info, err := s.host.RepoInfo(ctx, dir, e.repo)
		if err != nil || !info.IsFork || info.Parent == nil {
			continue
		}
		p := *info.Parent
		if p.Host == "" {
			p.Host = e.repo.Host
		}
		add(p, "", RoleParent)
	}
	if len(out) == 0 {
		return nil, &codehost.Unavailable{Reason: codehost.ReasonNoRepo, Message: "This folder has no GitHub remote.", Command: codehost.CommandNoRepoRemote}
	}
	def := 0
	tracked := ""
	if t, err := gitx.TrackingRemote(ctx, dir); err == nil {
		tracked = t
	}
	for _, name := range []string{tracked, "origin"} {
		if name == "" {
			continue
		}
		found := false
		for i, e := range out {
			if e.ref.Remote == name {
				def, found = i, true
				break
			}
		}
		if found {
			break
		}
	}
	out[def].ref.Default = true
	return out, nil
}

func refsOf(es []repoEntry) []RepoRef {
	r := make([]RepoRef, 0, len(es))
	for _, e := range es {
		r = append(r, e.ref)
	}
	return r
}

func defaultOf(es []repoEntry) int {
	for i, e := range es {
		if e.ref.Default {
			return i
		}
	}
	return 0
}

func findRepo(es []repoEntry, name string) (int, bool) {
	name = strings.TrimSpace(name)
	// "host/owner/name" is accepted as well as "owner/name".
	for i, e := range es {
		if strings.EqualFold(e.ref.Repo, name) || strings.EqualFold(e.repo.Host+"/"+e.ref.Repo, name) {
			return i, true
		}
	}
	return 0, false
}

func loadChoices(ctx context.Context, db *projectstore.DB) map[string]string {
	m := map[string]string{}
	if raw, ok, err := db.Setting(ctx, settingRepoChoice); err == nil && ok {
		_ = json.Unmarshal([]byte(raw), &m)
	}
	return m
}

// remembered is the person's last repository choice for the folder ("" when none).
func remembered(ctx context.Context, db *projectstore.DB, label string) string {
	return loadChoices(ctx, db)[label]
}

func remember(ctx context.Context, db *projectstore.DB, label, choice string) {
	m := loadChoices(ctx, db)
	if m[label] == choice {
		return
	}
	m[label] = choice
	if b, err := json.Marshal(m); err == nil {
		_ = db.SetSetting(ctx, settingRepoChoice, string(b))
	}
}

// repoNames is the list of repositories for a refusal message.
func repoNames(es []repoEntry) string {
	n := make([]string, 0, len(es))
	for _, e := range es {
		n = append(n, e.ref.Repo)
	}
	return strings.Join(n, ", ")
}
