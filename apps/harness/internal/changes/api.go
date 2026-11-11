package changes

import (
	"context"
	"slices"

	"github.com/ndolinschi/Octo/apps/harness/internal/diff"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

// FileChange is the JSON of one recorded change.
type FileChange struct {
	ID        int64  `json:"id"`
	TurnID    int64  `json:"turn_id"`
	AgentID   string `json:"agent_id"`
	Folder    string `json:"folder"`
	Path      string `json:"path"`
	Kind      string `json:"kind"`
	Added     *int   `json:"added"`
	Removed   *int   `json:"removed"`
	CreatedAt string `json:"created_at"`
	// Note says why there is no diff: binary, too_large, no_preimage or pruned; "" when there is one.
	Note string `json:"note"`
	// Source is write_file, acp_fs, bash or acp_turn.
	Source string `json:"source"`
}

// ToFileChange converts a stored change.
func ToFileChange(c projectstore.Change) FileChange {
	return FileChange{
		ID: c.ID, TurnID: c.TurnID, AgentID: c.AgentID, Folder: c.Folder, Path: c.Path, Kind: c.Kind,
		Added: c.Added, Removed: c.Removed, CreatedAt: c.CreatedAt, Note: c.Note, Source: c.Source,
	}
}

// FileChangeSummary is one file's net change in a turn: first before to last after.
type FileChangeSummary struct {
	TurnID    int64    `json:"turn_id"`
	Folder    string   `json:"folder"`
	Path      string   `json:"path"`
	Kind      string   `json:"kind"`
	Added     *int     `json:"added"`
	Removed   *int     `json:"removed"`
	CreatedAt string   `json:"created_at"`
	Note      string   `json:"note"`
	Source    string   `json:"source"`
	ChangeIDs []int64  `json:"change_ids"`
	AgentIDs  []string `json:"agent_ids"`
}

// TurnChanges is everything one turn changed.
type TurnChanges struct {
	TurnID  int64               `json:"turn_id"`
	Files   []FileChangeSummary `json:"files"`
	Added   int                 `json:"added"`
	Removed int                 `json:"removed"`
}

// Detail is one change with its content.
type Detail struct {
	FileChange
	Before        *string `json:"before"`
	After         *string `json:"after"`
	DiffAvailable bool    `json:"diff_available"`
}

// Summarize groups changes (oldest first) into turns, newest turn first. A
// file created and deleted again, or changed back to what it was, is left out.
// Counts of a file changed more than once come from first before to last
// after when both are still stored, else they are summed (null if any is).
func Summarize(ctx context.Context, db *projectstore.DB, list []projectstore.Change) ([]TurnChanges, error) {
	type key struct {
		turn         int64
		folder, path string
	}
	groups := map[key][]projectstore.Change{}
	var order []key
	for _, c := range list {
		k := key{c.TurnID, c.Folder, c.Path}
		if _, ok := groups[k]; !ok {
			order = append(order, k)
		}
		groups[k] = append(groups[k], c)
	}
	byTurn := map[int64]*TurnChanges{}
	var turns []int64
	for _, k := range order {
		s, keep, err := summarizeFile(ctx, db, groups[k])
		if err != nil {
			return nil, err
		}
		if !keep {
			continue
		}
		tc := byTurn[k.turn]
		if tc == nil {
			tc = &TurnChanges{TurnID: k.turn, Files: []FileChangeSummary{}}
			byTurn[k.turn] = tc
			turns = append(turns, k.turn)
		}
		tc.Files = append(tc.Files, s)
		if s.Added != nil {
			tc.Added += *s.Added
		}
		if s.Removed != nil {
			tc.Removed += *s.Removed
		}
	}
	slices.Sort(turns)
	slices.Reverse(turns)
	out := make([]TurnChanges, 0, len(turns))
	for _, t := range turns {
		out = append(out, *byTurn[t])
	}
	return out, nil
}

func summarizeFile(ctx context.Context, db *projectstore.DB, cs []projectstore.Change) (FileChangeSummary, bool, error) {
	first, last := cs[0], cs[len(cs)-1]
	s := FileChangeSummary{
		TurnID: first.TurnID, Folder: first.Folder, Path: first.Path, CreatedAt: last.CreatedAt,
		Source: last.Source, Added: last.Added, Removed: last.Removed, Note: last.Note,
	}
	agents := map[string]bool{}
	for _, c := range cs {
		s.ChangeIDs = append(s.ChangeIDs, c.ID)
		if !agents[c.AgentID] {
			agents[c.AgentID] = true
			s.AgentIDs = append(s.AgentIDs, c.AgentID)
		}
	}
	created, deleted := first.Kind == projectstore.ChangeCreated, last.Kind == projectstore.ChangeDeleted
	switch {
	case created && deleted:
		return s, false, nil
	case created:
		s.Kind = projectstore.ChangeCreated
	case deleted:
		s.Kind = projectstore.ChangeDeleted
	default:
		s.Kind = projectstore.ChangeModified
		if first.BeforeHash != nil && last.AfterHash != nil && *first.BeforeHash == *last.AfterHash {
			return s, false, nil
		}
	}
	if len(cs) == 1 {
		return s, true, nil
	}
	s.Added, s.Removed, s.Note = nil, nil, ""
	before, okB, err := side(ctx, db, first.BeforeHash, !created)
	if err != nil {
		return s, false, err
	}
	after, okA, err := side(ctx, db, last.AfterHash, !deleted)
	if err != nil {
		return s, false, err
	}
	if okB && okA {
		a, r := diff.Count(before, after)
		s.Added, s.Removed = &a, &r
		return s, true, nil
	}
	s.Note = firstNonEmpty(first.Note, last.Note, projectstore.NoteNoPreimage)
	return s, true, nil
}

// side loads a side's content; a side that does not exist is "" and available.
func side(ctx context.Context, db *projectstore.DB, hash *string, needed bool) (string, bool, error) {
	if !needed {
		return "", true, nil
	}
	if hash == nil {
		return "", false, nil
	}
	content, ok, err := db.Blob(ctx, *hash)
	return content, ok, err
}

func firstNonEmpty(v ...string) string {
	for _, s := range v {
		if s != "" {
			return s
		}
	}
	return ""
}

// DetailOf loads a change's content.
func DetailOf(ctx context.Context, db *projectstore.DB, c projectstore.Change) (Detail, error) {
	d := Detail{FileChange: ToFileChange(c)}
	before, okB, err := side(ctx, db, c.BeforeHash, c.Kind != projectstore.ChangeCreated)
	if err != nil {
		return d, err
	}
	after, okA, err := side(ctx, db, c.AfterHash, c.Kind != projectstore.ChangeDeleted)
	if err != nil {
		return d, err
	}
	d.DiffAvailable = okB && okA
	if c.Kind != projectstore.ChangeCreated && okB {
		d.Before = &before
	}
	if c.Kind != projectstore.ChangeDeleted && okA {
		d.After = &after
	}
	if !d.DiffAvailable && d.Note == "" {
		d.Note = projectstore.NotePruned
	}
	return d, nil
}
