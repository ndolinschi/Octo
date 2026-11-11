package project

import (
	"context"
	"errors"
	"strings"

	"github.com/ndolinschi/Octo/apps/harness/internal/orchestrator"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

// AskSide starts a side question; the answer arrives as side.* events.
func (s *Service) AskSide(ctx context.Context, pid, text string) (orchestrator.SideStart, error) {
	if strings.TrimSpace(text) == "" {
		return orchestrator.SideStart{}, invalid("text is required")
	}
	start, err := s.turns.Side(ctx, pid, strings.TrimSpace(text))
	switch {
	case errors.Is(err, orchestrator.ErrSideInProgress):
		return start, sideInProgress()
	case errors.Is(err, projectstore.ErrNotFound):
		return start, notFound("project")
	}
	return start, err
}

// SideMessages lists the project's current side conversation, oldest first.
func (s *Service) SideMessages(ctx context.Context, pid string) ([]projectstore.SideMessage, error) {
	db, err := s.db(ctx, pid)
	if err != nil {
		return nil, err
	}
	return db.SideMessages(ctx)
}

// ClearSide stops a running side question and deletes the conversation.
func (s *Service) ClearSide(ctx context.Context, pid string) error {
	db, err := s.db(ctx, pid)
	if err != nil {
		return err
	}
	s.turns.CancelSide(pid)
	return db.ClearSide(ctx)
}
