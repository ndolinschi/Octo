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

// PostMessage starts a turn on the project's orchestrator.
func (s *Service) PostMessage(ctx context.Context, pid, text string) (projectstore.Message, error) {
	if strings.TrimSpace(text) == "" {
		return projectstore.Message{}, invalid("text is required")
	}
	msg, err := s.turns.Start(ctx, pid, text)
	switch {
	case errors.Is(err, orchestrator.ErrTurnInProgress):
		return msg, turnInProgress("a turn is already running for this project")
	case errors.Is(err, projectstore.ErrNotFound):
		return msg, notFound("project")
	}
	return msg, err
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
