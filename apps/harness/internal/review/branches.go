package review

import (
	"context"
	"sort"
	"strings"

	"github.com/ndolinschi/Octo/apps/harness/internal/gitx"
)

// BranchList is the answer of Branches: the folder's local branches for a
// local-branch review, each with its distance from the base.
type BranchList struct {
	Folder string `json:"folder"`
	// Base is the branch the counts are against; DefaultBase the default branch of the
	// default remote ("" when none can be told).
	Base        string        `json:"base"`
	DefaultBase string        `json:"default_base"`
	Branches    []gitx.Branch `json:"branches"`
	// Truncated: the folder has more than gitx.MaxBranches local branches.
	Truncated bool `json:"truncated,omitempty"`
	Page      int  `json:"page,omitempty"`
	PerPage   int  `json:"per_page,omitempty"`
	Total     int  `json:"total,omitempty"`
	NextPage  *int `json:"next_page,omitempty"`
}

// DefaultBranchPerPage is the default chunk size when paged branches are requested.
const DefaultBranchPerPage = 25

// Branches lists the local branches of a folder, the current one first, then by last
// commit date, with ahead/behind counts against base. It only reads the local
// repository: no network, no code host. base defaults to the default branch of the
// default remote (the one the current branch tracks, else origin, else the first);
// when the remote-tracking ref of base exists the counts are against it.
func (s *Service) Branches(ctx context.Context, pid, folder, base string) (BranchList, error) {
	return s.BranchesPage(ctx, pid, folder, base, 0, 0)
}

// BranchesPage lists a chunk of local branches of a folder when page or perPage
// is positive, or up to gitx.MaxBranches when both are zero.
func (s *Service) BranchesPage(ctx context.Context, pid, folder, base string, page, perPage int) (BranchList, error) {
	if page < 0 || perPage < 0 {
		return BranchList{}, invalid("invalid_request", "page and per_page must be positive")
	}
	db, err := s.db(ctx, pid)
	if err != nil {
		return BranchList{}, err
	}
	label, dir, err := s.folder(ctx, db, folder)
	if err != nil {
		return BranchList{}, err
	}
	remote, _ := gitx.TrackingRemote(ctx, dir)
	remotes, _ := gitx.Remotes(ctx, dir)
	if _, ok := remotes[remote]; !ok {
		remote = ""
	}
	if remote == "" {
		if _, ok := remotes["origin"]; ok {
			remote = "origin"
		} else {
			var names []string
			for n := range remotes {
				names = append(names, n)
			}
			sort.Strings(names)
			if len(names) > 0 {
				remote = names[0]
			}
		}
	}
	out := BranchList{Folder: label, Branches: []gitx.Branch{}}
	out.DefaultBase = gitx.DefaultBranch(ctx, dir, remote)
	out.Base = strings.TrimSpace(base)
	if out.Base == "" {
		out.Base = out.DefaultBase
	}
	if out.Base == "" {
		return out, invalid("invalid_request", "the folder has no default branch (main or master); pass base")
	}
	if !gitx.ValidRefName(out.Base) {
		return out, invalid("invalid_ref", "base must be a branch, tag or commit name")
	}
	compare := out.Base
	if remote != "" {
		if _, err := gitx.Resolve(ctx, dir, "refs/remotes/"+remote+"/"+out.Base); err == nil {
			compare = "refs/remotes/" + remote + "/" + out.Base
		}
	}
	if _, err := gitx.Resolve(ctx, dir, compare); err != nil {
		return out, invalid("unknown_ref", "%v", err)
	}
	paged := page > 0 || perPage > 0
	offset, limit := 0, gitx.MaxBranches
	if paged {
		if page == 0 {
			page = 1
		}
		if perPage == 0 {
			perPage = DefaultBranchPerPage
		}
		perPage = min(perPage, gitx.MaxBranches)
		offset = (page - 1) * perPage
		limit = perPage
	}
	list, total, truncated, err := gitx.LocalBranchesChunk(ctx, dir, compare, offset, limit)
	if err != nil {
		return out, gitErr(err)
	}
	out.Branches, out.Truncated, out.Total = list, truncated, total
	if paged {
		out.Page, out.PerPage = page, perPage
		if offset+len(list) < total {
			n := page + 1
			out.NextPage = &n
		}
	}
	return out, nil
}
