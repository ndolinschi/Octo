package project

import (
	"context"
	"errors"

	"github.com/ndolinschi/Octo/apps/harness/internal/inputs"
	"github.com/ndolinschi/Octo/apps/harness/internal/secrets"
)

// Inputs lists the forms agents have open in a project.
func (s *Service) Inputs(ctx context.Context, pid string) ([]inputs.Input, error) {
	if _, err := s.db(ctx, pid); err != nil {
		return nil, err
	}
	return s.turns.Inputs(pid), nil
}

// SubmitInput submits or skips an open form. Errors name fields, never values.
func (s *Service) SubmitInput(ctx context.Context, pid, id string, a inputs.Answer) error {
	if _, err := s.db(ctx, pid); err != nil {
		return err
	}
	err := s.turns.SubmitInput(pid, id, a)
	var ve *inputs.ValidationError
	switch {
	case errors.Is(err, inputs.ErrNotFound):
		return notFound("form")
	case errors.As(err, &ve):
		return invalid("%s", ve.Msg)
	case errors.Is(err, secrets.ErrInvalidName), errors.Is(err, secrets.ErrInvalidValue):
		return invalid("%s", err.Error())
	}
	return err
}

// Secrets lists the names of a project's secrets; values are never returned.
func (s *Service) Secrets(ctx context.Context, pid string) ([]secrets.Info, error) {
	if _, err := s.db(ctx, pid); err != nil {
		return nil, err
	}
	return s.turns.Secrets(pid)
}

// PutSecret stores or replaces a secret.
func (s *Service) PutSecret(ctx context.Context, pid, name, value string) error {
	if _, err := s.db(ctx, pid); err != nil {
		return err
	}
	err := s.turns.PutSecret(pid, name, value)
	if errors.Is(err, secrets.ErrInvalidName) || errors.Is(err, secrets.ErrInvalidValue) {
		return invalid("%s", err.Error())
	}
	return err
}

// DeleteSecret removes a secret.
func (s *Service) DeleteSecret(ctx context.Context, pid, name string) error {
	if _, err := s.db(ctx, pid); err != nil {
		return err
	}
	err := s.turns.DeleteSecret(pid, name)
	if errors.Is(err, secrets.ErrNotFound) {
		return notFound("secret")
	}
	return err
}
