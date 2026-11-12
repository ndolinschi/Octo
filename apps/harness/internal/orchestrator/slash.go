package orchestrator

import (
	"context"
	"slices"
	"strings"

	"github.com/ndolinschi/Octo/apps/harness/internal/acp"
	"github.com/ndolinschi/Octo/apps/harness/internal/events"
	"github.com/ndolinschi/Octo/apps/harness/internal/memory"
	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
)

// OctoCommand is one slash command the harness (or the UI) runs itself, with any orchestrator.
type OctoCommand struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Args        string `json:"args,omitempty"`
	Available   bool   `json:"available"`
	Reason      string `json:"reason,omitempty"`
	// Endpoint is what a client calls to run the command ({id} is the project id).
	Endpoint string `json:"endpoint"`
}

// octoCommands are the Octo commands in menu order; Available is filled per project.
var octoCommands = []OctoCommand{
	{Name: "compact", Description: "Summarise the conversation so far to free context", Endpoint: "POST /v1/projects/{id}/compact"},
	{Name: "clear", Description: "Start a new conversation; the history stays searchable", Endpoint: "POST /v1/projects/{id}/clear"},
	{Name: "mode", Description: "Set the mode of the next requests", Args: "ask|plan|agent", Endpoint: "PATCH /v1/projects/{id} {\"mode\"} or the mode of POST /v1/projects/{id}/messages"},
	{Name: "model", Description: "Choose the orchestrator model", Args: "<name>", Endpoint: "PATCH /v1/projects/{id} {\"models\"}"},
	{Name: "rewind", Description: "Cut the project back to an earlier request", Endpoint: "POST /v1/projects/{id}/rewind"},
	{Name: "export", Description: "Export the conversation as Markdown", Endpoint: "GET /v1/projects/{id}/export?format=md"},
	{Name: "review", Description: "Review a pull request or a change", Args: "[pr]", Endpoint: "POST /v1/projects/{id}/reviews"},
	{Name: "context", Description: "Show what the next request contains", Endpoint: "GET /v1/projects/{id}/context"},
	{Name: "memory", Description: "Show the project's memory", Endpoint: "GET /v1/projects/{id}/memory"},
	{Name: "settings", Description: "Open the settings", Endpoint: "GET /v1/settings"},
	{Name: "remember", Description: "Keep a note for every later session", Args: "<text>", Endpoint: "POST /v1/projects/{id}/facts"},
	{Name: "help", Description: "List the slash commands", Endpoint: "GET /v1/projects/{id}/slash-commands"},
}

// SlashToken is the command name of text whose first token is "/name" ("" otherwise).
func SlashToken(text string) string {
	f := strings.Fields(text)
	if len(f) == 0 || len(f[0]) < 2 || f[0][0] != '/' {
		return ""
	}
	return f[0][1:]
}

// OctoCommandIn reports the Octo command a message starts with: such a message is run by
// calling its endpoint and never sent to a model.
func OctoCommandIn(text string) (OctoCommand, bool) {
	name := strings.ToLower(SlashToken(text))
	for _, c := range octoCommands {
		if c.Name == name {
			return c, true
		}
	}
	return OctoCommand{}, false
}

// AgentCommands is the agent group of GET /slash-commands.
type AgentCommands struct {
	ID       string        `json:"id"`
	Label    string        `json:"label"`
	Commands []acp.Command `json:"commands"`
	// Pending: the agent has not advertised a list yet (no session so far); the harness
	// does not start one to read it.
	Pending bool `json:"pending,omitempty"`
}

// SlashReport is GET /v1/projects/{id}/slash-commands.
type SlashReport struct {
	Octo  []OctoCommand  `json:"octo"`
	Agent *AgentCommands `json:"agent"`
}

// noteCommands records the list the agent advertised; changed is false when it is the list already held.
func (s *orchSession) noteCommands(agentID string, cmds []acp.Command) (changed bool) {
	if cmds == nil {
		cmds = []acp.Command{}
	}
	s.cmu.Lock()
	defer s.cmu.Unlock()
	changed = !s.cmdsSet || s.cmdsAgent != agentID || !slices.Equal(s.cmds, cmds)
	s.cmds, s.cmdsAgent, s.cmdsSet = cmds, agentID, true
	return changed
}

// commandsOf is the last list the plugin agent advertised in this project (known false before the first).
func (s *orchSession) commandsOf(agentID string) (cmds []acp.Command, known bool) {
	if s == nil {
		return nil, false
	}
	s.cmu.Lock()
	defer s.cmu.Unlock()
	if !s.cmdsSet || s.cmdsAgent != agentID {
		return nil, false
	}
	return slices.Clone(s.cmds), true
}

func (s *orchSession) forgetCommands() {
	s.cmu.Lock()
	s.cmds, s.cmdsAgent, s.cmdsSet = nil, "", false
	s.cmu.Unlock()
}

// commandsCallback is what the ACP client calls with each advertised list.
func (o *Orchestrator) commandsCallback(s *orchSession, agentID string) func([]acp.Command) {
	return func(cmds []acp.Command) {
		if s.noteCommands(agentID, cmds) {
			o.hub.Publish(s.pid, events.SlashCommandsUpdated, map[string]any{"project_id": s.pid})
		}
	}
}

// agentCommandNamed reports whether the project's ACP orchestrator advertises the command called name.
func (o *Orchestrator) agentCommandNamed(rt *runtime, name string) bool {
	id, _, ok := plugins.ParseACPRef(rt.models.Orchestrator)
	if !ok || name == "" {
		return false
	}
	cmds, known := o.acp.lookup(rt.pid()).commandsOf(id)
	return known && slices.ContainsFunc(cmds, func(c acp.Command) bool { return c.Name == name })
}

// SlashCommands lists the commands the composer offers: the Octo ones with their availability, and
// what the ACP orchestrator advertised.
func (o *Orchestrator) SlashCommands(ctx context.Context, pid string) (SlashReport, error) {
	db, err := o.store.Get(ctx, pid)
	if err != nil {
		return SlashReport{}, err
	}
	rt, err := o.newRuntime(ctx, db)
	if err != nil {
		return SlashReport{}, err
	}
	rep := SlashReport{Octo: slices.Clone(octoCommands)}
	for i := range rep.Octo {
		rep.Octo[i].Available = true
	}
	var agent *AgentCommands
	if id, _, ok := plugins.ParseACPRef(rt.models.Orchestrator); ok && rt.isACPOrchestrator() {
		agent = &AgentCommands{ID: id, Label: id, Commands: []acp.Command{}}
		for _, a := range o.agents() {
			if a.ID == id {
				agent.Label = a.Label
			}
		}
		cmds, known := o.acp.lookup(pid).commandsOf(id)
		agent.Pending = !known
		if known {
			agent.Commands = cmds
		}
	}
	rep.Agent = agent
	compact := &rep.Octo[0]
	switch {
	case agent != nil && agent.Pending:
		compact.Available, compact.Reason = false, "the agent's commands are not known yet: it advertises them when its session starts, after the first request"
	case agent != nil && !slices.ContainsFunc(agent.Commands, func(c acp.Command) bool { return c.Name == "compact" }):
		compact.Available, compact.Reason = false, "the agent does not advertise a compact command: it compacts its own context"
	case agent == nil && memory.ParseSettings(rt.info.MemoryJSON).Context == memory.ContextWindow:
		compact.Available, compact.Reason = false, "this project's memory mode is window: only recent exchanges are sent, there is no history to compact"
	}
	return rep, nil
}
