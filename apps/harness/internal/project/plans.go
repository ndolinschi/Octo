package project

import (
	"context"
	"errors"

	"github.com/ndolinschi/Octo/apps/harness/internal/orchestrator"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
	"github.com/ndolinschi/Octo/apps/harness/internal/usererr"
)

func validMode(m *string) error {
	if m != nil && !projectstore.ValidMode(*m) {
		return invalid("mode must be %q, %q or %q", projectstore.ModeAgent, projectstore.ModeAsk, projectstore.ModePlan)
	}
	return nil
}

// LatestPlan is the plan the newest plan-mode turn produced.
func (s *Service) LatestPlan(ctx context.Context, pid string) (projectstore.Plan, error) {
	if _, err := s.db(ctx, pid); err != nil {
		return projectstore.Plan{}, err
	}
	p, err := s.turns.LatestPlan(ctx, pid)
	if errors.Is(err, projectstore.ErrNotFound) {
		return p, notFound("plan")
	}
	return p, err
}

// ApprovePlan approves a plan and starts an agent turn with it pinned.
func (s *Service) ApprovePlan(ctx context.Context, pid, planID string) (projectstore.Plan, projectstore.Message, error) {
	if _, err := s.db(ctx, pid); err != nil {
		return projectstore.Plan{}, projectstore.Message{}, err
	}
	p, msg, err := s.turns.ApprovePlan(ctx, pid, planID)
	switch {
	case errors.Is(err, projectstore.ErrNotFound):
		return p, msg, notFound("plan")
	case errors.Is(err, projectstore.ErrPlanNotPending):
		return p, msg, of(KindConflict, usererr.PlanNotPending())
	case errors.Is(err, orchestrator.ErrTurnInProgress):
		return p, msg, turnInProgress()
	}
	return p, msg, err
}

// Rewind cuts the conversation back to a user request and restores the files the later turns changed
// (see orchestrator.Rewind). dryRun reports what would happen. A conflict is a 409 rewind_conflict
// whose details are the report; an id that is no request of the conversation is a 400.
func (s *Service) Rewind(ctx context.Context, pid string, messageID int64, dryRun bool) (orchestrator.RewindReport, error) {
	if _, err := s.db(ctx, pid); err != nil {
		return orchestrator.RewindReport{}, err
	}
	rep, err := s.turns.Rewind(ctx, pid, messageID, dryRun)
	switch {
	case errors.Is(err, orchestrator.ErrNotRequest):
		return rep, invalid("message_id must be the id of one of this conversation's user requests")
	case errors.Is(err, orchestrator.ErrTurnInProgress):
		return rep, turnInProgress()
	case errors.Is(err, orchestrator.ErrRewindConflict):
		if dryRun {
			return rep, nil // a dry run reports the conflicts; it is the real call that refuses
		}
		return rep, &Error{Kind: KindConflict, Code: "rewind_conflict", Details: rep,
			Message: "some files changed outside the harness since their last recorded change; nothing was changed"}
	}
	return rep, err
}
