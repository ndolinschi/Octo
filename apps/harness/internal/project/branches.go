package project

import (
	"context"
	"errors"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/ndolinschi/Octo/apps/harness/internal/gitx"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
	"github.com/ndolinschi/Octo/apps/harness/internal/usererr"
)

// Branch choice in the composer (UI decision 98): the branches of each repository a workspace's folders are in,
// and switching the main checkout when nothing can be lost or disturbed.

// DefaultBranchLimit and MaxBranchLimit bound one chunk of GET /branches.
const (
	DefaultBranchLimit = 30
	MaxBranchLimit     = 100
)

// RepoBranch is one repository of a workspace: its checked-out branch and a chunk of its local branches.
type RepoBranch struct {
	// FolderID and Folder (label) name the first project folder in the repository; Folders lists every one.
	FolderID string   `json:"folder_id"`
	Folder   string   `json:"folder"`
	Folders  []string `json:"folders"`
	RepoRoot string   `json:"repo_root"`
	RepoName string   `json:"repo_name"`
	// Branch is the checked-out branch ("" on a detached HEAD); Head the short commit.
	Branch     string `json:"branch"`
	Detached   bool   `json:"detached"`
	Head       string `json:"head"`
	DirtyFiles int    `json:"dirty_files"`
	// Branches: current first (when it matches the query), then by last commit; Total counts the matching ones.
	Branches   []gitx.Branch `json:"branches"`
	Total      int           `json:"total"`
	NextOffset *int          `json:"next_offset,omitempty"`
	Truncated  bool          `json:"truncated,omitempty"`
}

// BranchesQuery is GET /branches's query.
type BranchesQuery struct {
	Folder, Workspace, Query string
	Offset, Limit            int
}

// BranchesResult answers GET /branches.
type BranchesResult struct {
	Workspace string `json:"workspace"`
	// RunningSessions: main sessions working or waiting in this workspace (a switch is refused while > 0).
	RunningSessions int          `json:"running_sessions"`
	Repos           []RepoBranch `json:"repos"`
}

// SwitchBranchInput is the body of POST /branches/switch.
type SwitchBranchInput struct {
	Folder string `json:"folder"`
	Branch string `json:"branch"`
	Create bool   `json:"create"`
}

// SwitchBranchResult answers POST /branches/switch: the repository as it is after the switch.
type SwitchBranchResult struct {
	Repo RepoBranch `json:"repo"`
}

type repoOf struct {
	folderID, label, path, root string
	labels                      []string
}

// repos groups a workspace's folders by git repository, in folder order; non-git folders are left out.
func repos(ctx context.Context, folders []projectstore.WorkspaceFolder) []repoOf {
	var out []repoOf
	at := map[string]int{}
	for _, f := range folders {
		if !gitx.IsRepo(ctx, f.Path) {
			continue
		}
		root, err := gitx.TopLevel(ctx, f.Path)
		if err != nil {
			continue
		}
		label := f.FolderLabel
		if label == "" {
			label = filepath.Base(f.Path)
		}
		if i, ok := at[root]; ok {
			out[i].labels = append(out[i].labels, label)
			continue
		}
		at[root] = len(out)
		out = append(out, repoOf{folderID: f.FolderID, label: label, path: f.Path, root: root, labels: []string{label}})
	}
	return out
}

func (r repoOf) matches(folder string) bool {
	if r.folderID == folder || r.label == folder {
		return true
	}
	for _, l := range r.labels {
		if l == folder {
			return true
		}
	}
	return false
}

func readRepo(ctx context.Context, r repoOf, query string, offset, limit int) (RepoBranch, error) {
	out := RepoBranch{
		FolderID: r.folderID, Folder: r.label, Folders: r.labels, RepoRoot: r.root, RepoName: filepath.Base(r.root),
		Branch: gitx.CurrentBranch(ctx, r.path), Head: gitx.ShortHead(ctx, r.path), Branches: []gitx.Branch{},
	}
	out.Detached = out.Branch == "" && out.Head != ""
	if files, err := gitx.DirtyFiles(ctx, r.path); err == nil {
		out.DirtyFiles = len(files)
	}
	if out.Head == "" {
		return out, nil // a repository without a commit has no branch to list
	}
	list, total, truncated, err := gitx.LocalBranchesMatching(ctx, r.path, "HEAD", query, offset, limit)
	if err != nil {
		return out, of(KindConflict, usererr.BranchSwitchFailed(err.Error()))
	}
	out.Branches, out.Total, out.Truncated = list, total, truncated
	if next := offset + len(list); len(list) > 0 && next < total {
		out.NextOffset = &next
	}
	return out, nil
}

func (s *Service) workspaceFolders(ctx context.Context, db *projectstore.DB, wid string) (projectstore.Workspace, error) {
	ws, err := db.GetWorkspace(ctx, wid)
	if errors.Is(err, projectstore.ErrNotFound) {
		return ws, of(KindNotFound, usererr.WorkspaceNotFound(wid))
	}
	if err != nil {
		return ws, storeErr(err)
	}
	return ws, nil
}

// runningIn counts the main sessions working or waiting in workspace wid.
func (s *Service) runningIn(ctx context.Context, db *projectstore.DB, pid, wid string) (int, error) {
	list, err := db.ListSessions(ctx, projectstore.SessionFilter{Kind: projectstore.KindMain, Limit: -1})
	if err != nil {
		return 0, storeErr(err)
	}
	st, live := s.turns.(SessionTurns)
	n := 0
	for _, info := range list {
		in := projectstore.SharedWorkspace
		if info.Workspace != nil && info.Workspace.ID != "" {
			in = info.Workspace.ID
		}
		if in != wid {
			continue
		}
		if (live && (st.RunningSession(pid, info.ID) || st.ActiveSession(pid, info.ID))) ||
			info.State == projectstore.SessionWorking || info.State == projectstore.SessionWaiting {
			n++
		}
	}
	return n, nil
}

// Branches is GET /v1/projects/{pid}/branches: per repository of the workspace's folders (absent: the main
// checkout), the current branch and a chunk of local branches. Only git is read; nothing changes.
func (s *Service) Branches(ctx context.Context, pid string, q BranchesQuery) (BranchesResult, error) {
	if q.Offset < 0 || q.Limit < 0 {
		return BranchesResult{}, of(KindInvalid, usererr.InvalidPage())
	}
	limit := q.Limit
	if limit == 0 {
		limit = DefaultBranchLimit
	}
	limit = min(limit, MaxBranchLimit)
	db, err := s.db(ctx, pid)
	if err != nil {
		return BranchesResult{}, err
	}
	ws, err := s.workspaceFolders(ctx, db, q.Workspace)
	if err != nil {
		return BranchesResult{}, err
	}
	out := BranchesResult{Workspace: ws.ID, Repos: []RepoBranch{}}
	if out.RunningSessions, err = s.runningIn(ctx, db, pid, ws.ID); err != nil {
		return BranchesResult{}, err
	}
	all := repos(ctx, ws.Folders)
	folder := strings.TrimSpace(q.Folder)
	found := folder == ""
	for _, r := range all {
		if folder != "" && !r.matches(folder) {
			continue
		}
		found = true
		rb, err := readRepo(ctx, r, q.Query, q.Offset, limit)
		if err != nil {
			return BranchesResult{}, err
		}
		out.Repos = append(out.Repos, rb)
	}
	if !found {
		return BranchesResult{}, s.unknownFolder(ctx, db, folder)
	}
	return out, nil
}

// unknownFolder is the refusal for a folder that is in no listed repository: not a git folder, or no folder.
func (s *Service) unknownFolder(ctx context.Context, db *projectstore.DB, folder string) error {
	folders, err := db.Folders(ctx)
	if err != nil {
		return storeErr(err)
	}
	for _, f := range folders {
		if folder == "" || f.ID == folder || f.Label == folder {
			return of(KindConflict, usererr.NotAGitRepository(f.Path))
		}
	}
	return of(KindNotFound, usererr.NotFoundWhat("folder"))
}

// SwitchBranch is POST /v1/projects/{pid}/branches/switch: `git switch` (or `git switch -c` with create) in the
// main checkout's repository of folder (absent: the first git folder). Refused, with nothing changed, while the
// tracked files have uncommitted changes or a session works in the main checkout. It never forces, stashes,
// discards or commits.
func (s *Service) SwitchBranch(ctx context.Context, pid string, in SwitchBranchInput) (SwitchBranchResult, error) {
	name := strings.TrimSpace(in.Branch)
	if name == "" {
		return SwitchBranchResult{}, of(KindInvalid, usererr.InvalidBranchName(""))
	}
	db, err := s.db(ctx, pid)
	if err != nil {
		return SwitchBranchResult{}, err
	}
	ws, err := s.workspaceFolders(ctx, db, projectstore.SharedWorkspace)
	if err != nil {
		return SwitchBranchResult{}, err
	}
	var repo *repoOf
	for _, r := range repos(ctx, ws.Folders) {
		if in.Folder == "" || r.matches(in.Folder) {
			repo = &r
			break
		}
	}
	if repo == nil {
		return SwitchBranchResult{}, s.unknownFolder(ctx, db, in.Folder)
	}
	if in.Create {
		if !gitx.ValidBranchName(ctx, repo.path, name) {
			return SwitchBranchResult{}, of(KindInvalid, usererr.InvalidBranchName(name))
		}
		if gitx.BranchExists(ctx, repo.path, name) {
			return SwitchBranchResult{}, of(KindConflict, usererr.BranchExists(name))
		}
	} else if !gitx.ValidRefName(name) || !gitx.BranchExists(ctx, repo.path, name) {
		return SwitchBranchResult{}, of(KindNotFound, usererr.BranchNotFound(name))
	}
	running, err := s.runningIn(ctx, db, pid, projectstore.SharedWorkspace)
	if err != nil {
		return SwitchBranchResult{}, err
	}
	if running > 0 {
		return SwitchBranchResult{}, of(KindConflict, usererr.CheckoutInUse(running))
	}
	files, err := gitx.DirtyFiles(ctx, repo.path)
	if err != nil {
		return SwitchBranchResult{}, of(KindConflict, usererr.BranchSwitchFailed(err.Error()))
	}
	if len(files) > 0 {
		return SwitchBranchResult{}, of(KindConflict, usererr.UncommittedChanges(fileList(files)))
	}
	if gitx.CurrentBranch(ctx, repo.path) != name || in.Create {
		if err := gitx.SwitchBranch(ctx, repo.path, name, in.Create); err != nil {
			return SwitchBranchResult{}, of(KindConflict, usererr.BranchSwitchFailed(err.Error()))
		}
	}
	rb, err := readRepo(ctx, *repo, "", 0, DefaultBranchLimit)
	if err != nil {
		return SwitchBranchResult{}, err
	}
	return SwitchBranchResult{Repo: rb}, nil
}

// fileList is up to 20 paths, comma-separated, with the count of the rest.
func fileList(files []string) string {
	const show = 20
	if len(files) <= show {
		return strings.Join(files, ", ")
	}
	return strings.Join(files[:show], ", ") + ", and " + strconv.Itoa(len(files)-show) + " more"
}
