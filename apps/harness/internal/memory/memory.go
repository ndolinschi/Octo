// Package memory is the orchestrator's long-term memory of a project (M1):
// task records, memory files, lexical search over both and over every message,
// and verbatim recall of one message. It sits between the database
// (projectstore) and the tools, the API and the post-turn digest, and applies
// the limits and the secret redaction that all of them share.
package memory

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"

	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

// Limits (documented in docs/memory.md).
const (
	MaxTitle      = 120
	MaxGoal       = 1000
	MaxOutcome    = 2000
	MaxItem       = 500
	MaxItems      = 50
	MaxFacts      = 200
	MaxFileName   = 80
	MaxFileBytes  = 64 << 10
	MaxFiles      = 500
	MaxSummary    = 200
	SnippetLen    = 300
	MaxRecall     = 8 << 10
	GoalFallback  = 400
	IndexFileName = "INDEX.md"
)

// Errors a caller shows to the user or the model as they are.
var (
	ErrInvalid  = errors.New("memory: invalid request")
	ErrNotFound = errors.New("memory: not found")
)

// Invalid wraps a message that says what to fix.
type invalidError struct{ msg string }

func (e *invalidError) Error() string        { return e.msg }
func (e *invalidError) Is(target error) bool { return target == ErrInvalid }

func bad(format string, a ...any) error { return &invalidError{fmt.Sprintf(format, a...)} }

// Service is one project's memory. All methods are safe for concurrent use; a
// project has one Service so that its read-modify-write cycles never overlap.
type Service struct {
	DB *projectstore.DB
	// Redact removes secret values from text before it is stored or indexed.
	Redact func(string) string
	// Publish announces events (task.updated, memory.updated); may be nil.
	Publish func(typ string, fields map[string]any)

	mu sync.Mutex
}

func (s *Service) redact(v string) string {
	if s.Redact == nil {
		return v
	}
	return s.Redact(v)
}

func (s *Service) publish(typ string, fields map[string]any) {
	if s.Publish != nil {
		s.Publish(typ, fields)
	}
}

func clip(v string, n int) string {
	if r := []rune(v); len(r) > n {
		return string(r[:n])
	}
	return v
}

func cleanList(in []string, itemMax int) []string {
	var out []string
	for _, v := range in {
		if v = strings.TrimSpace(v); v != "" {
			out = append(out, clip(v, itemMax))
		}
	}
	return out
}

// addUnique appends the new items that are not there yet (case-insensitive).
func addUnique(dst []string, add []string, max int) ([]string, error) {
	for _, a := range add {
		dup := false
		for _, d := range dst {
			if strings.EqualFold(strings.TrimSpace(d), strings.TrimSpace(a)) {
				dup = true
				break
			}
		}
		if !dup {
			if len(dst) >= max {
				return dst, bad("a task record holds at most %d items per list", max)
			}
			dst = append(dst, a)
		}
	}
	return dst, nil
}

// OpenTask opens the task record for a user request: its title and goal come
// from the request (the goal is the first 400 characters: the fallback when no
// side model digests the turn) and it holds the message.
func (s *Service) OpenTask(ctx context.Context, text string, messageID int64) (projectstore.Task, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	text = strings.TrimSpace(s.redact(text))
	title := strings.Join(strings.Fields(text), " ")
	t := projectstore.Task{
		Title: clip(title, 80), Status: projectstore.TaskOpen, Goal: clip(text, GoalFallback), GoalBy: "harness", Auto: true,
		MessageIDs: []int64{messageID},
	}
	if t.Title == "" {
		t.Title = "Request"
	}
	t, err := s.DB.CreateTask(ctx, t)
	if err == nil {
		s.publish("task.updated", map[string]any{"task": t})
	}
	return t, err
}

// Tasks lists the task records, newest update first.
func (s *Service) Tasks(ctx context.Context) ([]projectstore.Task, error) { return s.DB.Tasks(ctx) }
