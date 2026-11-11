package memory

import (
	"context"
	"errors"
	"strings"
	"unicode/utf8"

	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

// NothingMatches is what an empty search says, so the model can say so too.
const NothingMatches = "nothing in memory matches"

// SearchParams is the memory_search input.
type SearchParams struct {
	Query  string   `json:"query"`
	In     []string `json:"in"`
	After  string   `json:"after"`
	Before string   `json:"before"`
	Limit  int      `json:"limit"`
}

// Hit is one result.
type Hit struct {
	Kind       string `json:"kind"`
	ID         string `json:"id"`
	Title      string `json:"title"`
	Snippet    string `json:"snippet"`
	Date       string `json:"date"`
	Superseded bool   `json:"superseded,omitempty"`
	// MessageID is the message a fact came from (recall it for the exact words).
	MessageID int64 `json:"message_id,omitempty"`
	// TaskID is the task a fact or task hit belongs to.
	TaskID string `json:"task_id,omitempty"`
}

// SearchResult is the answer: hits, or the explicit statement that none match.
type SearchResult struct {
	Hits    []Hit  `json:"hits"`
	Message string `json:"message,omitempty"`
}

var kinds = map[string]string{
	"tasks": projectstore.DocTask, "facts": projectstore.DocFact, "files": projectstore.DocFile, "messages": projectstore.DocMessage,
}

// Search runs memory_search. The query is redacted like everything else, so a
// pasted secret finds nothing and is not echoed.
func (s *Service) Search(ctx context.Context, p SearchParams) (SearchResult, error) {
	q := projectstore.SearchQuery{Text: s.redact(p.Query), After: p.After, Before: p.Before, Limit: p.Limit}
	if len(projectstore.Terms(q.Text)) == 0 {
		return SearchResult{}, bad("query is required")
	}
	for _, k := range p.In {
		kk, ok := kinds[k]
		if !ok {
			return SearchResult{}, bad("in takes tasks, facts, files, messages")
		}
		q.Kinds = append(q.Kinds, kk)
	}
	hits, err := s.DB.Search(ctx, q)
	if err != nil {
		return SearchResult{}, err
	}
	out := SearchResult{Hits: []Hit{}}
	terms := projectstore.Terms(q.Text)
	for _, h := range hits {
		out.Hits = append(out.Hits, Hit{
			Kind: h.Kind, ID: h.Ref, Title: clip(h.Title, 120), Snippet: snippet(h.Body, terms), Date: h.Date,
			Superseded: h.Superseded, MessageID: h.MessageID, TaskID: h.TaskID,
		})
	}
	if len(out.Hits) == 0 {
		out.Message = NothingMatches
	}
	return out, nil
}

// snippet cuts at most SnippetLen characters around the first term that occurs.
func snippet(body string, terms []string) string {
	body = strings.Join(strings.Fields(body), " ")
	lower := strings.ToLower(body)
	at := -1
	for _, t := range terms {
		for _, cand := range []string{t, projectstore.Stem(t)} {
			if i := strings.Index(lower, cand); i >= 0 && (at < 0 || i < at) {
				at = i
			}
		}
	}
	start := 0
	if at > SnippetLen/3 {
		start = at - SnippetLen/3
	}
	r := []rune(body)
	// start is a byte offset in lower; convert via rune count of the prefix.
	if start > 0 {
		start = utf8.RuneCountInString(body[:min(start, len(body))])
	}
	end := min(start+SnippetLen, len(r))
	s := string(r[start:end])
	if start > 0 {
		s = "…" + s
	}
	if end < len(r) {
		s += "…"
	}
	return s
}

// Recalled is a message returned verbatim.
type Recalled struct {
	ID        int64  `json:"id"`
	Role      string `json:"role"`
	AgentID   string `json:"agent_id"`
	Date      string `json:"date"`
	Text      string `json:"text"`
	Truncated bool   `json:"truncated"`
}

// Recall returns one message's text exactly as stored, cut at MaxRecall bytes
// (at a character boundary) with truncated set.
func (s *Service) Recall(ctx context.Context, id int64) (Recalled, error) {
	text, role, agent, created, err := s.DB.MessageText(ctx, id)
	if errors.Is(err, projectstore.ErrNotFound) {
		return Recalled{}, bad("there is no message %d", id)
	}
	if err != nil {
		return Recalled{}, err
	}
	r := Recalled{ID: id, Role: role, AgentID: agent, Date: created, Text: text}
	if len(text) > MaxRecall {
		cut := MaxRecall
		for cut > 0 && !utf8.RuneStart(text[cut]) {
			cut--
		}
		r.Text, r.Truncated = text[:cut], true
	}
	return r, nil
}
