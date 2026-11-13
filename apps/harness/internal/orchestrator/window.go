package orchestrator

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/anthropics/anthropic-sdk-go/v2"

	"github.com/ndolinschi/Octo/apps/harness/internal/agent"
	"github.com/ndolinschi/Octo/apps/harness/internal/instructions"
	"github.com/ndolinschi/Octo/apps/harness/internal/memory"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

// Caps, in tokens (four characters each), of the blocks of the window mode's
// context (design: M2). The current turn has no cap.
const (
	CapIndex  = 1500
	CapTasks  = 3000
	CapWindow = 12000
	CapFacts  = 1500
)

// CapsTotal is the sum of the capped blocks.
const CapsTotal = CapIndex + CapTasks + CapWindow + CapFacts

// Block names of a receipt.
const (
	BlockIndex   = "memory_index"
	BlockTasks   = "open_tasks"
	BlockWindow  = "recent_window"
	BlockFacts   = "facts"
	BlockCurrent = "current_turn"
	BlockHistory = "history" // full mode: the whole transcript
	BlockChanged = "changed_tasks"
)

// doneRecently is how long a finished task is still listed (one line).
const doneRecently = 7 * 24 * time.Hour

// ReceiptBlock is one block of what a request carried.
type ReceiptBlock struct {
	Name   string `json:"name"`
	Tokens int64  `json:"tokens"`
	// Cap is the block's cap in tokens (0: none).
	Cap   int64    `json:"cap"`
	Count int      `json:"count"`
	IDs   []string `json:"ids"`
	// Files is set on the instructions block: each file with its size and whether it was cut.
	Files []instructions.File `json:"files,omitempty"`
}

// Receipt records what the orchestrator had in front of it in a turn: the
// blocks of its first request (names, token estimates, the ids included).
type Receipt struct {
	TurnID          int64          `json:"turn_id"`
	Mode            string         `json:"mode"`
	RecentExchanges int            `json:"recent_exchanges"`
	Blocks          []ReceiptBlock `json:"blocks"`
	TotalTokens     int64          `json:"total_tokens"`
	// CapsTotal is the sum of the caps of the capped blocks present.
	CapsTotal    int64  `json:"caps_total"`
	MessageCount int    `json:"message_count"`
	ClearedCalls int    `json:"cleared_calls"`
	CreatedAt    string `json:"created_at"`
	// InstructionsNote is set on the receipt of an ACP-run turn: the harness
	// adds no instruction files for such an agent.
	InstructionsNote string `json:"instructions_note,omitempty"`
}

func (r *Receipt) add(b ReceiptBlock) {
	r.Blocks = append(r.Blocks, b)
	r.TotalTokens += b.Tokens
	r.CapsTotal += b.Cap
}

func tokensOf(s string) int64 { return projectstore.EstimateTokens(len(s)) }

func clipChars(s string, n int) string {
	if r := []rune(s); len(r) > n {
		return string(r[:n]) + " …[cut]"
	}
	return s
}

func oneLineOf(s string, n int) string { return clip(strings.Join(strings.Fields(s), " "), n) }

// textBlock is a capped text block with its receipt entry.
type textBlock struct {
	ReceiptBlock
	Text string
}

// capLines joins header and lines, stopping before the cap.
func capLines(header string, lines []string, capTokens int64) (string, int) {
	var b strings.Builder
	b.WriteString(header)
	n := 0
	for _, l := range lines {
		if tokensOf(b.String())+tokensOf(l)+1 > capTokens {
			break
		}
		b.WriteString(l + "\n")
		n++
	}
	return b.String(), n
}

// exchange is a user request and everything until the next one.
type exchange struct{ msgs []projectstore.Message }

// splitExchanges groups messages: a user message with text starts a new one.
func splitExchanges(msgs []projectstore.Message) []exchange {
	var out []exchange
	for _, m := range msgs {
		if m.Role == "user" && messageText(m) != "" {
			out = append(out, exchange{})
		}
		if len(out) == 0 {
			continue
		}
		out[len(out)-1].msgs = append(out[len(out)-1].msgs, m)
	}
	return out
}

// reduced renders an exchange as a user message and one assistant message in
// which every tool call is a single line.
func (e exchange) reduced(perMessage int) (user, assistant string) {
	results := map[string]string{}
	for _, m := range e.msgs {
		for _, b := range m.Content {
			if b.Type == "tool_result" && b.ToolUseID != nil && b.Content != nil {
				results[*b.ToolUseID] = *b.Content
			}
		}
	}
	var a strings.Builder
	for i, m := range e.msgs {
		if i == 0 {
			user = clipChars(messageText(m), perMessage)
			continue
		}
		if m.Role != "assistant" {
			continue
		}
		for _, b := range m.Content {
			switch b.Type {
			case "text":
				if b.Text != nil {
					a.WriteString(*b.Text + "\n")
				}
			case "tool_use":
				name, key := "tool", ""
				if b.Name != nil {
					name = *b.Name
				}
				var in map[string]any
				_ = json.Unmarshal(b.Input, &in)
				for _, k := range []string{"title", "path", "command", "query", "task"} {
					if v, ok := in[k].(string); ok && v != "" {
						key = " " + oneLineOf(v, 60)
						break
					}
				}
				res := ""
				if b.ID != nil {
					res = oneLineOf(results[*b.ID], 120)
				}
				fmt.Fprintf(&a, "[called %s%s: %s]\n", name, key, res)
			}
		}
	}
	return user, clipChars(strings.TrimSpace(a.String()), perMessage)
}

// assembly is the result of building the window-mode context.
type assembly struct {
	// lead precedes the window (the memory index: it changes only when a memory
	// file does); tasks and facts follow it, in front of the current turn, because
	// they change every turn and must not break the stable prefix before them.
	lead    []textBlock
	window  []exchangeText
	tasks   *textBlock
	facts   *textBlock
	receipt Receipt
	// currentFrom is the index in the stored messages where the current turn starts.
	currentFrom int
	stored      []projectstore.Message
	// load fetches the images of the current turn.
	load imageLoader
}

type exchangeText struct {
	user, assistant string
	ids             []int64
}

// assembleWindow builds the blocks of the window mode for the orchestrator.
func (rt *runtime) assembleWindow(ctx context.Context, a projectstore.Agent, st memory.Settings) (*assembly, error) {
	stored, err := rt.db.LiveMessages(ctx, a.ID)
	if err != nil {
		return nil, err
	}
	from := len(stored) - 1
	for i := len(stored) - 1; i >= 0; i-- {
		if (rt.turnID != 0 && stored[i].ID == rt.turnID) || (rt.turnID == 0 && stored[i].Role == "user" && messageText(stored[i]) != "") {
			from = i
			break
		}
	}
	if from < 0 {
		from = 0
	}
	as := &assembly{currentFrom: from, stored: stored, load: rt.imageLoader(ctx),
		receipt: Receipt{TurnID: rt.turnID, Mode: memory.ContextWindow, RecentExchanges: st.RecentExchanges, CreatedAt: projectstore.Now()}}
	m := rt.memory()

	// 1. memory index (and the statement that older history is not shown).
	files, err := m.DB.Files(ctx)
	if err != nil {
		return nil, err
	}
	var fileLines []string
	var fileIDs []string
	for _, f := range files {
		fileLines = append(fileLines, fmt.Sprintf("- %s: %s", f.Path, f.Summary))
		fileIDs = append(fileIDs, f.Path)
	}
	head := "## Memory\nOnly the recent exchanges are shown below; earlier conversation is in memory: use memory_search to find a detail and recall_message for a message's exact words, memory with view /memories to read a file.\n" + m.PreviousSessionPointer(ctx) + "Memory files:\n"
	if len(fileLines) == 0 {
		fileLines = []string{"(none yet)"}
	}
	text, n := capLines(head, fileLines, CapIndex)
	if len(fileIDs) == 0 {
		n = 0 // the placeholder line is not a file
	}
	as.lead = append(as.lead, textBlock{ReceiptBlock{Name: BlockIndex, Tokens: tokensOf(text), Cap: CapIndex, Count: n, IDs: nonNil(fileIDs[:min(n, len(fileIDs))])}, text})

	// 2. open task records, newest first; done tasks of the last week as one line.
	tasks, err := m.Tasks(ctx)
	if err != nil {
		return nil, err
	}
	var taskLines, taskIDs []string
	for _, t := range tasks {
		if t.Status == projectstore.TaskOpen {
			taskLines = append(taskLines, taskLine(t))
			taskIDs = append(taskIDs, t.ID)
		}
	}
	cutoff := projectstore.Stamp(time.Now().Add(-doneRecently))
	for _, t := range tasks {
		if t.Status == projectstore.TaskDone && t.UpdatedAt >= cutoff {
			taskLines = append(taskLines, fmt.Sprintf("- [%s] (done) %s — %s", t.ID, oneLineOf(t.Title, 80), oneLineOf(t.Outcome, 120)))
			taskIDs = append(taskIDs, t.ID)
		}
	}
	text, n = capLines("## Tasks (open, and done within a week)\n", orNone(taskLines), CapTasks)
	if len(taskIDs) == 0 {
		n = 0
	}
	as.tasks = &textBlock{ReceiptBlock{Name: BlockTasks, Tokens: tokensOf(text), Cap: CapTasks, Count: n, IDs: nonNil(taskIDs[:min(n, len(taskIDs))])}, text}

	// 3. the recent window: the last N exchanges before the current turn, at
	// least, and it advances N exchanges at a time (so it holds between N and
	// 2N-1): the window's first exchange stays put for N turns in a row and
	// everything before the current turn stays byte for byte the same, which is
	// what a provider's prompt cache needs. Each message is cut to a fixed share
	// of the cap (sized for the longest window) so its text never changes either.
	ex := splitExchanges(stored[:from])
	n0 := st.RecentExchanges
	ex = ex[windowStart(len(ex), n0):]
	per := CapWindow * 4 / (2 * (2*n0 - 1)) // characters per message
	var winTokens int64
	var winIDs []string
	for _, e := range ex {
		u, asst := e.reduced(per)
		et := exchangeText{user: u, assistant: asst}
		for _, mm := range e.msgs {
			et.ids = append(et.ids, mm.ID)
		}
		winTokens += tokensOf(u) + tokensOf(asst)
		winIDs = append(winIDs, fmt.Sprint(e.msgs[0].ID))
		as.window = append(as.window, et)
	}

	// 4. current facts of open tasks, newest first, with their dates.
	var factLines, factIDs []string
	for _, t := range tasks {
		if t.Status != projectstore.TaskOpen {
			continue
		}
		for i := len(t.Facts) - 1; i >= 0; i-- {
			if f := t.Facts[i]; f.SupersededBy == "" {
				factLines = append(factLines, fmt.Sprintf("- (%s) %s", f.Date[:10], oneLineOf(f.Text, 300)))
				factIDs = append(factIDs, t.ID+"/"+f.ID)
			}
		}
	}
	if len(factLines) > 0 {
		text, n = capLines("## Current facts (newest first)\n", factLines, CapFacts)
		as.facts = &textBlock{ReceiptBlock{Name: BlockFacts, Tokens: tokensOf(text), Cap: CapFacts, Count: n, IDs: nonNil(factIDs[:min(n, len(factIDs))])}, text}
	}

	// receipt blocks, in context order.
	for _, b := range as.lead {
		as.receipt.add(b.ReceiptBlock)
	}
	as.receipt.add(ReceiptBlock{Name: BlockWindow, Tokens: winTokens, Cap: CapWindow, Count: len(ex), IDs: nonNil(winIDs)})
	as.receipt.add(as.tasks.ReceiptBlock)
	if as.facts != nil {
		as.receipt.add(as.facts.ReceiptBlock)
	}
	return as, nil
}

// windowStart is the index of the first exchange the window shows when k
// exchanges precede the current turn and it keeps at least n: 0 until there are
// 2n of them, then n further each time k grows by n.
func windowStart(k, n int) int {
	if k <= n {
		return 0
	}
	return n * ((k - n) / n)
}

func orNone(l []string) []string {
	if len(l) == 0 {
		return []string{"(none)"}
	}
	return l
}

func nonNil(l []string) []string {
	if l == nil {
		return []string{}
	}
	return l
}

func taskLine(t projectstore.Task) string {
	var b strings.Builder
	fmt.Fprintf(&b, "- [%s] %s — goal: %s", t.ID, oneLineOf(t.Title, 80), oneLineOf(t.Goal, 200))
	add := func(label string, items []string) {
		if len(items) > 0 {
			fmt.Fprintf(&b, "; %s: %s", label, oneLineOf(strings.Join(items, " | "), 200))
		}
	}
	add("constraints", t.Constraints)
	add("acceptance", t.Acceptance)
	add("decisions", t.Decisions)
	if len(t.Quotes) > 0 {
		qs := make([]string, len(t.Quotes))
		for i, q := range t.Quotes {
			qs[i] = fmt.Sprintf("%q (msg %d)", oneLineOf(q.Text, 80), q.MessageID)
		}
		fmt.Fprintf(&b, "; quotes: %s", oneLineOf(strings.Join(qs, " | "), 300))
	}
	return clip(b.String(), 900)
}

// history is the assembly as the model's messages: the blocks that precede the
// window are merged into the first user message, the window follows as
// exchanges, then the current turn (verbatim, with the facts block in front of
// the user's message).
func (a *assembly) history() ([]anthropic.MessageParam, error) {
	type msg struct {
		role   string
		blocks []anthropic.ContentBlockParamUnion
	}
	var out []msg
	pending := []anthropic.ContentBlockParamUnion{}
	for _, b := range a.lead {
		pending = append(pending, anthropic.NewTextBlock(b.Text))
	}
	push := func(role string, blocks ...anthropic.ContentBlockParamUnion) {
		if role == "user" {
			blocks = append(pending, blocks...)
			pending = nil
		}
		if n := len(out); n > 0 && out[n-1].role == role {
			out[n-1].blocks = append(out[n-1].blocks, blocks...)
			return
		}
		out = append(out, msg{role, blocks})
	}
	for _, e := range a.window {
		if e.user != "" {
			push("user", anthropic.NewTextBlock(e.user))
		}
		if e.assistant != "" {
			push("assistant", anthropic.NewTextBlock(e.assistant))
		}
	}
	for i, m := range a.stored[a.currentFrom:] {
		p, ok, err := messageParamWith(m, a.load)
		if err != nil {
			return nil, err
		}
		if !ok {
			continue
		}
		blocks := agent.ContentOf(p)
		role := m.Role
		if role != "assistant" {
			role = "user"
		}
		if i == 0 && role == "user" {
			var front []anthropic.ContentBlockParamUnion
			if a.tasks != nil {
				front = append(front, anthropic.NewTextBlock(a.tasks.Text))
			}
			if a.facts != nil {
				front = append(front, anthropic.NewTextBlock(a.facts.Text))
			}
			blocks = append(front, blocks...)
		}
		push(role, blocks...)
	}
	if len(pending) > 0 { // no current turn (a report of the context between turns)
		if a.tasks != nil {
			pending = append(pending, anthropic.NewTextBlock(a.tasks.Text))
		}
		if a.facts != nil {
			pending = append(pending, anthropic.NewTextBlock(a.facts.Text))
		}
		out = append(out, msg{"user", pending})
	}
	res := make([]anthropic.MessageParam, len(out))
	for i, m := range out {
		if m.role == "assistant" {
			res[i] = anthropic.NewAssistantMessage(m.blocks...)
		} else {
			res[i] = anthropic.NewUserMessage(m.blocks...)
		}
	}
	return res, nil
}

// text renders the blocks for an agent that takes text (an ACP session's first
// prompt): the memory blocks, the recent exchanges, the facts.
func (a *assembly) text() string {
	var b strings.Builder
	for _, l := range a.lead {
		b.WriteString(l.Text + "\n")
	}
	if len(a.window) > 0 {
		b.WriteString("## Recent exchanges\n")
		for _, e := range a.window {
			fmt.Fprintf(&b, "user: %s\n", e.user)
			if e.assistant != "" {
				fmt.Fprintf(&b, "assistant: %s\n", e.assistant)
			}
		}
		b.WriteString("\n")
	}
	if a.tasks != nil {
		b.WriteString(a.tasks.Text + "\n")
	}
	if a.facts != nil {
		b.WriteString(a.facts.Text + "\n")
	}
	return b.String()
}

// finish adds the current turn to the receipt and returns the history.
func (a *assembly) finish() ([]anthropic.MessageParam, error) {
	h, err := a.history()
	if err != nil {
		return nil, err
	}
	var ids []string
	var chars int
	for _, m := range a.stored[a.currentFrom:] {
		ids = append(ids, fmt.Sprint(m.ID))
		chars += len(m.Raw)
	}
	a.receipt.add(ReceiptBlock{Name: BlockCurrent, Tokens: projectstore.EstimateTokens(chars), Count: len(ids), IDs: nonNil(ids)})
	a.receipt.MessageCount = len(h)
	return h, nil
}

// orchestratorHistory is the conversation the built-in orchestrator's next
// request starts from: the whole transcript (mode full, with the latest
// compaction summary as before) or the assembled window. With save, the
// turn's context receipt is stored.
func (rt *runtime) orchestratorHistory(ctx context.Context, orch projectstore.Agent, save bool) ([]anthropic.MessageParam, error) {
	st := memory.ParseSettings(rt.info.MemoryJSON)
	if st.Context == memory.ContextWindow {
		as, err := rt.assembleWindow(ctx, orch, st)
		if err != nil {
			return nil, err
		}
		h, err := as.finish()
		if err != nil {
			return nil, err
		}
		if co := rt.clearCarryOver(ctx, orch.ID); co != "" {
			h = append([]anthropic.MessageParam{anthropic.NewUserMessage(anthropic.NewTextBlock(co))}, h...)
		}
		if save {
			rt.setReceipt(as.receipt)
		}
		return h, nil
	}
	h, err := rt.loadHistory(ctx, orch.ID)
	if err != nil {
		return nil, err
	}
	if save {
		var chars int
		for _, m := range h {
			chars += messageChars(m, nil)
		}
		r := Receipt{TurnID: rt.turnID, Mode: memory.ContextFull, RecentExchanges: st.RecentExchanges, CreatedAt: projectstore.Now(), MessageCount: len(h)}
		r.add(ReceiptBlock{Name: BlockHistory, Tokens: projectstore.EstimateTokens(chars), Count: len(h), IDs: []string{}})
		rt.setReceipt(r)
	}
	return h, nil
}

// setReceipt keeps the turn's receipt and stores it.
func (rt *runtime) setReceipt(r Receipt) {
	if rt.isACPOrchestrator() {
		r.InstructionsNote = ACPInstructionsNote
	} else if b, ok := rt.instructionsBlock(); ok && !slices.ContainsFunc(r.Blocks, func(x ReceiptBlock) bool { return x.Name == BlockInstructions }) {
		r.add(b)
	}
	rt.rcptMu.Lock()
	rt.rcpt = &r
	rt.rcptMu.Unlock()
	rt.saveReceipt()
}

// addCleared counts tool results cleared in this turn's requests.
func (rt *runtime) addCleared(n int) {
	rt.rcptMu.Lock()
	if rt.rcpt != nil {
		rt.rcpt.ClearedCalls += n
	}
	rt.rcptMu.Unlock()
	rt.saveReceipt()
}

func (rt *runtime) saveReceipt() {
	rt.rcptMu.Lock()
	var raw []byte
	var turn int64
	var mode string
	if rt.rcpt != nil {
		raw, _ = json.Marshal(rt.rcpt)
		turn, mode = rt.rcpt.TurnID, rt.rcpt.Mode
	}
	rt.rcptMu.Unlock()
	if raw == nil || turn == 0 {
		return
	}
	c, cancel := dbCtx(context.Background())
	defer cancel()
	if err := rt.db.SaveReceipt(c, turn, mode, string(raw)); err != nil {
		rt.logErr("save context receipt", err)
	}
}

// TurnReceipt returns the stored context receipt of a turn (its user message id).
func (o *Orchestrator) TurnReceipt(ctx context.Context, pid string, turnID int64) (json.RawMessage, error) {
	db, err := o.store.Get(ctx, pid)
	if err != nil {
		return nil, err
	}
	raw, err := db.Receipt(ctx, turnID)
	return json.RawMessage(raw), err
}
