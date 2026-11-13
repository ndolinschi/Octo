package project

import (
	"context"
	"errors"
	"strings"

	"github.com/ndolinschi/Octo/apps/harness/internal/orchestrator"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
	"github.com/ndolinschi/Octo/apps/harness/internal/usererr"
)

// Conversation is a boundary in the orchestrator's transcript: a new conversation starts
// after UptoMessageID (POST /clear). Messages before it stay in the transcript.
type Conversation struct {
	ConversationID string `json:"conversation_id"`
	UptoMessageID  int64  `json:"upto_message_id"`
	At             string `json:"at"`
	// Label is the marker's text ("New session · earlier: <title>"); Summary is the carry-over the
	// new session starts from and SummarySource who wrote its summary ("model", "agent", "stored").
	Label         string `json:"label"`
	Title         string `json:"title"`
	Summary       string `json:"summary"`
	SummarySource string `json:"summary_source"`
}

// Conversations lists the conversation boundaries of an agent's transcript, oldest first.
func (s *Service) Conversations(ctx context.Context, pid, aid string) ([]Conversation, error) {
	if _, err := s.Agent(ctx, pid, aid); err != nil {
		return nil, err
	}
	db, err := s.db(ctx, pid)
	if err != nil {
		return nil, err
	}
	list, err := db.Clears(ctx, aid)
	if err != nil {
		return nil, err
	}
	out := make([]Conversation, len(list))
	for i, c := range list {
		out[i] = Conversation{ConversationID: c.ConversationID, UptoMessageID: c.UptoMessageID, At: c.CreatedAt,
			Label: clearLabel(c.Title), Title: c.Title, Summary: c.Summary, SummarySource: c.SummarySource}
	}
	return out, nil
}

// SlashCommands is GET /slash-commands: the Octo commands and the ACP agent's own.
func (s *Service) SlashCommands(ctx context.Context, pid string) (orchestrator.SlashReport, error) {
	if _, err := s.db(ctx, pid); err != nil {
		return orchestrator.SlashReport{}, err
	}
	return s.turns.SlashCommands(ctx, pid)
}

// Clear starts a new conversation in the project (POST /clear).
func (s *Service) Clear(ctx context.Context, pid string) (orchestrator.ClearResult, error) {
	if _, err := s.db(ctx, pid); err != nil {
		return orchestrator.ClearResult{}, err
	}
	res, err := s.turns.Clear(ctx, pid)
	if errors.Is(err, orchestrator.ErrTurnInProgress) {
		return res, turnInProgress()
	}
	return res, storeErr(err)
}

// CompactViaAgent sends /compact to an ACP orchestrator that advertises it; sent is false
// when the orchestrator is not such an agent.
func (s *Service) CompactViaAgent(ctx context.Context, pid string) (msg projectstore.Message, sent bool, err error) {
	if _, err := s.db(ctx, pid); err != nil {
		return msg, false, err
	}
	msg, sent, err = s.turns.CompactViaAgent(ctx, pid)
	switch {
	case errors.Is(err, orchestrator.ErrTurnInProgress):
		return msg, false, turnInProgress()
	case orchestrator.IsNoBuiltinLoop(err):
		return msg, false, of(KindConflict, usererr.BuiltinLoopOff(err.Error()))
	}
	return msg, sent, err
}

// refuseOctoCommand is 400 octo_command for a message that starts with an Octo command: the
// client calls the command's endpoint instead of sending it to a model as text.
func refuseOctoCommand(text string) error {
	c, ok := orchestrator.OctoCommandIn(strings.TrimSpace(text))
	if !ok {
		return nil
	}
	return &Error{Kind: KindInvalid, Code: "octo_command",
		Message: "/" + c.Name + " is an Octo command and is not sent as a message: call " + c.Endpoint + " (the project id replaces {id})"}
}

func clearLabel(title string) string { return "New session \u00b7 earlier: " + title }
