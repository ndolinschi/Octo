package orchestrator

import (
	"fmt"
	"strings"

	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

func (rt *runtime) systemPrompt(a projectstore.Agent) string {
	if a.ParentID == nil {
		return rt.orchestratorPrompt()
	}
	return rt.subAgentPrompt(a)
}

func (rt *runtime) brief() string {
	var b strings.Builder
	fmt.Fprintf(&b, "Project: %s\n", rt.info.Name)
	if rt.info.Description != "" {
		fmt.Fprintf(&b, "Description: %s\n", rt.info.Description)
	}
	if rt.info.Instructions != "" {
		fmt.Fprintf(&b, "\nCustom instructions from the user:\n%s\n", rt.info.Instructions)
	}
	if len(rt.folders) == 0 {
		b.WriteString("\nFolders: none attached; no file or shell tools are available.\n")
		return b.String()
	}
	b.WriteString("\nFolders (label: absolute path):\n")
	for _, f := range rt.folders {
		fmt.Fprintf(&b, "- %s: %s\n", f.Label, f.Path)
	}
	if len(rt.folders) > 1 {
		b.WriteString("File and shell tools take an optional `folder` label; it defaults to the first folder.\n")
	}
	return b.String()
}

func (rt *runtime) orchestratorPrompt() string {
	static, notes := rt.orchestratorPromptParts()
	return static + notes
}

// orchestratorPromptParts is the orchestrator's system prompt split into the
// part that never changes between turns and the project notes block after it.
func (rt *runtime) orchestratorPromptParts() (static, notes string) {
	var b strings.Builder
	b.WriteString("You are the orchestrator of a software project. You are the single long-lived agent the user talks to: " +
		"every message in this conversation is the same user speaking about the same project.\n\n")
	b.WriteString(rt.brief())
	b.WriteString(`
How you work:
- Keep your own context small. Beyond a quick orientation with list_dir/read_file, do not explore, implement or verify yourself; delegate with spawn_agent.
- A sub-agent sees none of this conversation. Each task brief must be self-contained: the goal, relevant folders and paths, constraints, and the exact report format you expect (for example "reply with findings as bullets, file paths, and open questions, under 200 words").
- Choose the tier by difficulty: fast for lookups and simple edits, balanced for normal engineering, deep for hard design or debugging.
- Run independent sub-tasks in parallel by issuing several spawn_agent calls in one message. Sequence dependent ones.
- A sub-agent's final report is all you see of its work. Check it for gaps and delegate follow-ups when needed.
- Record durable intent, decisions and facts with save_note (upserts by title); delete stale notes with delete_note. Keep notes short.
- Answer the user concisely in markdown from the sub-agent reports: what was found or changed, and what remains.
`)
	b.WriteString(rt.acpPrompt())
	// Notes change whenever save_note runs, so they come last: everything above
	// stays byte-identical and the prompt-cache prefix (tools + static system)
	// survives a note change.
	static = b.String()
	return static, notesBlock(rt.notes)
}

// notesBlock renders the project notes section of the orchestrator prompt.
func notesBlock(notes []projectstore.Note) string {
	var b strings.Builder
	b.WriteString("\nProject notes (durable memory, re-read every turn):\n")
	if len(notes) == 0 {
		b.WriteString("(none yet)\n")
	}
	for _, n := range notes {
		fmt.Fprintf(&b, "### %s\n%s\n", n.Title, n.Content)
	}
	return b.String()
}

func (rt *runtime) subAgentPrompt(a projectstore.Agent) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Role: %s\n", a.Role)
	b.WriteString("You are a sub-agent working for a parent agent on the project below. Your task is the first user message.\n\n")
	b.WriteString(rt.brief())
	b.WriteString("\nYour final message is the only thing your parent sees. Make it a complete, compact report: " +
		"findings, relevant file paths, what you changed, and open questions. Do not ask for clarification; state your assumptions.\n")
	if a.Depth < rt.info.MaxDepth {
		b.WriteString("You may delegate self-contained sub-tasks with spawn_agent (parallel when issued in one message), " +
			"but prefer doing small work yourself.\n")
	}
	return b.String()
}
