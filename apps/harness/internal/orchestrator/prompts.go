package orchestrator

import (
	"fmt"
	"strings"

	"github.com/ndolinschi/Octo/apps/harness/internal/notemd"
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
	if !rt.isACPOrchestrator() {
		b.WriteString(rt.instructionSection(projectstore.Agent{}))
		b.WriteString(rt.planSection())
		b.WriteString(rt.modeSection())
	}
	b.WriteString(`
How you work:
- Keep your own context small. Beyond a quick orientation with list_dir/read_file, do not explore, implement or verify yourself; delegate with spawn_agent.
- A sub-agent sees none of this conversation. Each task brief must be self-contained: the goal, relevant folders and paths, constraints, and the exact report format you expect (for example "reply with findings as bullets, file paths, and open questions, under 200 words").
- ` + rt.tierGuidance() + `
- Run independent sub-tasks in parallel by issuing several spawn_agent calls in one message. Sequence dependent ones.
- A sub-agent's final report is all you see of its work. Check it for gaps and delegate follow-ups when needed.
- Notes are your durable memory, shown to you as an index of descriptions: open a note with read_note only when its description is relevant, and use search_notes before saying you do not know. Record durable intent, decisions and facts with write_note (a one-line description you write, then the body in Markdown); delete stale notes with delete_note. Keep notes short.
- Answer the user concisely in markdown from the sub-agent reports: what was found or changed, and what remains.
` + memoryGuidance)
	b.WriteString(rt.acpPrompt())
	// Notes change whenever write_note runs, so they come last: everything above
	// stays byte-identical and the prompt-cache prefix (tools + static system)
	// survives a note change.
	static = b.String()
	return static, notesBlock(rt.notes)
}

// notesBlock renders the project notes section of the orchestrator prompt: the
// pinned notes whole (rules that always apply), then an index of every note
// (id, title, description, tags) within a budget of notemd.IndexBudget tokens.
// Bodies are never in the prompt; read_note opens one, search_notes finds the
// ones that did not fit.
func notesBlock(notes []projectstore.Note) string {
	var b strings.Builder
	b.WriteString(notesHeader)
	if len(notes) == 0 {
		b.WriteString("(none yet) Record durable facts, decisions and intent with write_note.\n")
		return b.String()
	}
	var pinned []projectstore.Note
	for _, n := range notes {
		if n.Pinned {
			pinned = append(pinned, n)
		}
	}
	if len(pinned) > 0 {
		b.WriteString("Pinned notes (rules that always apply):\n")
		for _, n := range pinned {
			fmt.Fprintf(&b, "### %s\n%s\n", n.Title, strings.TrimRight(n.Content, "\n"))
		}
	}
	lines, _ := notemd.BuildIndex(noteEntries(notes), notemd.IndexBudget, projectstore.EstimateTokens)
	fmt.Fprintf(&b, "Index of %d notes (id · title — description [tags]); open one with read_note when its description is relevant, find others with search_notes:\n", len(notes))
	for _, l := range lines {
		b.WriteString(l + "\n")
	}
	return b.String()
}

// notesHeader opens the notes block, with or without notes, so everything before it stays byte-identical.
const notesHeader = "\nProject notes (durable memory; you see descriptions, not bodies):\n"

func (rt *runtime) subAgentPrompt(a projectstore.Agent) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Role: %s\n", a.Role)
	b.WriteString("You are a sub-agent working for a parent agent on the project below. Your task is the first user message.\n\n")
	b.WriteString(rt.brief())
	b.WriteString(rt.instructionSection(a))
	b.WriteString("\nYour final message is the only thing your parent sees. Make it a complete, compact report: " +
		"findings, relevant file paths, what you changed, and open questions. Do not ask for clarification; state your assumptions. " +
		"If you could not do the task, start the report with \"Could not do it:\" and say why.\n")
	b.WriteString("\nWhen you learn something that will matter in later sessions (a constraint, a decision, where something lives, what failed and why), keep it with remember; never what the instruction files already say.\n")
	if a.Depth < rt.info.MaxDepth {
		b.WriteString("You may delegate self-contained sub-tasks with spawn_agent (parallel when issued in one message), " +
			"but prefer doing small work yourself.\n")
	}
	return b.String()
}
