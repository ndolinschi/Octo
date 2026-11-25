package project

import (
	"context"
	"strconv"

	"github.com/ndolinschi/Octo/apps/harness/internal/memory"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

// MemorySessions is GET /memory/sessions: newest first, before is the started_at to page from.
func (s *Service) MemorySessions(ctx context.Context, pid, limit, before string) ([]projectstore.Session, error) {
	m, err := s.mem(ctx, pid)
	if err != nil {
		return nil, err
	}
	n := 0
	if limit != "" {
		if n, err = strconv.Atoi(limit); err != nil || n < 1 {
			return nil, invalid("limit must be a positive integer")
		}
	}
	return m.Sessions(ctx, n, before)
}

// MemorySession is GET /memory/sessions/{sid}.
func (s *Service) MemorySession(ctx context.Context, pid, sid string) (memory.SessionDetail, error) {
	m, err := s.mem(ctx, pid)
	if err != nil {
		return memory.SessionDetail{}, err
	}
	d, err := m.Session(ctx, sid)
	if err != nil {
		return d, notFoundOr(err, "session")
	}
	return d, nil
}

// ForgetExchange is DELETE /memory/exchanges/{eid}.
func (s *Service) ForgetExchange(ctx context.Context, pid, eid string) error {
	m, err := s.mem(ctx, pid)
	if err != nil {
		return err
	}
	return notFoundOr(m.ForgetExchange(ctx, eid), "exchange")
}

func notFoundOr(err error, what string) error {
	if err == memory.ErrNotFound {
		return notFound(what)
	}
	return err
}
