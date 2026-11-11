package project

import (
	"context"
	"errors"
	"slices"

	"github.com/ndolinschi/Octo/apps/harness/internal/approval"
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
}

// ResolveApproval answers a pending approval request.
func (s *Service) ResolveApproval(ctx context.Context, pid, id string, a ApprovalAnswer) error {
	if _, err := s.db(ctx, pid); err != nil {
		return err
	}
	if !slices.Contains([]string{approval.Allow, approval.AllowForTurn, approval.Deny}, a.Decision) {
		return invalid("decision must be allow, allow_for_turn or deny")
	}
	if len(a.Note) > 4000 {
		return invalid("note is too long")
	}
	err := s.turns.ResolveApproval(pid, id, approval.Resolution{Decision: a.Decision, OptionID: a.OptionID, Note: a.Note})
	if errors.Is(err, approval.ErrNotFound) {
		return notFound("approval")
	}
	return err
}
