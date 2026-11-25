package orchestrator_test

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/changes"
	"github.com/ndolinschi/Octo/apps/harness/internal/fakeacp"
	"github.com/ndolinschi/Octo/apps/harness/internal/mockllm"
)

func fileOf(turns []changes.TurnChanges, path string) (changes.FileChangeSummary, bool) {
	for _, tc := range turns {
		for _, f := range tc.Files {
			if f.Path == path {
				return f, true
			}
		}
	}
	return changes.FileChangeSummary{}, false
}

func TestACPFSWriteIsRecorded(t *testing.T) {
	r := newACPRig(t, mockllm.New(0), fakeAgent("fake", true))
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("# Octo demo\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	pid := r.projectAt(t, dir)
	r.runCollect(t, pid, "[acp] summarize", nil)
	turns, err := r.svc.Changes(context.Background(), pid, 0)
	if err != nil {
		t.Fatal(err)
	}
	f, ok := fileOf(turns, fakeacp.NoteFile)
	if !ok || f.Kind != "created" || f.Source != "acp_fs" || *f.Added != 3 {
		t.Fatalf("turns = %+v", turns)
	}
	if len(turns[0].Files) != 1 {
		t.Fatalf("the snapshot at the end of the agent's run counted the fs write again: %+v", turns[0].Files)
	}
	child := r.acpChild(t, pid)
	if len(f.AgentIDs) != 1 || f.AgentIDs[0] != child.ID {
		t.Fatalf("agent ids = %v, want the sub-agent %s", f.AgentIDs, child.ID)
	}
}

func TestACPOwnToolEditsAreRecordedFromTheTurnSnapshot(t *testing.T) {
	r := newACPRig(t, mockllm.New(0), fakeAgent("fake", true))
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("# before\nkept\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	pid := r.projectAt(t, dir)
	r.runCollect(t, pid, "[acp] [own-edit] do it", nil)
	turns, err := r.svc.Changes(context.Background(), pid, 0)
	if err != nil {
		t.Fatal(err)
	}
	own, ok := fileOf(turns, fakeacp.OwnEditFile)
	if !ok || own.Kind != "created" || own.Source != "acp_turn" || *own.Added != 2 {
		t.Fatalf("own-edit.txt: %+v (%+v)", own, turns)
	}
	readme, ok := fileOf(turns, "README.md")
	if !ok || readme.Kind != "modified" || *readme.Added != 1 || *readme.Removed != 2 {
		t.Fatalf("README.md: %+v", readme)
	}
}
