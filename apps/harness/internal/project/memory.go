package project

import (
	"context"
	"errors"
	"strconv"
	"strings"

	"github.com/ndolinschi/Octo/apps/harness/internal/memory"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

func (s *Service) mem(ctx context.Context, pid string) (*memory.Service, error) {
	if _, err := s.db(ctx, pid); err != nil {
		return nil, err
	}
	return s.turns.Memory(ctx, pid)
}

func memErr(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, memory.ErrNotFound):
		return notFound("memory file")
	case errors.Is(err, memory.ErrInvalid):
		return invalid("%s", err.Error())
	}
	return err
}

// Tasks lists the project's task records, newest update first.
func (s *Service) Tasks(ctx context.Context, pid string) ([]projectstore.Task, error) {
	m, err := s.mem(ctx, pid)
	if err != nil {
		return nil, err
	}
	return m.Tasks(ctx)
}

// MemoryList is GET /memory: the files without content and the generated index.
type MemoryList struct {
	Files []projectstore.MemoryFile `json:"files"`
	Index string                    `json:"index"`
}

// MemoryFiles lists the memory files.
func (s *Service) MemoryFiles(ctx context.Context, pid string) (MemoryList, error) {
	m, err := s.mem(ctx, pid)
	if err != nil {
		return MemoryList{}, err
	}
	files, idx, err := m.Files(ctx)
	return MemoryList{Files: files, Index: idx}, memErr(err)
}

// MemoryFile returns one file with its content.
func (s *Service) MemoryFile(ctx context.Context, pid, name string) (projectstore.MemoryFile, error) {
	m, err := s.mem(ctx, pid)
	if err != nil {
		return projectstore.MemoryFile{}, err
	}
	f, err := m.ReadFile(ctx, name)
	return f, memErr(err)
}

// PutMemoryFile creates or replaces a file (the user's edit).
func (s *Service) PutMemoryFile(ctx context.Context, pid, name, content, summary string) (projectstore.MemoryFile, error) {
	m, err := s.mem(ctx, pid)
	if err != nil {
		return projectstore.MemoryFile{}, err
	}
	f, err := m.WriteFile(ctx, name, content, summary)
	return f, memErr(err)
}

// DeleteMemoryFile removes a file.
func (s *Service) DeleteMemoryFile(ctx context.Context, pid, name string) error {
	m, err := s.mem(ctx, pid)
	if err != nil {
		return err
	}
	return memErr(m.DeleteFile(ctx, name))
}

// SearchMemoryQuery is GET /memory/search as received.
type SearchMemoryQuery struct {
	Q, In, After, Before, Limit string
}

// SearchMemory runs memory_search.
func (s *Service) SearchMemory(ctx context.Context, pid string, q SearchMemoryQuery) (memory.SearchResult, error) {
	m, err := s.mem(ctx, pid)
	if err != nil {
		return memory.SearchResult{}, err
	}
	p := memory.SearchParams{Query: q.Q, After: q.After, Before: q.Before}
	for _, k := range strings.Split(q.In, ",") {
		if k = strings.TrimSpace(k); k != "" {
			p.In = append(p.In, k)
		}
	}
	if q.Limit != "" {
		n, err := strconv.Atoi(q.Limit)
		if err != nil || n < 1 {
			return memory.SearchResult{}, invalid("limit must be a positive integer")
		}
		p.Limit = n
	}
	res, err := m.Search(ctx, p)
	return res, memErr(err)
}
