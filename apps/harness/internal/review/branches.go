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
}

// Branches lists the local branches of a folder, the current one first, then by last
// commit date, with ahead/behind counts against base. It only reads the local
// repository: no network, no code host. base defaults to the default branch of the
// default remote (the one the current branch tracks, else origin, else the first);
// when the remote-tracking ref of base exists the counts are against it.
func (s *Service) Branches(ctx context.Context, pid, folder, base string) (BranchList, error) {
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
	list, truncated, err := gitx.LocalBranches(ctx, dir, compare)
	if err != nil {
		return out, gitErr(err)
	}
	out.Branches, out.Truncated = list, truncated
	return out, nil
}
