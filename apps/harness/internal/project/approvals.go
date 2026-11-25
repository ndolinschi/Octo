package project

import (
	"context"
	"errors"
	"slices"

	"github.com/ndolinschi/Octo/apps/harness/internal/approval"
	"github.com/ndolinschi/Octo/apps/harness/internal/events"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

// Approvals lists the pending approval requests of a project.
func (s *Service) Approvals(ctx context.Context, pid string) ([]approval.Approval, error) {
	if _, err := s.db(ctx, pid); err != nil {
		return nil, err
	}
	return s.turns.Approvals(pid), nil
}

// ApprovalAnswer is the body of POST /approvals/{id}.
type ApprovalAnswer struct {
	Decision string `json:"decision"`
	OptionID string `json:"option_id"`
	Note     string `json:"note"`
	// Match overrides the rule an allow_always saves: the first words of the
	// command, or a path glob, or a host glob; empty means the suggested rule
	// the approval carries.
	Match string `json:"match"`
}

// ResolveApproval answers a pending approval request.
func (s *Service) ResolveApproval(ctx context.Context, pid, id string, a ApprovalAnswer) error {
	if _, err := s.db(ctx, pid); err != nil {
		return err
	}
	if !slices.Contains(approval.Decisions, a.Decision) {
		return invalid("decision must be allow, allow_for_turn, allow_all_for_turn, allow_always or deny")
	}
	if len(a.Note) > 4000 || len(a.Match) > 1000 {
		return invalid("note or match is too long")
	}
	err := s.turns.ResolveApproval(pid, id, approval.Resolution{Decision: a.Decision, OptionID: a.OptionID, Note: a.Note, Match: a.Match})
	switch {
	case errors.Is(err, approval.ErrNotFound):
		return notFound("approval")
	case errors.Is(err, approval.ErrNoRule):
		return &Error{Kind: KindUnprocessable, Code: "no_rule", Message: err.Error()}
	case errors.Is(err, approval.ErrInvalid):
		return invalid("%s", err.Error())
	}
	return err
}

// ApprovalRules lists the project's saved "always allow" rules, oldest first.
func (s *Service) ApprovalRules(ctx context.Context, pid string) ([]projectstore.ApprovalRule, error) {
	db, err := s.db(ctx, pid)
	if err != nil {
		return nil, err
	}
	return db.ApprovalRules(ctx)
}

// DeleteApprovalRule removes a saved rule: later requests it covered are asked about again.
func (s *Service) DeleteApprovalRule(ctx context.Context, pid, rid string) error {
	db, err := s.db(ctx, pid)
	if err != nil {
		return err
	}
	if err := db.DeleteApprovalRule(ctx, rid); err != nil {
		if errors.Is(err, projectstore.ErrNotFound) {
			return notFound("approval rule")
		}
		return err
	}
	s.hub.Publish(pid, events.ApprovalRuleDeleted, map[string]any{"id": rid})
	return nil
}
