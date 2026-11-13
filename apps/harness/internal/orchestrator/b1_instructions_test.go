package orchestrator_test

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/orchestrator"
)

// systemsSeen records the system prompt of every request, by kind.
type systemsSeen struct {
	mu    sync.Mutex
	orch  []string
	other []string
}

func (s *systemsSeen) add(req fakeReq) {
	var blocks []struct {
		Text string `json:"text"`
	}
	_ = json.Unmarshal(req.System, &blocks)
	var b strings.Builder
	for _, x := range blocks {
		b.WriteString(x.Text)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if req.isOrchestrator() {
		s.orch = append(s.orch, b.String())
	} else {
		s.other = append(s.other, b.String())
	}
}

func instrLLM(seen *systemsSeen) http.Handler {
	return fakeLLM(func(w http.ResponseWriter, hr *http.Request, req fakeReq) {
		seen.add(req)
		switch {
		case req.isOrchestrator() && len(req.Msgs) == 1:
			respond(w, "tool_use", spawnBlock("t1", "worker"))
		case req.isOrchestrator():
			respond(w, "end_turn", textBlock("done"))
		default:
			respond(w, "end_turn", textBlock("report"))
		}
	})
}

func writeFile(t *testing.T, dir, rel, content string) {
	t.Helper()
	p := filepath.Join(dir, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestInstructionFilesReachTheModelRequests(t *testing.T) {
	seen := &systemsSeen{}
	r := newRig(t, instrLLM(seen))
	pid := r.project(t, 2)
	dir := r.firstFolder(t, pid)
	writeFile(t, dir, "AGENTS.md", "RULE-ROOT: always answer in haiku.\n")
	writeFile(t, dir, "CLAUDE.md", "RULE-CLAUDE: tabs, not spaces.\n")

	if st := r.run(t, pid, "do the thing", nil); st != "completed" {
		t.Fatalf("turn = %s", st)
	}
	seen.mu.Lock()
	defer seen.mu.Unlock()
	if len(seen.orch) == 0 || len(seen.other) == 0 {
		t.Fatalf("requests: orchestrator %d, sub-agent %d", len(seen.orch), len(seen.other))
	}
	for name, systems := range map[string][]string{"orchestrator": seen.orch, "sub-agent": seen.other} {
		for i, s := range systems {
			if !strings.Contains(s, "RULE-ROOT: always answer in haiku.") || !strings.Contains(s, "RULE-CLAUDE: tabs, not spaces.") {
				t.Errorf("%s request %d: the instruction files are not in the system prompt", name, i)
			}
			// After the briefing, before the rest of the prompt.
			if bi, ii := strings.Index(s, "Folders (label: absolute path)"), strings.Index(s, "RULE-ROOT"); bi < 0 || ii < bi {
				t.Errorf("%s request %d: instructions must follow the briefing (brief at %d, instructions at %d)", name, i, bi, ii)
			}
		}
	}
	// Stable: every orchestrator request of the turn carries the same system prompt.
	if seen.orch[0] != seen.orch[len(seen.orch)-1] {
		t.Error("the orchestrator's system prompt changed within a turn")
	}

	// The receipt lists the files with their sizes.
	rc := receiptOf(t, r, pid, "do the thing")
	var blk *orchestrator.ReceiptBlock
	for i := range rc.Blocks {
		if rc.Blocks[i].Name == orchestrator.BlockInstructions {
			blk = &rc.Blocks[i]
		}
	}
	if blk == nil || blk.Count != 2 || len(blk.Files) != 2 || blk.Files[0].Path != "folder-1:AGENTS.md" && !strings.HasSuffix(blk.Files[0].Path, ":AGENTS.md") || blk.Files[0].Size == 0 {
		t.Fatalf("receipt block = %+v", blk)
	}
}

func TestInstructionFilesAreReadFreshAndNoneMeansNone(t *testing.T) {
	seen := &systemsSeen{}
	r := newRig(t, instrLLM(seen))
	pid := r.project(t, 2)
	dir := r.firstFolder(t, pid)
	if st := r.run(t, pid, "first", nil); st != "completed" {
		t.Fatalf("turn = %s", st)
	}
	seen.mu.Lock()
	if strings.Contains(seen.orch[0], "Project instruction files") {
		t.Error("a project without instruction files must not get the section")
	}
	seen.mu.Unlock()
	waitTurn(t, r, pid)
	writeFile(t, dir, "AGENTS.md", "RULE-LATE: added between requests\n")
	if st := r.run(t, pid, "second", nil); st != "completed" {
		t.Fatalf("turn = %s", st)
	}
	seen.mu.Lock()
	defer seen.mu.Unlock()
	if !strings.Contains(seen.orch[len(seen.orch)-1], "RULE-LATE") {
		t.Error("a file added between requests must be picked up")
	}
}

func TestBigInstructionFileIsTruncatedWithMarker(t *testing.T) {
	seen := &systemsSeen{}
	r := newRig(t, instrLLM(seen))
	pid := r.project(t, 1)
	dir := r.firstFolder(t, pid)
	writeFile(t, dir, "AGENTS.md", "RULE-HEAD kept\n"+strings.Repeat("filler line of text\n", 10_000)) // ~200 kB
	if st := r.run(t, pid, "go", nil); st != "completed" {
		t.Fatalf("turn = %s", st)
	}
	seen.mu.Lock()
	defer seen.mu.Unlock()
	s := seen.orch[0]
	if !strings.Contains(s, "RULE-HEAD kept") || !strings.Contains(s, "truncated by the harness") {
		t.Fatalf("head kept: %v, marker: %v", strings.Contains(s, "RULE-HEAD kept"), strings.Contains(s, "truncated by the harness"))
	}
	if len(s) > 40_000 {
		t.Errorf("system prompt is %d bytes: the 200 kB file was not cut to its 32 kB cap", len(s))
	}
}

func TestSubAgentGetsTheDirectoriesOfItsFiles(t *testing.T) {
	seen := &systemsSeen{}
	r := newRig(t, fakeLLM(func(w http.ResponseWriter, hr *http.Request, req fakeReq) {
		seen.add(req)
		switch {
		case req.isOrchestrator() && len(req.Msgs) == 1:
			respond(w, "tool_use", `{"type":"tool_use","id":"t1","name":"spawn_agent","input":{"role":"Worker","title":"w","task":"fix pkg/deep/x.go please","tier":"fast"}}`)
		case req.isOrchestrator():
			respond(w, "end_turn", textBlock("done"))
		default:
			respond(w, "end_turn", textBlock("report"))
		}
	}))
	pid := r.project(t, 2)
	dir := r.firstFolder(t, pid)
	writeFile(t, dir, "AGENTS.md", "RULE-ROOT\n")
	writeFile(t, dir, "pkg/AGENTS.md", "RULE-PKG\n")
	writeFile(t, dir, "pkg/deep/AGENTS.md", "RULE-DEEP\n")
	writeFile(t, dir, "pkg/deep/x.go", "package deep\n")
	writeFile(t, dir, "elsewhere/AGENTS.md", "RULE-ELSEWHERE\n")
	if st := r.run(t, pid, "work on the repo", nil); st != "completed" {
		t.Fatalf("turn = %s", st)
	}
	seen.mu.Lock()
	defer seen.mu.Unlock()
	sub := seen.other[0]
	i1, i2, i3 := strings.Index(sub, "RULE-ROOT"), strings.Index(sub, "RULE-PKG"), strings.Index(sub, "RULE-DEEP")
	if i1 < 0 || i2 < i1 || i3 < i2 || strings.Contains(sub, "RULE-ELSEWHERE") {
		t.Fatalf("sub-agent prompt order root/pkg/deep = %d/%d/%d, elsewhere present: %v", i1, i2, i3, strings.Contains(sub, "RULE-ELSEWHERE"))
	}
	// The orchestrator's request names no path: only the root.
	if strings.Contains(seen.orch[0], "RULE-PKG") {
		t.Error("the orchestrator got a directory its request does not name")
	}
}

func TestACPOrchestratorGetsNoInstructionFilesAndItsReceiptSaysSo(t *testing.T) {
	r := newACPRig(t, instrLLM(&systemsSeen{}), fakeAgent("fake", true))
	pid := r.acpWindowProject(t)
	writeFile(t, r.firstFolder(t, pid), "AGENTS.md", "RULE-ACP-MUST-NOT-APPEAR\n")
	got := r.runCollect(t, pid, "[echo] hello", nil)
	if echo := r.echoOf(t, pid, got); strings.Contains(echo, "RULE-ACP-MUST-NOT-APPEAR") {
		t.Fatalf("an ACP agent reads its own instruction files; the harness sent them: %q", echo)
	}
	rc := receiptOf(t, r, pid, "[echo] hello")
	if rc.InstructionsNote != "the agent reads its own instruction files" {
		t.Fatalf("receipt note = %q", rc.InstructionsNote)
	}
	for _, b := range rc.Blocks {
		if b.Name == orchestrator.BlockInstructions {
			t.Fatalf("an ACP turn must not list instruction files: %+v", b)
		}
	}
	_ = context.Background()
	_ = json.Marshal
}
