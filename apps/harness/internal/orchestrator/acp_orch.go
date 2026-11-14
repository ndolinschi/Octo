package orchestrator

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/acp"
	"github.com/ndolinschi/Octo/apps/harness/internal/agent"
	"github.com/ndolinschi/Octo/apps/harness/internal/changes"
	"github.com/ndolinschi/Octo/apps/harness/internal/mcp"
	"github.com/ndolinschi/Octo/apps/harness/internal/memory"
	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
	"github.com/ndolinschi/Octo/apps/harness/internal/router"
	"github.com/ndolinschi/Octo/apps/harness/internal/tools"
	"github.com/ndolinschi/Octo/apps/harness/internal/usererr"
)

const (
	// RecapCap is the most characters of earlier conversation the harness puts
	// in the first prompt of a fresh ACP session that has history to catch up on.
	RecapCap = 8000
	// recapMaxMessages bounds how many user/assistant texts are considered.
	recapMaxMessages = 40
	// mcpTokenEnv is the variable the stdio relay reads its token from.
	mcpTokenEnv = "OCTO_MCP_TOKEN"
)

// isACPOrchestrator reports whether the project's orchestrator is an ACP agent.
func (rt *runtime) isACPOrchestrator() bool { return plugins.IsACPRef(rt.models.Orchestrator) }

// acpOrchestratorTarget resolves models.orchestrator to an available agent.
func (rt *runtime) acpOrchestratorTarget() (acpTarget, error) {
	id, model, ok := plugins.ParseACPRef(rt.models.Orchestrator)
	if !ok {
		return acpTarget{}, usererr.AgentUnavailable("orchestrator model " + rt.models.Orchestrator + " is not a valid acp:<agent-id>[/<model>] setting")
	}
	t, msg := rt.pickACPAgent(id, model)
	if msg != "" {
		if missing := rt.missingAgent(id); missing != nil {
			return acpTarget{}, missing
		}
		return acpTarget{}, usererr.AgentUnavailable(msg)
	}
	return t, nil
}

// runACPOrchestrator is a turn of an ACP-run orchestrator: the user's request
// becomes one session/prompt on the project's long-lived ACP session.
func (rt *runtime) runACPOrchestrator(ctx context.Context, orch projectstore.Agent) (agent.Result, error) {
	target, err := rt.acpOrchestratorTarget()
	if err != nil {
		return agent.Result{}, err
	}
	if be := rt.budgetReached(ctx); be != nil {
		return agent.Result{}, be
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	s := rt.o.acp.session(rt.key())
	s.digestMu.Lock() // a digest prompt of the last turn may still be open in the session
	s.digestMu.Unlock()
	handler := newACPSession(rt, orch.ID, target.agent.ID, orch.Model)
	handler.orchestrator = true
	handler.flat = target.agent.FlatRateIn(target.processEnv())
	defer func() {
		handler.mu.Lock()
		cost, used := handler.lastCost, handler.lastUsed
		handler.mu.Unlock()
		s.mu.Lock()
		s.costSeen, s.usedSeen = cost, used
		s.mu.Unlock()
	}()
	fresh, err := s.beginTurn(ctx, cancel, rt, orch, handler, target)
	if err != nil {
		handler.finish(ctx, true)
		return agent.Result{}, err
	}
	defer s.endTurn()
	// The agent's usage counters are cumulative over its session, which outlives
	// a turn: carry them across turns (and, via open, across a resumed session)
	// so a turn's first update is a delta, not the whole session again.
	s.mu.Lock()
	handler.lastCost, handler.lastUsed = s.costSeen, s.usedSeen
	s.mu.Unlock()
	s.mu.Lock()
	if s.reg != nil {
		handler.setHarnessTools(s.reg)
	}
	s.mu.Unlock()

	prompt, err := rt.acpTurnPrompt(ctx, s, orch, fresh)
	if err != nil {
		handler.finish(ctx, true)
		return agent.Result{}, err
	}
	rt.ensureACPReceipt()
	s.mu.Lock()
	client, sessID := s.client, s.sessID
	s.mu.Unlock()
	rt.o.imgCaps.set(target.agent.ID, client.Capabilities().PromptImage)
	images := rt.lastUserImages(ctx, orch.ID)
	if len(images) > 0 && !client.Capabilities().PromptImage {
		handler.finish(ctx, true)
		return agent.Result{}, &ImagesUnsupported{AgentID: target.agent.ID, Label: target.agent.Label}
	}
	s.applyMode(ctx, rt, client, sessID)
	endSpan := rt.trackSpan(ctx, orch.ID, "", changes.SourceACPTurn)
	sent := time.Now()
	stop, err := client.PromptWith(ctx, sessID, prompt, images, handler)
	if err != nil && ctx.Err() == nil && handler.idle() && time.Since(sent) < deadOnArrival && connectionEnded(client) {
		// The agent process died between turns and the harness had not noticed
		// yet (its exit is seen asynchronously): the prompt never reached an agent
		// that did anything. Start a fresh process once and send it again.
		// NEW-10: only when the prompt failed at once. An agent that worked on it
		// for a while without a word (a long first model call) and then died was
		// working: sending the request again would run it twice, and a restart
		// that fails would read "stopped while starting".
		slog.Warn("acp agent was gone when the prompt was sent; restarting it", "project", rt.pid(), "agent", target.agent.ID, "err", err)
		s.mu.Lock()
		s.closeLocked()
		s.mu.Unlock()
		var fresh2 bool
		if fresh2, err = s.beginTurn(ctx, cancel, rt, orch, handler, target); err == nil {
			var prompt2 string
			if prompt2, err = rt.acpTurnPrompt(ctx, s, orch, fresh2); err == nil {
				s.mu.Lock()
				client, sessID = s.client, s.sessID
				s.mu.Unlock()
				stop, err = client.PromptWith(ctx, sessID, prompt2, images, handler)
			}
		}
	}
	endSpan()
	handler.finish(ctx, err != nil)
	rt.syncNotes(ctx, s)
	s.mu.Lock()
	fatal := s.fatal
	s.mu.Unlock()
	switch {
	case fatal != nil:
		return agent.Result{}, fatal
	case err != nil:
		return agent.Result{}, acpFailure(target.agent, false, err)
	}
	switch stop {
	case acp.StopEndTurn:
		if handler.nothing() {
			return agent.Result{}, nothingError(target.agent)
		}
		return agent.Result{Text: handler.finalText()}, nil
	case acp.StopCancelled:
		return agent.Result{}, errAgentCancelled
	}
	return agent.Result{}, stopError(target.agent, stop)
}

// beginTurn makes the session ready for a turn: the turn state first (the agent
// may list tools while the session is being opened), then the process and the
// ACP session (reused, resumed with session/load, or new). fresh reports a
// session that does not hold the earlier conversation. No lock is held while
// talking to the agent: it may call the MCP server meanwhile.
func (s *orchSession) beginTurn(ctx context.Context, cancel context.CancelFunc, rt *runtime, orch projectstore.Agent,
	handler *acpSession, t acpTarget) (fresh bool, err error) {
	reg, err := rt.registry(orch)
	if err != nil {
		return false, err
	}
	// ACP's fs/read_text_file covers read_file, and the agent has its own edit,
	// glob and web tools: the harness offers it none of these over MCP.
	reg = reg.Without("read_file", "edit", "glob", "web_fetch")
	cwd := rt.folders[0].Path
	s.mu.Lock()
	s.agentID, s.rt, s.reg, s.handler = orch.ID, rt, reg, handler
	s.turnCtx, s.turnCancel, s.fatal, s.busy = ctx, cancel, nil, true
	if s.aliveLocked() && s.pluginID == t.agent.ID && s.model == t.recorded() && s.cwd == cwd {
		s.mu.Unlock()
		return false, nil
	}
	s.closeLocked()
	s.mu.Unlock()
	fresh, err = s.open(ctx, rt, orch, t, cwd)
	if err != nil {
		s.mu.Lock()
		s.closeLocked()
		s.mu.Unlock()
		return fresh, err
	}
	// One process per running or recently used session: beyond max_running + 2 the least recently used idle one goes.
	s.h.trim(rt.pid(), rt.o.projectCap(ctx, rt.db)+2)
	return fresh, nil
}

func (s *orchSession) endTurn() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.turnCtx, s.turnCancel, s.busy, s.lastUsed = nil, nil, false, time.Now()
}

func (s *orchSession) setNoMCP(msg *usererr.Error) {
	s.mu.Lock()
	s.noMCP = msg
	s.mu.Unlock()
}

// open starts the agent process and a session on it.
func (s *orchSession) open(ctx context.Context, rt *runtime, orch projectstore.Agent, t acpTarget, cwd string) (bool, error) {
	ag := t.agent
	client, err := acp.Start(ctx, acp.Spec{
		Command: ag.Command, Args: ag.ArgsFor(t.model), Env: ag.ResolvedEnv(), Dir: cwd, Name: ag.ID, Redact: rt.redact,
		OnCommands: rt.o.commandsCallback(s, ag.ID),
	})
	if err != nil {
		return false, startFailure(t, err)
	}
	token := s.h.tokens.Issue(mcp.Binding{ProjectID: rt.pid(), SessionID: rt.sessionID, AgentID: orch.ID})
	client.TraceHide(token)
	s.mu.Lock()
	s.client, s.token, s.pluginID, s.model, s.cwd, s.sessID = client, token, ag.ID, t.recorded(), cwd, ""
	s.mu.Unlock()
	servers, warn := rt.o.mcpServers(ag.Label, client.Capabilities(), rt.pid(), token)
	s.setNoMCP(warn)

	c, cancel := dbCtx(ctx)
	stored, have, dbErr := rt.db.ACPSession(c, orch.ID)
	cancel()
	if dbErr != nil {
		rt.logErr("read acp session", dbErr)
	}
	if have && stored.PluginAgent == ag.ID && stored.Model == t.recorded() && client.Capabilities().LoadSession {
		err := s.loadWithFallback(ctx, client, ag.Label, stored.SessionID, cwd, servers)
		if err == nil {
			// The resumed session keeps counting from where it was: seed the
			// counters with what it has reported so far, so its next
			// usage_update is a delta (an agent that restarts its counters is
			// handled as a restart by the delta logic).
			uc, cancelU := dbCtx(ctx)
			since, uerr := rt.db.ACPSessionSince(uc, orch.ID)
			var cost float64
			var tokens int64
			if uerr == nil && since != "" {
				cost, tokens, uerr = rt.db.ACPUsageSince(uc, orch.ID, since)
			}
			cancelU()
			if uerr != nil {
				rt.logErr("seed acp usage counters", uerr)
			}
			s.mu.Lock()
			s.sessID = stored.SessionID
			s.costSeen, s.usedSeen = cost, tokens
			s.mu.Unlock()
			return false, nil
		}
		slog.Warn("acp session/load failed; starting a new session with a recap",
			"project", rt.pid(), "agent", ag.ID, "session", stored.SessionID, "err", err)
	}

	opts := acp.RunOptions{
		Model: t.model, ModelRequired: t.requested, ModelApplied: t.model != "" && len(ag.ModelArg) > 0,
		AuthHint: ag.Hint, Auth: authPolicy(ag),
		OnModels: func(m []acp.AdvertisedModel, cur string) { rt.o.noteAdvertised(ag.ID, m, cur) },
	}
	sess, err := client.NewSession(ctx, cwd, servers, opts)
	var rpcErr *acp.RPCError
	if err != nil && len(servers) > 0 && errors.As(err, &rpcErr) && ctx.Err() == nil {
		s.setNoMCP(refusedMCP(ag.Label, rpcErr))
		slog.Warn("acp agent refused MCP servers; continuing without harness tools", "project", rt.pid(), "agent", ag.ID, "err", err)
		sess, err = client.NewSession(ctx, cwd, nil, opts)
	}
	if err != nil {
		return false, acpFailure(ag, true, err) // NEW-10: before session/new answered, the agent was starting
	}
	s.mu.Lock()
	s.sessID = sess.ID
	s.modes, s.baseMode, s.curMode = sess.Modes, sess.Mode, sess.Mode
	s.mu.Unlock()
	c, cancel = dbCtx(ctx)
	defer cancel()
	if err := rt.db.SaveACPSession(c, projectstore.ACPSession{
		AgentID: orch.ID, PluginAgent: ag.ID, Model: t.recorded(), SessionID: sess.ID,
	}); err != nil {
		rt.logErr("save acp session", err)
	}
	rt.noteACPSession(ctx, ag.ID, t.recorded(), sess.ID)
	return true, nil
}

func refusedMCP(label string, e *acp.RPCError) *usererr.Error {
	return usererr.AgentRefusedToolServer(label, "the agent refused the harness's MCP server: "+e.Message)
}

// loadWithFallback resumes a stored session; an agent that refuses the MCP
// servers on load gets them dropped (with the warning) before giving up.
func (s *orchSession) loadWithFallback(ctx context.Context, client *acp.Client, label, id, cwd string, servers []acp.MCPServer) error {
	err := client.LoadSession(ctx, id, cwd, servers)
	var rpcErr *acp.RPCError
	if err != nil && len(servers) > 0 && errors.As(err, &rpcErr) && ctx.Err() == nil {
		if err2 := client.LoadSession(ctx, id, cwd, nil); err2 == nil {
			s.setNoMCP(refusedMCP(label, rpcErr))
			return nil
		}
	}
	return err
}

// mcpServers builds the session's mcpServers entry: the HTTP endpoint when the
// agent advertised mcpCapabilities.http, else a stdio entry running this binary
// as the relay. A non-empty warning means no entry could be built.
func (o *Orchestrator) mcpServers(label string, caps acp.Capabilities, pid, token string) (servers []acp.MCPServer, warning *usererr.Error) {
	base := o.bridgeURL()
	if base == "" {
		return nil, usererr.AgentRefusedToolServer(label, "the harness's MCP endpoint is not available (the bridge address is unknown)")
	}
	endpoint := strings.TrimRight(base, "/") + mcp.Path(pid)
	if caps.MCPHTTP {
		return []acp.MCPServer{acp.HTTPMCPServer(mcp.ServerName, endpoint,
			[]acp.HTTPHeader{{Name: "Authorization", Value: "Bearer " + token}})}, nil
	}
	cmd := o.opts.MCPRelay
	if len(cmd) == 0 {
		exe, err := os.Executable()
		if err != nil {
			return nil, usererr.AgentRefusedToolServer(label, "cannot locate the harness binary for the stdio MCP relay: "+err.Error())
		}
		cmd = []string{exe, "mcp-relay"}
	}
	command := cmd[0]
	if !filepath.IsAbs(command) {
		abs, err := filepath.Abs(command)
		if err != nil {
			return nil, usererr.AgentRefusedToolServer(label, "cannot resolve the MCP relay command: "+err.Error())
		}
		command = abs
	}
	args := append(append([]string{}, cmd[1:]...), "--url", endpoint, "--token-env", mcpTokenEnv)
	return []acp.MCPServer{acp.StdioMCPServer(mcp.ServerName, command, args,
		[]acp.EnvVar{{Name: mcpTokenEnv, Value: token}})}, nil
}

// acpTurnPrompt composes the text of this turn's session/prompt: the user's
// request, preceded on a fresh session by the orchestrator briefing and a
// recap of earlier conversation, and on a later turn by the project notes if
// they changed since the agent last saw them.
func (rt *runtime) acpTurnPrompt(ctx context.Context, s *orchSession, orch projectstore.Agent, fresh bool) (string, error) {
	msgs, err := rt.db.LiveMessages(ctx, orch.ID)
	if err != nil {
		return "", err
	}
	last := -1
	for i := len(msgs) - 1; i >= 0; i-- {
		if msgs[i].Role == "user" && messageText(msgs[i]) != "" {
			last = i
			break
		}
	}
	if last < 0 {
		return "", errors.New("no user message to send")
	}
	request := messageText(msgs[last])
	if msgs[last].Command != "" {
		// An agent slash command is sent as the whole prompt: agents take a command only when
		// the prompt starts with it. A new session's briefing waits for the next request.
		s.mu.Lock()
		s.unbriefed = s.unbriefed || fresh
		s.mu.Unlock()
		return request, nil
	}
	s.mu.Lock()
	if s.unbriefed {
		fresh, s.unbriefed = true, false
	}
	s.mu.Unlock()
	_, notes := rt.orchestratorPromptParts()
	notesHash := hashText(notes)

	s.mu.Lock()
	seen, noMCP := s.notesSent, s.noMCP
	s.notesSent = notesHash
	s.mu.Unlock()

	st := memory.ParseSettings(rt.info.MemoryJSON)
	windowed := st.Context == memory.ContextWindow
	var b strings.Builder
	switch {
	case fresh:
		b.WriteString(rt.acpBriefing())
		b.WriteString(notes)
		if windowed {
			// The same assembly the built-in orchestrator gets: memory index, open
			// tasks, the last exchanges, the facts (replacing the "last 40 texts" recap).
			as, err := rt.assembleWindow(ctx, orch, st)
			if err != nil {
				return "", err
			}
			if _, err := as.finish(); err != nil {
				return "", err
			}
			b.WriteString("\nEarlier in this conversation (assembled by the harness; you have no other memory of it):\n")
			b.WriteString(as.text())
			if co := rt.clearCarryOver(ctx, orch.ID); co != "" {
				b.WriteString("\n" + co + "\n")
			}
			rt.setReceipt(as.receipt)
			s.mu.Lock()
			s.tasksSeen = projectstore.Now()
			s.mu.Unlock()
		} else {
			recap, err := rt.recap(ctx, orch.ID, msgs[:last])
			if err != nil {
				return "", err
			}
			if recap != "" {
				b.WriteString("\nEarlier in this conversation (recap built by the harness; you have no other memory of it):\n")
				b.WriteString(recap)
				b.WriteString("\n")
			}
			b.WriteString(rt.memory().PreviousSessionPointer(ctx))
		}
		b.WriteString("\nUser request:\n")
	case seen != notesHash:
		b.WriteString("[Project notes changed; current notes follow.]\n" + notes + "\nUser request:\n")
	}
	if windowed && !fresh {
		// A live session owns its context; it is told which open tasks changed since its last turn.
		if block, ids := rt.changedTasks(ctx, s); block != "" {
			b.WriteString(block)
			r := Receipt{TurnID: rt.turnID, Mode: memory.ContextWindow, RecentExchanges: st.RecentExchanges, CreatedAt: projectstore.Now()}
			r.add(ReceiptBlock{Name: BlockChanged, Tokens: tokensOf(block), Count: len(ids), IDs: ids})
			r.add(ReceiptBlock{Name: BlockCurrent, Tokens: tokensOf(request), Count: 1, IDs: []string{fmt.Sprint(msgs[last].ID)}})
			rt.setReceipt(r)
		}
	}
	if noMCP != nil && fresh {
		b.WriteString("(Note: the harness tools are unavailable in this session.)\n")
	}
	if rt.planText != "" {
		b.WriteString("Approved plan (pinned; the user approved it, carry it out and report against it):\n" + rt.planText + "\n\n")
	}
	if rt.reportNote != "" {
		b.WriteString(rt.reportNote + "\n\n")
	}
	if n := modeNote(rt.mode); n != "" {
		b.WriteString("[" + n + "]\n")
	}
	if prev, e, ok := unansweredBefore(msgs, last, rt.unfinishedTurns(ctx, orch.ID)); ok {
		b.WriteString(closedPromptNote(prev, e)) // NEW-8: the agent may hold the unanswered request (closed.go)
	}
	b.WriteString(request)
	return b.String(), nil
}

func hashText(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

// syncNotes records the notes as they are after a turn as seen by the agent:
// it wrote any changes itself (write_note), so only edits made between turns
// are announced with the next request. (A user's edit made while the turn runs
// is folded in here and not announced.)
func (rt *runtime) syncNotes(ctx context.Context, s *orchSession) {
	c, cancel := dbCtx(ctx)
	defer cancel()
	notes, err := rt.db.Notes(c)
	if err != nil {
		rt.logErr("read notes", err)
		return
	}
	s.mu.Lock()
	s.notesSent = hashText(notesBlock(notes))
	s.mu.Unlock()
}

// acpBriefing is the orchestrator's system prompt adapted for an ACP agent
// (which has its own system prompt and takes ours as the first message).
func (rt *runtime) acpBriefing() string {
	var b strings.Builder
	b.WriteString("You are the orchestrator of a software project, the single long-lived agent the user talks to; every message " +
		"in this conversation is the same user speaking about the same project.\n\n")
	b.WriteString(rt.brief())
	b.WriteString(`
Harness tools: the harness gives you an MCP server named "octo-harness" with spawn_agent, write_note, read_note, search_notes, save_note, delete_note, list_dir and the memory tools (task_update, memory, memory_search, recall_message).
- Keep your own context small; delegate self-contained work with spawn_agent. A sub-agent sees none of this conversation, so each task brief must be self-contained and say what report you expect. Its final report is returned as the tool result.
- ` + rt.spawnArgsGuidance() + `
- ` + rt.tierGuidance() + ` Issue several spawn_agent calls in one message to run independent sub-tasks in parallel.
- Notes are your durable memory, shown to you as an index of descriptions: open a note with read_note only when its description is relevant, and use search_notes before saying you do not know. Record durable intent, decisions and facts with write_note (a one-line description you write, then the body in Markdown); delete stale notes with delete_note. Keep notes short.
- Your own file and shell tools work only inside the project folders.
- Answer the user concisely in markdown: what was found or changed, and what remains.
` + memoryGuidance)
	b.WriteString(rt.acpPrompt())
	return b.String()
}

// messageText joins the text blocks of a stored message.
func messageText(m projectstore.Message) string {
	var parts []string
	for _, b := range m.Content {
		if b.Type == "text" && b.Text != nil && strings.TrimSpace(*b.Text) != "" {
			parts = append(parts, strings.TrimSpace(*b.Text))
		}
	}
	return strings.Join(parts, "\n")
}

// recap summarizes the conversation before the current request for a session
// that has no memory of it: the latest compaction summary when the agent row
// has one, otherwise the most recent user/assistant texts (at most
// recapMaxMessages of them), newest kept first, in order, and all within
// RecapCap characters. Tool calls and results are left out.
func (rt *runtime) recap(ctx context.Context, agentID string, before []projectstore.Message) (string, error) {
	comp, ok, err := rt.db.LatestCompaction(ctx, agentID)
	if err != nil {
		return "", err
	}
	if len(before) == 0 && !(ok && comp.Cleared) {
		return "", nil
	}
	if ok {
		return clip(comp.Summary, RecapCap), nil
	}
	var lines []string
	used := 0
	for i := len(before) - 1; i >= 0 && len(lines) < recapMaxMessages; i-- {
		text := messageText(before[i])
		if text == "" {
			continue
		}
		line := before[i].Role + ": " + text
		room := RecapCap - used
		if room <= 0 {
			break
		}
		if len(line) > room {
			line = clip(line, room)
		}
		used += len(line) + 1
		lines = append([]string{line}, lines...)
	}
	return strings.Join(lines, "\n"), nil
}

// clip shortens s to at most n bytes at a rune boundary, marking the cut.
func clip(s string, n int) string {
	if len(s) <= n {
		return s
	}
	const mark = "...(cut)"
	if n <= len(mark) {
		return strings.ToValidUTF8(s[:n], "")
	}
	return strings.ToValidUTF8(s[:n-len(mark)], "") + mark
}

// MCPHandler is the harness's MCP server for ACP orchestrators, to be mounted
// by the bridge at mcp.PathPrefix.
func (o *Orchestrator) MCPHandler(version string) *mcp.Server {
	return mcp.NewServer(o.acp.tokens, mcpBackend{o: o}, version)
}

// SetBridgeURL tells the orchestrator where the bridge listens (a loopback
// base URL); ACP agents reach the MCP server there.
func (o *Orchestrator) SetBridgeURL(u string) {
	o.mu.Lock()
	o.bridge = u
	o.mu.Unlock()
}

func (o *Orchestrator) bridgeURL() string {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.bridge
}

// LiveMCPTokens counts unrevoked MCP session tokens (tests).
func (o *Orchestrator) LiveMCPTokens() int { return o.acp.tokens.Live() }

// mcpBackend serves the orchestrator's harness tools to its ACP agent. The
// tools are the ones the built-in orchestrator has (rt.registry), so a call
// runs the very same handlers, limits, budget checks and events.
type mcpBackend struct{ o *Orchestrator }

func (b mcpBackend) session(bind mcp.Binding) (*orchSession, error) {
	s := b.o.acp.lookup(skey(bind.ProjectID, bind.SessionID))
	if s == nil {
		return nil, errors.New("no ACP orchestrator session for this project session")
	}
	return s, nil
}

func (b mcpBackend) Tools(bind mcp.Binding) ([]mcp.Tool, error) {
	s, err := b.session(bind)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.reg == nil || s.agentID != bind.AgentID {
		return nil, errors.New("the orchestrator has not started a turn yet")
	}
	defs := s.reg.All()
	out := make([]mcp.Tool, 0, len(defs))
	for _, d := range defs {
		out = append(out, mcp.Tool{Name: d.Name, Description: d.Description, InputSchema: d.InputSchema})
	}
	return out, nil
}

func (b mcpBackend) Call(ctx context.Context, bind mcp.Binding, name string, args json.RawMessage) (string, bool, error) {
	s, err := b.session(bind)
	if err != nil {
		return "", false, err
	}
	s.mu.Lock()
	reg, handler, turnCtx, rt, agentID, cancelTurn := s.reg, s.handler, s.turnCtx, s.rt, s.agentID, s.turnCancel
	s.mu.Unlock()
	if reg == nil || agentID != bind.AgentID {
		return "", false, errors.New("the orchestrator has not started a turn yet")
	}
	if _, ok := reg.Get(name); !ok {
		return "", false, mcp.ErrUnknownTool
	}
	if turnCtx == nil {
		return "harness tools can only be used while a user request is running", true, nil
	}
	// The call lives as long as both the HTTP request and the turn: a cancelled
	// turn cancels the sub-agents it started.
	cctx, cancel := context.WithCancel(ctx)
	defer cancel()
	defer context.AfterFunc(turnCtx, cancel)()
	id := handler.claimToolUse(cctx, name, args)
	if id == "" {
		id = projectstore.NewID("mcp")
	}
	cctx = tools.WithToolUseID(cctx, id)
	text, isErr, err := agent.CallTool(cctx, reg, name, args, rt.o.opts.Limits)
	if err != nil {
		if router.IsBudget(err) {
			// Same as the built-in loop: a reached budget stops the whole turn.
			s.mu.Lock()
			s.fatal = err
			s.mu.Unlock()
			cancelTurn()
			return err.Error(), true, nil
		}
		return "", false, err
	}
	return text, isErr, nil
}

// deadOnArrival is how soon a prompt to an agent process that had already died fails: its exit is
// pending on the connection when the prompt is written. A prompt that fails later reached a live agent.
const deadOnArrival = time.Second

// connectionEnded reports whether the agent's connection is (or, within a
// moment, becomes) closed: a process that died is noticed by the reader asynchronously.
func connectionEnded(c *acp.Client) bool {
	select {
	case <-c.Done():
		return true
	case <-time.After(2 * time.Second):
		return false
	}
}

// changedTasks is the block of open task records that changed since the session
// last heard from the harness (not the record of this very request).
func (rt *runtime) changedTasks(ctx context.Context, s *orchSession) (string, []string) {
	s.mu.Lock()
	since := s.tasksSeen
	s.tasksSeen = projectstore.Now()
	s.mu.Unlock()
	tasks, err := rt.memory().Tasks(ctx)
	if err != nil || since == "" {
		return "", nil
	}
	var lines, ids []string
	for _, t := range tasks {
		if t.Status != projectstore.TaskOpen || t.UpdatedAt <= since || (len(t.MessageIDs) == 1 && t.MessageIDs[0] == rt.turnID) {
			continue
		}
		lines = append(lines, taskLine(t))
		ids = append(ids, t.ID)
	}
	if len(lines) == 0 {
		return "", nil
	}
	text, n := capLines("[Open task records that changed since your last turn]\n", lines, CapTasks)
	return text + "\n", ids[:min(n, len(ids))]
}
