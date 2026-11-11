package project

import (
	"context"
	"errors"
	"strings"

	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

// QueueState is GET /queue.
type QueueState struct {
	Paused   bool                         `json:"paused"`
	Messages []projectstore.QueuedMessage `json:"messages"`
}

func queueErr(err error) error {
	if errors.Is(err, projectstore.ErrNotFound) {
		return notFound("queued message")
	}
	return err
}

// Queue returns the messages waiting for the running turn.
func (s *Service) Queue(ctx context.Context, pid string) (QueueState, error) {
	if _, err := s.db(ctx, pid); err != nil {
		return QueueState{}, err
	}
	msgs, paused, err := s.turns.Queue(ctx, pid)
	return QueueState{Paused: paused, Messages: msgs}, err
}

// EditQueued changes the text of a queued message.
func (s *Service) EditQueued(ctx context.Context, pid, qid, text string) (projectstore.QueuedMessage, error) {
	if strings.TrimSpace(text) == "" {
		return projectstore.QueuedMessage{}, invalid("text is required")
	}
	if _, err := s.db(ctx, pid); err != nil {
		return projectstore.QueuedMessage{}, err
	}
	m, err := s.turns.EditQueued(ctx, pid, qid, text)
	return m, queueErr(err)
}

// RemoveQueued deletes one queued message, or all of them when qid is empty.
func (s *Service) RemoveQueued(ctx context.Context, pid, qid string) error {
	if _, err := s.db(ctx, pid); err != nil {
		return err
	}
	return queueErr(s.turns.RemoveQueued(ctx, pid, qid))
}

// ResumeQueue lifts the pause after a failed or cancelled turn.
func (s *Service) ResumeQueue(ctx context.Context, pid string) error {
	if _, err := s.db(ctx, pid); err != nil {
		return err
	}
	return s.turns.ResumeQueue(ctx, pid)
}

// SendNow cancels the running turn (if any) and runs the queued message first.
func (s *Service) SendNow(ctx context.Context, pid, qid string) error {
	if _, err := s.db(ctx, pid); err != nil {
		return err
	}
	return queueErr(s.turns.SendNow(ctx, pid, qid))
}
