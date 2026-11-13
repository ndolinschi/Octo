package changes

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"sync"

	"github.com/ndolinschi/Octo/apps/harness/internal/diff"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

// Folder is a project folder: its label and absolute path.
type Folder struct{ Label, Path string }

// Scope says who a recorded change belongs to.
type Scope struct {
	// TurnID is the id of the orchestrator's user message that started the turn.
	TurnID    int64
	AgentID   string
	ToolUseID string
	// Source is "write_file", "acp_fs", "bash" or "acp_turn".
	Source string
}

// Sources of a change.
const (
	SourceWriteFile = "write_file"
	SourceACPFS     = "acp_fs"
	SourceBash      = "bash"
	SourceACPTurn   = "acp_turn"
)

type entry struct {
	stamp
	// hash is "" for a file that was not read (too large to keep).
	hash   string
	shadow bool
}

// Tracker records the changes of one project. It keeps, per folder, an index
// of every file seen (size, mtime, hash) and a copy of each text file up to
// MaxShadowFile in the project's data directory (the pre-image of a later
// change), within MaxShadowTotal; past that a change is recorded without diff.
type Tracker struct {
	db *projectstore.DB
	// OnChange is called for every recorded change (outside the tracker's lock).
	OnChange func(projectstore.Change)

	shadowDir string

	mu          sync.Mutex
	idx         map[string]map[string]*entry // folder path -> slash path -> entry
	shadowHave  map[string]int64             // hash -> size of the shadow copy
	shadowBytes int64
	inflight    int
}

// NewTracker starts with an empty pre-image store (a previous process's copies
// are removed: the index that described them is gone).
func NewTracker(db *projectstore.DB) *Tracker {
	t := &Tracker{
		db: db, shadowDir: filepath.Join(db.Dir(), "shadow"),
		idx: map[string]map[string]*entry{}, shadowHave: map[string]int64{},
	}
	_ = os.RemoveAll(t.shadowDir)
	return t
}

// Begin takes the "before" snapshot. While another snapshot window is open the
// folders are not rescanned (that would absorb the other window's changes
// unrecorded); the first window to end gets them.
func (t *Tracker) Begin(ctx context.Context, folders []Folder) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.inflight == 0 {
		t.scan(ctx, folders, false, Scope{}, nil)
	}
	t.inflight++
}

// End takes the "after" snapshot and records what differs from the index as
// changes of scope. Every Begin needs one End.
func (t *Tracker) End(ctx context.Context, folders []Folder, scope Scope) []projectstore.Change {
	var recorded []projectstore.Change
	t.mu.Lock()
	t.inflight = max(t.inflight-1, 0)
	t.scan(context.WithoutCancel(ctx), folders, true, scope, &recorded)
	t.mu.Unlock()
	t.notify(recorded)
	return recorded
}

func (t *Tracker) notify(list []projectstore.Change) {
	if t.OnChange == nil {
		return
	}
	for _, c := range list {
		t.OnChange(c)
	}
}

// PreWrite reads the file as it is before an explicit write.
func (t *Tracker) PreWrite(abs string) Side {
	s, err := ReadSide(abs)
	if err != nil {
		slog.Warn("change tracking: read before write", "err", err)
	}
	return s
}

// PostWrite records the change an explicit write made to rel under f and
// updates the index so a later snapshot does not count it again.
func (t *Tracker) PostWrite(ctx context.Context, scope Scope, f Folder, rel string, before Side) (projectstore.Change, bool) {
	abs := filepath.Join(f.Path, filepath.FromSlash(rel))
	after, err := ReadSide(abs)
	if err != nil {
		slog.Warn("change tracking: read after write", "err", err)
		return projectstore.Change{}, false
	}
	t.mu.Lock()
	if m := t.idx[f.Path]; m != nil {
		t.setIndex(m, rel, abs, after)
	}
	c, ok := t.record(context.WithoutCancel(ctx), scope, f.Label, rel, before, after)
	t.mu.Unlock()
	if ok {
		t.notify([]projectstore.Change{c})
	}
	return c, ok
}

// setIndex stores the file's current state in the index (and the pre-image copy).
func (t *Tracker) setIndex(m map[string]*entry, rel, abs string, s Side) {
	if !s.Exists {
		delete(m, rel)
		return
	}
	e := &entry{hash: s.Hash}
	if fi, err := os.Lstat(abs); err == nil {
		e.stamp = stamp{fi.Size(), fi.ModTime().UnixNano()}
	}
	if s.Blob != nil && len(s.Blob) <= MaxShadowFile {
		e.shadow = t.shadowPut(s.Hash, s.Blob)
	}
	m[rel] = e
}

// scan walks every folder. With record false it only brings the index up to
// date; with record true each difference becomes a change of scope.
func (t *Tracker) scan(ctx context.Context, folders []Folder, record bool, scope Scope, out *[]projectstore.Change) {
	for _, f := range folders {
		if ctx.Err() != nil && !record {
			return
		}
		files, truncated := list(ctx, f.Path)
		if truncated {
			warnTruncated(f.Path)
		}
		m := t.idx[f.Path]
		if m == nil {
			m = map[string]*entry{}
			t.idx[f.Path] = m
			t.baseline(f, files, m)
			continue
		}
		for rel, st := range files {
			old := m[rel]
			if old != nil && old.stamp == st {
				continue
			}
			abs := filepath.Join(f.Path, filepath.FromSlash(rel))
			after, err := ReadSide(abs)
			if err != nil || !after.Exists {
				continue
			}
			before := t.sideOfEntry(old)
			if old != nil && old.hash != "" && old.hash == after.Hash {
				old.stamp = st // touched, not changed
				continue
			}
			t.setIndex(m, rel, abs, after)
			if record {
				t.recordInto(ctx, scope, f.Label, rel, before, after, out)
			}
		}
		for rel, old := range m {
			if _, ok := files[rel]; ok {
				continue
			}
			abs := filepath.Join(f.Path, filepath.FromSlash(rel))
			if _, err := os.Lstat(abs); err == nil || !errors.Is(err, os.ErrNotExist) {
				continue // still there (beyond the walk cap) or unreadable
			}
			delete(m, rel)
			if record {
				t.recordInto(ctx, scope, f.Label, rel, t.sideOfEntry(old), Side{}, out)
			}
		}
	}
}

func (t *Tracker) recordInto(ctx context.Context, scope Scope, folder, rel string, before, after Side, out *[]projectstore.Change) {
	if c, ok := t.record(ctx, scope, folder, rel, before, after); ok && out != nil {
		*out = append(*out, c)
	}
}

// baseline indexes a folder seen for the first time: nothing is recorded.
func (t *Tracker) baseline(f Folder, files map[string]stamp, m map[string]*entry) {
	for rel, st := range files {
		e := &entry{stamp: st}
		if st.size <= MaxShadowFile {
			abs := filepath.Join(f.Path, filepath.FromSlash(rel))
			if data, err := os.ReadFile(abs); err == nil {
				e.hash = hashBytes(data)
				if isText(data) {
					e.shadow = t.shadowPut(e.hash, data)
				}
			}
		}
		m[rel] = e
	}
}

// sideOfEntry rebuilds a file's earlier state from the index and the pre-image
// store. Without a copy the side has no blob.
func (t *Tracker) sideOfEntry(e *entry) Side {
	if e == nil {
		return Side{}
	}
	s := Side{Exists: true, Size: e.size, Hash: e.hash}
	if e.shadow {
		if data, err := t.shadowGet(e.hash); err == nil {
			s.Blob = data
			return s
		}
	}
	s.Note = projectstore.NoteNoPreimage
	if e.size > MaxShadowFile {
		s.Note = projectstore.NoteTooLarge
	}
	return s
}

// record stores one change; false when before and after are the same content.
func (t *Tracker) record(ctx context.Context, scope Scope, folder, rel string, before, after Side) (projectstore.Change, bool) {
	kind := projectstore.ChangeModified
	switch {
	case !before.Exists && !after.Exists:
		return projectstore.Change{}, false
	case !before.Exists:
		kind = projectstore.ChangeCreated
	case !after.Exists:
		kind = projectstore.ChangeDeleted
	case before.Hash != "" && before.Hash == after.Hash:
		return projectstore.Change{}, false
	}
	nc := projectstore.NewChange{Change: projectstore.Change{
		TurnID: scope.TurnID, AgentID: scope.AgentID, Folder: folder, Path: rel, Kind: kind,
		Source: scope.Source, ToolUseID: scope.ToolUseID,
	}}
	if before.Exists && before.Hash != "" {
		nc.BeforeHash, nc.BeforeBlob = &before.Hash, before.Blob
	}
	if after.Exists && after.Hash != "" {
		nc.AfterHash, nc.AfterBlob = &after.Hash, after.Blob
	}
	// A diff needs the content of every side that exists.
	switch {
	case before.Exists && before.Blob == nil:
		nc.Note = firstNote(before.Note, projectstore.NoteNoPreimage)
	case after.Exists && after.Blob == nil:
		nc.Note = firstNote(after.Note, projectstore.NoteTooLarge)
	default:
		a, r := diff.Count(string(before.Blob), string(after.Blob))
		nc.Added, nc.Removed = &a, &r
	}
	c, err := t.db.AddChange(ctx, nc)
	if err != nil {
		slog.Error("record change", "folder", folder, "path", rel, "err", err)
		return projectstore.Change{}, false
	}
	return c, true
}

func firstNote(n, def string) string {
	if n != "" {
		return n
	}
	return def
}
