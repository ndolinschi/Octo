package orchestrator

import (
	"strings"

	"github.com/ndolinschi/Octo/apps/harness/internal/instructions"
	"github.com/ndolinschi/Octo/apps/harness/internal/memory"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

// BlockInstructions is the receipt block of the project's instruction files.
const BlockInstructions = "instructions"

// ACPInstructionsNote is what a receipt of an ACP-run turn says about
// instruction files: the harness adds none, the agent reads its own.
const ACPInstructionsNote = "the agent reads its own instruction files"

// instrEntry is the instruction files of one agent for the turn, read once.
type instrEntry struct {
	set  instructions.Set
	text string
}

// orchInstrKey is the cache key of the orchestrator's (agent ids are never this).
const orchInstrKey = "\x00orchestrator"

func (rt *runtime) instructionFolders() []instructions.Folder {
	out := make([]instructions.Folder, len(rt.folders))
	for i, f := range rt.folders {
		out[i] = instructions.Folder{Label: f.Label, Path: f.Path}
	}
	return out
}

// instructionsOf reads the project's instruction files for a built-in agent,
// once per turn and agent (a change on disk is picked up by the next request):
// the folder roots always, and the directories down to the files its task names
// (the sub-agent's task, or the user's request for the orchestrator). Nothing
// for an ACP agent, which reads its own.
func (rt *runtime) instructionsOf(a projectstore.Agent) instrEntry {
	key, named := a.ID, a.Task
	if a.ParentID == nil {
		key, named = orchInstrKey, rt.request
		if rt.isACPOrchestrator() {
			return instrEntry{}
		}
	}
	rt.instrMu.Lock()
	defer rt.instrMu.Unlock()
	if e, ok := rt.instr[key]; ok {
		return e
	}
	folders := rt.instructionFolders()
	set := instructions.Collect(folders, instructions.PathsIn(folders, named))
	e := instrEntry{set: set, text: set.Render(rt.redact)}
	if rt.instr == nil {
		rt.instr = map[string]instrEntry{}
	}
	rt.instr[key] = e
	return e
}

// instructionsBlock is the receipt block of the orchestrator's instruction
// files; ok is false when there are none (or the orchestrator is an ACP agent).
func (rt *runtime) instructionsBlock() (ReceiptBlock, bool) {
	if rt.isACPOrchestrator() {
		return ReceiptBlock{}, false
	}
	e := rt.instructionsOf(projectstore.Agent{})
	if e.set.Empty() {
		return ReceiptBlock{}, false
	}
	b := ReceiptBlock{Name: BlockInstructions, Tokens: tokensOf(e.text), Count: len(e.set.Files), IDs: []string{}}
	for _, f := range e.set.Files {
		b.IDs = append(b.IDs, f.Path)
		b.Files = append(b.Files, f)
	}
	return b, true
}

// instructionSection is the system-prompt text for an agent ("" when it has
// none): placed right after the project briefing, so the part of the prompt
// before it, and everything after it, stay byte-identical while the files do.
func (rt *runtime) instructionSection(a projectstore.Agent) string {
	t := rt.instructionsOf(a).text
	if t == "" {
		return ""
	}
	return "\n" + strings.TrimLeft(t, "\n")
}

// ensureACPReceipt gives an ACP-run turn a receipt when its prompt built none,
// so GET /turns/{id}/context can say that the agent reads its own instruction files.
func (rt *runtime) ensureACPReceipt() {
	rt.rcptMu.Lock()
	have := rt.rcpt != nil
	rt.rcptMu.Unlock()
	if have {
		return
	}
	st := memory.ParseSettings(rt.info.MemoryJSON)
	rt.setReceipt(Receipt{TurnID: rt.turnID, Mode: st.Context, RecentExchanges: st.RecentExchanges, CreatedAt: projectstore.Now(), Blocks: []ReceiptBlock{}})
}
