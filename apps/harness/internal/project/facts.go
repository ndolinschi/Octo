package project

import (
	"context"
	"errors"

	"github.com/ndolinschi/Octo/apps/harness/internal/memory"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

// Remembered is POST /facts: the fact and the task record that holds it.
type Remembered struct {
	TaskID string            `json:"task_id"`
	Fact   projectstore.Fact `json:"fact"`
}

// Remember keeps an item the user asked for (/remember) as a dated fact; kind defaults to "fact".
func (s *Service) Remember(ctx context.Context, pid, text, kind, about string) (Remembered, error) {
	m, err := s.mem(ctx, pid)
	if err != nil {
		return Remembered{}, err
	}
	if kind == "" {
		kind = "fact"
	}
	f, taskID, err := m.Remember(ctx, memory.RememberInput{Text: text, Kind: kind, About: about, By: "user"})
	return Remembered{TaskID: taskID, Fact: f}, memErr(err)
}

// Forget deletes one fact (the undo of a remembered item).
func (s *Service) Forget(ctx context.Context, pid, taskID, factID string) error {
	m, err := s.mem(ctx, pid)
	if err != nil {
		return err
	}
	if err := m.Forget(ctx, taskID, factID); errors.Is(err, projectstore.ErrNotFound) {
		return notFound("fact")
	} else if err != nil {
		return memErr(err)
	}
	return nil
}
