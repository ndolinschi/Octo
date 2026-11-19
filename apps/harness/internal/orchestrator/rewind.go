package orchestrator

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"

	"github.com/ndolinschi/Octo/apps/harness/internal/changes"
	"github.com/ndolinschi/Octo/apps/harness/internal/events"
	"github.com/ndolinschi/Octo/apps/harness/internal/files"
	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
	"github.com/ndolinschi/Octo/apps/harness/internal/tools/local"
)

// Rewind errors.
var (
	// ErrNotRequest: the message is not one of the orchestrator's user requests.
	ErrNotRequest = errors.New("orchestrator: not a user request of this conversation")
	// ErrRewindConflict: a file cannot be restored; the report lists them.
	ErrRewindConflict = errors.New("orchestrator: files cannot be restored")
)

// Reasons of a RewindConflict.
const (
	ConflictModified    = "modified_outside" // the file is not what the harness last left
	ConflictUnavailable = "unavailable"      // the earlier content was not kept
	ConflictFolder      = "folder_missing"
)

// RewindFile is a file a rewind restores (Action "restore") or removes ("delete").
type RewindFile struct {
	Folder    string  `json:"folder"`
	Path      string  `json:"path"`
	Action    string  `json:"action"`
	ChangeIDs []int64 `json:"change_ids"`
}

// RewindConflict is a file that stops a rewind.
type RewindConflict struct {
	Folder string `json:"folder"`
	Path   string `json:"path"`
	Reason string `json:"reason"`
}

// RewindReport is what a rewind did, or with DryRun what it would do.
type RewindReport struct {
	DryRun      bool   `json:"dry_run"`
	MessageID   int64  `json:"message_id"`
	RequestText string `json:"request_text"`
	// Files are restored newest change first; Conflicts, when not empty, refuse the rewind.
	Files     []RewindFile     `json:"files"`
	Conflicts []RewindConflict `json:"conflicts"`
	// MessagesCut counts the hidden messages of every agent; AgentsCut the hidden sub-agents.
	MessagesCut int `json:"messages_cut"`
	AgentsCut   int `json:"agents_cut"`
	// ACPSessionReset: the orchestrator is an ACP agent, whose session cannot be
	// rewound in place; the next turn starts a new session with a recap.
	ACPSessionReset bool `json:"acp_session_reset"`
}

// Rewind cuts the project back to just before the user request messageID (the id
// of that request's message): the files the later turns changed are restored from
// the recorded changes, newest first, and the conversation after the request is
// hidden (soft-deleted: it stays on disk), with the memory task records and
// receipts of the cut turns dropped. A file that was changed outside the harness
// since its last recorded change stops it: nothing is touched and the report
// lists the files (ErrRewindConflict). With dryRun nothing is changed either way.
func (o *Orchestrator) Rewind(ctx context.Context, pid string, messageID int64, dryRun bool) (RewindReport, error) {
	return o.RewindSession(ctx, pid, "", messageID, dryRun)
}

// RewindSession is Rewind of one main session ("": the session the request was sent in). Only the session's own
// changes are restored; it is refused while that session runs.
func (o *Orchestrator) RewindSession(ctx context.Context, pid, sid string, messageID int64, dryRun bool) (RewindReport, error) {
	rep := RewindReport{DryRun: dryRun, MessageID: messageID, Files: []RewindFile{}, Conflicts: []RewindConflict{}}
	o.qmu.Lock()
	defer o.qmu.Unlock()
	db, err := o.store.Get(ctx, pid)
	if err != nil {
		return rep, err
	}
	text, role, agentID, _, err := db.MessageText(ctx, messageID)
	if err != nil {
		return rep, ErrNotRequest
	}
	own, err := db.SessionOfAgentRow(ctx, agentID)
	if err != nil || (sid != "" && own != sid) {
		return rep, ErrNotRequest
	}
	sid = own
	if o.RunningSession(pid, sid) || o.ActiveSession(pid, sid) {
		return rep, ErrTurnInProgress
	}
	orch, err := db.RootAgent(ctx, sid)
	if err != nil {
		return rep, err
	}
	visible, err := db.Messages(ctx, orch.ID)
	if err != nil {
		return rep, err
	}
	if role != "user" || agentID != orch.ID || text == "" || !slices.ContainsFunc(visible, func(m projectstore.Message) bool { return m.ID == messageID }) {
		return rep, ErrNotRequest
	}
	rep.RequestText = text

	all, err := db.Changes(ctx, 0)
	if err != nil {
		return rep, err
	}
	folders, err := db.Folders(ctx)
	if err != nil {
		return rep, err
	}
	type key struct{ folder, path string }
	groups := map[key][]projectstore.Change{}
	var order []key
	for _, c := range all {
		if c.TurnID < messageID || (c.SessionID != "" && c.SessionID != sid) {
			continue // before the request, or another session's work
		}
		k := key{c.Folder, c.Path}
		if _, seen := groups[k]; !seen {
			order = append(order, k)
		}
		groups[k] = append(groups[k], c)
	}
	// Newest change first: the order the files are restored in (and listed).
	slices.SortStableFunc(order, func(a, b key) int {
		return int(groups[b][len(groups[b])-1].ID - groups[a][len(groups[a])-1].ID)
	})
	type action struct {
		f      RewindFile
		root   string
		abs    string
		before string
	}
	var todo []action
	for _, k := range order {
		list := groups[k]
		first, last := list[0], list[len(list)-1]
		ids := make([]int64, len(list))
		for i := range list {
			ids[len(list)-1-i] = list[i].ID
		}
		conflict := func(reason string) {
			rep.Conflicts = append(rep.Conflicts, RewindConflict{Folder: k.folder, Path: k.path, Reason: reason})
		}
		root := ""
		for _, f := range folders {
			if f.Label == k.folder {
				root = f.Path
			}
		}
		if root == "" {
			conflict(ConflictFolder)
			continue
		}
		abs, err := local.ResolveWritable(root, k.path) // never restores a file inside .git
		if err != nil {
			conflict(ConflictFolder)
			continue
		}
		hash, exists, err := changes.HashFile(abs)
		if err != nil {
			conflict(ConflictModified)
			continue
		}
		switch {
		case last.Kind == projectstore.ChangeDeleted:
			if exists {
				conflict(ConflictModified)
				continue
			}
		case last.AfterHash == nil:
			conflict(ConflictUnavailable) // the file's state after the change was not kept: it cannot be compared
			continue
		case !exists || hash != *last.AfterHash:
			conflict(ConflictModified)
			continue
		}
		a := action{f: RewindFile{Folder: k.folder, Path: k.path, ChangeIDs: ids}, root: root, abs: abs}
		if first.Kind == projectstore.ChangeCreated {
			a.f.Action = "delete"
		} else {
			if first.BeforeHash == nil {
				conflict(ConflictUnavailable)
				continue
			}
			before, ok, err := db.Blob(ctx, *first.BeforeHash)
			if err != nil || !ok {
				conflict(ConflictUnavailable)
				continue
			}
			a.f.Action, a.before = "restore", before
		}
		todo = append(todo, a)
	}
	for _, a := range todo {
		rep.Files = append(rep.Files, a.f)
	}
	count, err := countCut(ctx, db, sid, messageID)
	if err != nil {
		return rep, err
	}
	rep.MessagesCut, rep.AgentsCut = count.messages, count.agents
	rep.ACPSessionReset = plugins.IsACPRef(o.orchestratorModel(ctx, db))
	if len(rep.Conflicts) > 0 {
		return rep, ErrRewindConflict
	}
	if dryRun {
		return rep, nil
	}
	for _, a := range todo {
		switch a.f.Action {
		case "delete":
			if err := os.Remove(a.abs); err != nil && !errors.Is(err, os.ErrNotExist) {
				return rep, err
			}
		default:
			if err := os.MkdirAll(filepath.Dir(a.abs), 0o755); err != nil {
				return rep, err
			}
			if _, err := files.Write(a.root, a.f.Path, a.before, nil); err != nil {
				return rep, err
			}
		}
		o.hub.Publish(pid, events.FileChanged, map[string]any{"folder": a.f.Folder, "path": a.f.Path, "source": events.SourceUser})
	}
	res, err := db.RewindIn(ctx, sid, messageID)
	if err != nil {
		return rep, err
	}
	rep.MessagesCut, rep.AgentsCut = res.MessagesCut, res.AgentsCut
	o.rewindBoundary(ctx, db, orch.ID)
	if rep.ACPSessionReset {
		if err := db.DeleteACPSession(ctx, orch.ID); err != nil {
			return rep, err
		}
		o.resetACPSession(skey(pid, sid))
	}
	o.hub.Publish(pid, events.ConversationRewound, map[string]any{"message_id": messageID, "request_text": text, "session_id": sid})
	o.hub.Publish(pid, events.ContextUpdated, map[string]any{"project_id": pid, "session_id": sid})
	return rep, nil
}

type cutCount struct{ messages, agents int }

// countCut says how many messages and sub-agents a rewind to messageID would hide.
func countCut(ctx context.Context, db *projectstore.DB, sid string, messageID int64) (cutCount, error) {
	n, a, err := db.CountCutIn(ctx, sid, messageID)
	return cutCount{n, a}, err
}

// orchestratorModel is the orchestrator model the project runs on now.
func (o *Orchestrator) orchestratorModel(ctx context.Context, db *projectstore.DB) string {
	rt, err := o.newRuntime(ctx, db)
	if err != nil {
		return ""
	}
	return rt.models.Orchestrator
}

// resetACPSession ends a main session's live ACP orchestrator process (key: skey): its session
// holds the cut conversation and cannot be rewound, so the next turn opens a
// new one and recaps the conversation that is left.
func (o *Orchestrator) resetACPSession(key string) {
	o.acp.mu.Lock()
	s := o.acp.sessions[key]
	o.acp.mu.Unlock()
	if s == nil {
		return
	}
	s.mu.Lock()
	s.closeLocked()
	s.mu.Unlock()
}
