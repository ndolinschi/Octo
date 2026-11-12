package project

import (
	"context"
	"errors"
	"strings"

	"github.com/ndolinschi/Octo/apps/harness/internal/events"
	"github.com/ndolinschi/Octo/apps/harness/internal/orchestrator"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

func (s *Service) Agents(ctx context.Context, pid string) ([]projectstore.Agent, error) {
	db, err := s.db(ctx, pid)
	if err != nil {
		return nil, err
	}
	return db.Agents(ctx)
}

func (s *Service) Agent(ctx context.Context, pid, aid string) (projectstore.Agent, error) {
	db, err := s.db(ctx, pid)
	if err != nil {
		return projectstore.Agent{}, err
	}
	a, err := db.Agent(ctx, aid)
	if errors.Is(err, projectstore.ErrNotFound) {
		return a, notFound("agent")
	}
	return a, err
}

func (s *Service) Messages(ctx context.Context, pid, aid string) ([]projectstore.Message, error) {
	if _, err := s.Agent(ctx, pid, aid); err != nil {
		return nil, err
	}
	db, err := s.db(ctx, pid)
	if err != nil {
		return nil, err
	}
	return db.Messages(ctx, aid)
}

// Compactions lists the markers of an agent's transcript: where a router
// compaction replaced the history sent to the model.
func (s *Service) Compactions(ctx context.Context, pid, aid string) ([]Compaction, error) {
	if _, err := s.Agent(ctx, pid, aid); err != nil {
		return nil, err
	}
	db, err := s.db(ctx, pid)
	if err != nil {
		return nil, err
	}
	list, err := db.Compactions(ctx, aid)
	if err != nil {
		return nil, err
	}
	out := make([]Compaction, len(list))
	for i, c := range list {
		out[i] = Compaction{UptoMessageID: c.UptoMessageID, At: c.CreatedAt, SummaryTokens: c.SummaryTokens(),
			Label: "history compacted", Manual: c.Manual, MessageCount: c.MessageCount}
	}
	return out, nil
}

// PostMessage starts a turn on the project's orchestrator, or, while one
// runs (or messages wait ahead of it), queues the message: queued is then set
// and msg is empty.
func (s *Service) PostMessage(ctx context.Context, pid, text string, mode *string) (msg projectstore.Message, queued *projectstore.QueuedMessage, err error) {
	if strings.TrimSpace(text) == "" {
		return msg, nil, invalid("text is required")
	}
	if err := validMode(mode); err != nil {
		return msg, nil, err
	}
	m := ""
	if mode != nil {
		m = *mode
	}
	msg, queued, err = s.turns.SubmitMode(ctx, pid, text, m)
	switch {
	case errors.Is(err, orchestrator.ErrQueueFull):
		return msg, nil, queueFull()
	case errors.Is(err, orchestrator.ErrTurnInProgress):
		return msg, nil, turnInProgress("a turn is already running for this project")
	case errors.Is(err, projectstore.ErrNotFound):
		return msg, nil, notFound("project")
	}
	return msg, queued, storeErr(err)
}

func (s *Service) Cancel(ctx context.Context, pid string) error {
	if _, err := s.db(ctx, pid); err != nil {
		return err
	}
	s.turns.Cancel(pid)
	return nil
}

// Subscribe attaches to a project's event stream.
func (s *Service) Subscribe(ctx context.Context, pid string) (<-chan events.Event, func(), error) {
	if _, err := s.db(ctx, pid); err != nil {
		return nil, nil, err
	}
	ch, cancel := s.hub.Subscribe(pid)
	return ch, cancel, nil
}

// Context reports what the next request of the project's orchestrator (agentID
// empty) or of one agent would contain, by part.
func (s *Service) Context(ctx context.Context, pid, agentID string) (orchestrator.ContextReport, error) {
	if _, err := s.db(ctx, pid); err != nil {
		return orchestrator.ContextReport{}, err
	}
	if agentID != "" {
		if _, err := s.Agent(ctx, pid, agentID); err != nil {
			return orchestrator.ContextReport{}, err
		}
	}
	rep, err := s.turns.Context(ctx, pid, agentID)
	if errors.Is(err, projectstore.ErrNotFound) {
		return rep, notFound("agent")
	}
	return rep, err
}
