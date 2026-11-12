package project

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"

	"github.com/ndolinschi/Octo/apps/harness/internal/memory"
	"github.com/ndolinschi/Octo/apps/harness/internal/orchestrator"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

// Compact summarises the orchestrator's conversation now (a manual compaction).
func (s *Service) Compact(ctx context.Context, pid string) (orchestrator.CompactResult, error) {
	if _, err := s.db(ctx, pid); err != nil {
		return orchestrator.CompactResult{}, err
	}
	res, err := s.turns.Compact(ctx, pid)
	switch {
	case errors.Is(err, orchestrator.ErrTurnInProgress):
		return res, turnInProgress("a turn is running for this project; compact when it ends")
	case errors.Is(err, orchestrator.ErrNothingToCompact):
		return res, &Error{Kind: KindConflict, Code: "nothing_to_compact", Message: "the conversation has nothing a summary would replace yet"}
	case errors.Is(err, orchestrator.ErrCompactUnsupported):
		return res, &Error{Kind: KindConflict, Code: "compact_unsupported", Message: err.Error()}
	case orchestrator.IsNoBuiltinLoop(err):
		return res, &Error{Kind: KindConflict, Code: "builtin_loop_unavailable", Message: err.Error()}
	}
	return res, err
}

// ExportMarkdown renders the orchestrator's conversation as Markdown: each request a
// heading, the answer text, tool calls as one line each (name, what it was about,
// the start of the result), the places where the history was compacted. Messages
// hidden by a rewind are not part of it. Stored secrets are replaced by their
// redaction marker.
func (s *Service) ExportMarkdown(ctx context.Context, pid string) (name, md string, err error) {
	db, err := s.db(ctx, pid)
	if err != nil {
		return "", "", err
	}
	info, err := db.Info(ctx)
	if err != nil {
		return "", "", err
	}
	orch, err := db.Orchestrator(ctx)
	if err != nil {
		return "", "", err
	}
	msgs, err := db.Messages(ctx, orch.ID)
	if err != nil {
		return "", "", err
	}
	comps, err := db.Compactions(ctx, orch.ID)
	if err != nil {
		return "", "", err
	}
	results := map[string]projectstore.ContentBlock{}
	for _, m := range msgs {
		for _, b := range m.Content {
			if b.Type == "tool_result" && b.ToolUseID != nil {
				results[*b.ToolUseID] = b
			}
		}
	}
	var b strings.Builder
	fmt.Fprintf(&b, "# %s\n\n_Conversation exported %s. Tool calls are one line each; stored secrets are redacted._\n", info.Name, s.now().UTC().Format("2006-01-02 15:04 UTC"))
	n, answered := 0, false
	next := 0 // next compaction marker to place
	for _, m := range msgs {
		for next < len(comps) && comps[next].UptoMessageID < m.ID {
			fmt.Fprintf(&b, "\n> History compacted%s (%s)\n", manualNote(comps[next]), comps[next].CreatedAt)
			next++
		}
		switch m.Role {
		case "user":
			var text string
			for _, c := range m.Content {
				if c.Type == "text" && c.Text != nil {
					text += *c.Text + "\n"
				}
			}
			if strings.TrimSpace(text) == "" {
				continue
			}
			n++
			answered = false
			fmt.Fprintf(&b, "\n## Request %d · %s\n\n%s", n, m.CreatedAt, strings.TrimRight(text, "\n")+"\n")
		case "assistant":
			for _, c := range m.Content {
				switch c.Type {
				case "text":
					if c.Text == nil || strings.TrimSpace(*c.Text) == "" {
						continue
					}
					if !answered {
						b.WriteString("\n### Answer\n")
						answered = true
					}
					b.WriteString("\n" + strings.TrimRight(*c.Text, "\n") + "\n")
				case "tool_use":
					if c.Name == nil {
						continue
					}
					var r *projectstore.ContentBlock
					if c.ID != nil {
						if x, ok := results[*c.ID]; ok {
							r = &x
						}
					}
					b.WriteString("\n" + toolLine(*c.Name, c.Input, r))
				}
			}
		}
	}
	for ; next < len(comps); next++ {
		fmt.Fprintf(&b, "\n> History compacted%s (%s)\n", manualNote(comps[next]), comps[next].CreatedAt)
	}
	md = s.turns.Redact(pid, b.String())
	slug := strings.Map(func(r rune) rune {
		if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' {
			return r
		}
		if r >= 'A' && r <= 'Z' {
			return r + 32
		}
		return '-'
	}, info.Name)
	return strings.Trim(slug, "-") + ".md", md, nil
}

func manualNote(c projectstore.Compaction) string {
	if c.Manual {
		return fmt.Sprintf(" on request, %d messages summarised", c.MessageCount)
	}
	return ""
}

// toolLine is one line for a tool call: name, what it was about, how it ended.
func toolLine(name string, input json.RawMessage, r *projectstore.ContentBlock) string {
	var in map[string]any
	_ = json.Unmarshal(input, &in)
	key := ""
	for _, k := range []string{"title", "command", "path", "pattern", "query", "url", "task"} {
		if v, ok := in[k].(string); ok && v != "" {
			key = " `" + oneLine(v, 80) + "`"
			break
		}
	}
	res := ""
	if r != nil {
		state := "ok"
		if r.IsError != nil && *r.IsError {
			state = "error"
		}
		res = " → " + state
		if r.Content != nil {
			if t := oneLine(*r.Content, 100); t != "" {
				res += ": " + t
			}
		}
	}
	return "- `" + name + "`" + key + res + "\n"
}

func oneLine(s string, n int) string {
	s = strings.Join(strings.Fields(s), " ")
	if r := []rune(s); len(r) > n {
		return string(r[:n]) + "…"
	}
	return s
}

// SearchHit is one past request found for the palette.
type SearchHit struct {
	ProjectID   string `json:"project_id"`
	ProjectName string `json:"project_name"`
	MessageID   int64  `json:"message_id"`
	Snippet     string `json:"snippet"`
	Date        string `json:"date"`
}

// MaxSearchResults is the most results one search returns.
const MaxSearchResults = 50

// SearchRequests finds past user requests of every project (the orchestrator's
// user messages, not sub-agent tasks) with the memory search index: exact words
// first, then substrings and stems. Newest first within the same rank.
func (s *Service) SearchRequests(ctx context.Context, q string, limit int) ([]SearchHit, error) {
	if len(projectstore.Terms(q)) == 0 {
		return nil, invalid("q is required")
	}
	if limit < 1 || limit > MaxSearchResults {
		limit = 20
	}
	ids, err := s.store.IDs(ctx)
	if err != nil {
		return nil, err
	}
	type ranked struct {
		hit   SearchHit
		exact bool
	}
	var all []ranked
	terms := projectstore.Terms(q)
	for _, id := range ids {
		db, err := s.store.Get(ctx, id)
		if err != nil {
			continue
		}
		red := q
		if s.turns != nil {
			red = s.turns.Redact(id, q)
		}
		hits, err := db.Search(ctx, projectstore.SearchQuery{Text: red, Kinds: []string{projectstore.DocMessage}, Limit: MaxSearchResults})
		if err != nil || len(hits) == 0 {
			continue
		}
		info, err := db.Info(ctx)
		if err != nil {
			continue
		}
		orch, err := db.Orchestrator(ctx)
		if err != nil {
			continue
		}
		for _, h := range hits {
			if h.Title != "user" {
				continue
			}
			if _, _, agentID, _, err := db.MessageText(ctx, h.MessageID); err != nil || agentID != orch.ID {
				continue
			}
			all = append(all, ranked{SearchHit{ProjectID: id, ProjectName: info.Name, MessageID: h.MessageID, Snippet: memory.Snippet(h.Body, terms), Date: h.Date}, h.Exact})
		}
	}
	slices.SortStableFunc(all, func(a, b ranked) int {
		if a.exact != b.exact {
			if a.exact {
				return -1
			}
			return 1
		}
		return strings.Compare(b.hit.Date, a.hit.Date)
	})
	out := make([]SearchHit, 0, min(len(all), limit))
	for _, r := range all {
		if len(out) == limit {
			break
		}
		out = append(out, r.hit)
	}
	return out, nil
}
