package project

import (
	"context"
	"errors"

	"github.com/ndolinschi/Octo/apps/harness/internal/completion"
	"github.com/ndolinschi/Octo/apps/harness/internal/orchestrator"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
	"github.com/ndolinschi/Octo/apps/harness/internal/router"
)

// Complete answers one inline-completion request. skipped is why nothing was
// sent to the model (the never-sent list); the result is then empty.
func (s *Service) Complete(ctx context.Context, pid string, req completion.Request) (completion.Result, string, error) {
	if err := req.Validate(); err != nil {
		return completion.Result{}, "", &Error{Kind: KindInvalid, Code: "invalid_request", Message: err.Error()}
	}
	res, skipped, err := s.turns.Complete(ctx, pid, req)
	var off *orchestrator.CompletionOffError
	var failed *orchestrator.CompletionFailedError
	var be *router.BudgetError
	switch {
	case err == nil:
		return res, skipped, nil
	case errors.Is(err, projectstore.ErrNotFound):
		return res, "", notFound("project")
	case errors.As(err, &off):
		return res, "", &Error{Kind: KindConflict, Code: "completion_off", Message: off.Reason}
	case errors.As(err, &be):
		return res, "", &Error{Kind: KindConflict, Code: "budget_reached", Message: be.Error()}
	case errors.As(err, &failed):
		return res, "", &Error{Kind: KindUpstream, Code: "completion_failed", Message: failed.Error()}
	}
	return res, "", err
}
