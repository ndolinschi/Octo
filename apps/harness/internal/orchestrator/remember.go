package orchestrator

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"

	"github.com/ndolinschi/Octo/apps/harness/internal/approval"
	"github.com/ndolinschi/Octo/apps/harness/internal/memory"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
	"github.com/ndolinschi/Octo/apps/harness/internal/tools"
)

// ToolRemember keeps one item as a dated fact in the project's memory.
const ToolRemember = "remember"

// MaxRemembersPerTurn is how many items the agents of one turn may remember together.
const MaxRemembersPerTurn = 3

const rememberSchema = `{"type":"object","properties":{"text":{"type":"string","description":"One standalone statement (no \"it\" or \"this\")."},` +
	`"kind":{"type":"string","enum":["fact","decision","preference","todo"]},` +
	`"about":{"type":"string","description":"The subject, so a later item about the same thing replaces this one."}},"required":["text","kind"]}`

// rememberGuidance is the paragraph of the briefings that says when to use the tool.
const rememberGuidance = "- remember(text, kind, about?) keeps one short standalone item (a fact, decision, preference or todo) for every later session. " +
	"Use it after finishing a task, or when you learn something that will matter later: a constraint, a decision, where something lives, " +
	"what failed and why. Never for what the instruction files already say. At most three per turn.\n"

// rememberDef is the remember tool of one agent. It checks the project's auto_memory setting and feature flag.
func (rt *runtime) rememberDef(a projectstore.Agent) tools.Def {
	return tools.Def{Name: ToolRemember, InputSchema: json.RawMessage(rememberSchema),
		Description: "Keep one short standalone item (fact, decision, preference or todo) in the project's memory with today's date, for every later session. " +
			"Use after finishing a task or on learning something that will matter later; not for what the instruction files say. At most three per turn.",
		Handle: func(ctx context.Context, raw json.RawMessage) (string, bool, error) {
			var in struct{ Text, Kind, About string }
			if err := json.Unmarshal(raw, &in); err != nil {
				return "invalid input: " + err.Error(), true, nil
			}
			text := strings.TrimSpace(in.Text)
			if text == "" {
				return "text is required", true, nil
			}
			if !slices.Contains(memory.RememberKinds, in.Kind) {
				return fmt.Sprintf("kind must be one of %s", strings.Join(memory.RememberKinds, ", ")), true, nil
			}
			about := strings.TrimSpace(in.About)
			if ok, reason := rt.approveMemory(ctx, a.ID, agentLabel(a), "Enable auto memory?", approval.Detail{
				MemoryCommand: "remember",
				MemoryKind:    in.Kind,
				MemoryText:    rt.redact(text),
				MemoryAbout:   rt.redact(about),
			}); !ok {
				return reason, true, nil
			}
			if rt.remembered.Add(1) > MaxRemembersPerTurn {
				rt.remembered.Add(-1)
				return fmt.Sprintf("at most %d items can be remembered in one turn; keep the rest in your answer or a memory file", MaxRemembersPerTurn), true, nil
			}
			f, taskID, err := rt.memory().Remember(ctx, memory.RememberInput{
				Text: text, Kind: in.Kind, About: about, By: a.ID, TaskID: rt.currentTask(), MessageID: rt.turnID,
			})
			if err != nil {
				rt.remembered.Add(-1)
				if errors.Is(err, memory.ErrInvalid) {
					return err.Error(), true, nil
				}
				return "", false, err
			}
			b, _ := json.Marshal(map[string]any{"remembered": true, "id": taskID + "/" + f.ID})
			return string(b), false, nil
		}}
}
