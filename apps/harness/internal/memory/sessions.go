package memory

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

// ExchangeInput is a finished turn as the orchestrator hands it over.
type ExchangeInput struct {
	TurnID, MessageID int64
	Request, Answer   string
	Status            string
	StartedAt         time.Time
	Duration          time.Duration
	Model             string
	Files, Agents     []string
	Tokens            projectstore.Tokens
	CostUSD           *float64
	TaskID            string
	// Interrupted: the harness stopped while the turn ran (Status is failed).
	Interrupted bool
	// Error is why a failed turn failed (nil otherwise); its texts are redacted here.
	Error *projectstore.ExchangeError
}

func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

// RecordExchange stores the request and the answer of a finished turn (M4):
// redacted, the answer cut at 64 KiB with a marker. It is idempotent per turn.
func (s *Service) RecordExchange(ctx context.Context, in ExchangeInput) (projectstore.Exchange, error) {
	if in.TurnID == 0 {
		return projectstore.Exchange{}, bad("an exchange needs the turn's message id")
	}
	answer, cut := projectstore.CapAnswer(s.redact(in.Answer))
	e := projectstore.Exchange{
		TurnID: in.TurnID, MessageID: in.MessageID, Request: s.redact(in.Request), Answer: answer, AnswerTruncated: cut,
		Status: in.Status, StartedAt: projectstore.Stamp(in.StartedAt), DurationMS: in.Duration.Milliseconds(), Model: in.Model,
		Files: cleanFiles(in.Files), Agents: cleanList(in.Agents, 120), Tokens: in.Tokens, CostUSD: in.CostUSD, TaskID: in.TaskID,
		Interrupted: in.Interrupted,
	}
	if in.Error != nil {
		e.Error = &projectstore.ExchangeError{Code: in.Error.Code, Message: s.redact(in.Error.Message), Hint: s.redact(in.Error.Hint)}
	}
	e, sess, err := s.DB.RecordExchange(ctx, e, projectstore.SessionGap)
	if err == nil {
		s.publish("memory.updated", map[string]any{"session_id": sess.ID, "exchange_id": e.ID})
	}
	return e, err
}

func cleanFiles(in []string) []string {
	out := cleanList(in, 300)
	if len(out) > MaxItems {
		out = out[:MaxItems]
	}
	return out
}

// Boundary is what a session boundary answers: the session that ended ("" when the project had none) and the
// empty one the next request joins.
type Boundary struct {
	PreviousID string
	SessionID  string
}

// Carry is what a /clear carries over: the summary written for the session that ends and who wrote it
// ("model", "agent" or "stored"). It is kept on that session's record.
type Carry struct {
	Summary, Source string
}

// StartSession ends the current session: the next request opens a new one, which exists (empty, not listed
// until its first request) so a boundary can name it. reason is "clear" (the /clear command, with its Carry)
// or "rewind". Idempotent: with an empty session already open it does nothing.
func (s *Service) StartSession(ctx context.Context, reason string, carry ...Carry) (Boundary, error) {
	return s.StartSessionFrom(ctx, "", reason, carry...)
}

// StartSessionFrom is StartSession for one main session ("": the default): that session ends and a new one with
// its own root agent follows it (the default when the ended one was).
func (s *Service) StartSessionFrom(ctx context.Context, from, reason string, carry ...Carry) (Boundary, error) {
	var c Carry
	if len(carry) > 0 {
		c = carry[0]
	}
	prev, cur, err := s.DB.StartNewSessionFrom(ctx, from, reason, s.redact(c.Summary), c.Source, s.now())
	if err != nil {
		return Boundary{}, err
	}
	s.publish("memory.updated", map[string]any{"session_boundary": reason, "session_id": cur, "previous_session_id": prev})
	return Boundary{PreviousID: prev, SessionID: cur}, nil
}

// Sessions lists the sessions, newest first; before is a started_at to page from.
func (s *Service) Sessions(ctx context.Context, limit int, before string) ([]projectstore.Session, error) {
	return s.DB.Sessions(ctx, limit, before)
}

// SessionDetail is one session with its exchanges.
type SessionDetail struct {
	Session   projectstore.Session    `json:"session"`
	Exchanges []projectstore.Exchange `json:"exchanges"`
}

// Session returns a session and its exchanges.
func (s *Service) Session(ctx context.Context, id string) (SessionDetail, error) {
	se, ex, err := s.DB.SessionOf(ctx, id)
	if errors.Is(err, projectstore.ErrNotFound) {
		return SessionDetail{}, ErrNotFound
	}
	return SessionDetail{Session: se, Exchanges: ex}, err
}

// ForgetExchange deletes one exchange (texts and search entries); a marker stays in its session.
func (s *Service) ForgetExchange(ctx context.Context, id string) error {
	sid, err := s.DB.ForgetExchange(ctx, id)
	if errors.Is(err, projectstore.ErrNotFound) {
		return ErrNotFound
	}
	if err == nil {
		s.publish("memory.updated", map[string]any{"session_id": sid, "exchange_id": id, "deleted": true})
	}
	return err
}

// CurrentAndPrevious says which session the next request belongs to: the
// latest one while it is open and not quiet for longer than the gap, else a new
// one (current is nil), and the session before it that holds an exchange.
func (s *Service) CurrentAndPrevious(ctx context.Context) (current, previous *projectstore.Session, err error) {
	list, err := s.DB.Sessions(ctx, 1, "")
	if err != nil || len(list) == 0 {
		return nil, nil, err
	}
	latest := list[0]
	cur := latest.Open && s.now().Sub(parseTime(latest.EndedAt)) <= projectstore.SessionGap
	skip := ""
	if cur {
		current, skip = &latest, latest.ID
	}
	p, err := s.DB.PreviousSession(ctx, skip)
	if errors.Is(err, projectstore.ErrNotFound) {
		return current, nil, nil
	}
	if err != nil {
		return current, nil, err
	}
	return current, &p, nil
}

func parseTime(v string) time.Time {
	t, _ := time.Parse(time.RFC3339Nano, v)
	return t
}

// PreviousSessionPointer is the three-line note the context carries about the
// session before the current one (title, date, how to recall it), "" when
// there is none. It names the session, not its text.
func (s *Service) PreviousSessionPointer(ctx context.Context) string {
	_, prev, err := s.CurrentAndPrevious(ctx)
	if err != nil || prev == nil {
		return ""
	}
	return fmt.Sprintf("Previous session: %q, %s, %d exchanges (id %s).\n"+
		"Its requests and answers are stored word for word; they are not shown here.\n"+
		"To read it: memory_search, or recall_message with session_id %q (exchange_id for one exchange).\n",
		prev.Title, prev.StartedAt[:min(10, len(prev.StartedAt))], prev.Exchanges, prev.ID, prev.ID)
}

// RecalledExchange is recall_message with exchange_id: both texts as stored.
type RecalledExchange struct {
	ID              string `json:"id"`
	SessionID       string `json:"session_id"`
	Date            string `json:"date"`
	Status          string `json:"status"`
	Request         string `json:"request"`
	Answer          string `json:"answer"`
	Truncated       bool   `json:"truncated"`
	TurnID          int64  `json:"turn_id"`
	AnswerMessageID int64  `json:"answer_message_id,omitempty"`
}

func cutBytes(text string) (string, bool) {
	if len(text) <= MaxRecall {
		return text, false
	}
	cut := MaxRecall
	for cut > 0 && !utf8.RuneStart(text[cut]) {
		cut--
	}
	return text[:cut], true
}

// RecallExchange returns one exchange's request and answer, each cut at 8 kB.
func (s *Service) RecallExchange(ctx context.Context, id string) (RecalledExchange, error) {
	e, err := s.DB.ExchangeByID(ctx, id)
	if errors.Is(err, projectstore.ErrNotFound) {
		return RecalledExchange{}, bad("there is no exchange %s", id)
	}
	if err != nil {
		return RecalledExchange{}, err
	}
	if e.Removed {
		return RecalledExchange{}, bad("exchange %s was forgotten", id)
	}
	r := RecalledExchange{ID: e.ID, SessionID: e.SessionID, Date: e.StartedAt, Status: e.Status, TurnID: e.TurnID, AnswerMessageID: e.MessageID}
	var a, b bool
	r.Request, a = cutBytes(e.Request)
	r.Answer, b = cutBytes(e.Answer)
	r.Truncated = a || b
	return r, nil
}

// RecalledSession is recall_message with session_id: the exchanges as short lines.
type RecalledSession struct {
	ID        string               `json:"id"`
	Title     string               `json:"title"`
	StartedAt string               `json:"started_at"`
	Exchanges []SessionExchLine    `json:"exchanges"`
	Note      string               `json:"note"`
	Session   projectstore.Session `json:"-"`
}

// SessionExchLine is one exchange of a recalled session, shortened.
type SessionExchLine struct {
	ID      string `json:"id"`
	Date    string `json:"date"`
	Status  string `json:"status"`
	Request string `json:"request"`
	Answer  string `json:"answer"`
}

// RecallSession lists a session's exchanges (the first 40), request and answer
// shortened; exchange_id returns one in full.
func (s *Service) RecallSession(ctx context.Context, id string) (RecalledSession, error) {
	d, err := s.Session(ctx, id)
	if errors.Is(err, ErrNotFound) {
		return RecalledSession{}, bad("there is no session %s", id)
	}
	if err != nil {
		return RecalledSession{}, err
	}
	r := RecalledSession{ID: id, Title: d.Session.Title, StartedAt: d.Session.StartedAt, Exchanges: []SessionExchLine{},
		Note: "texts are shortened; recall_message with exchange_id returns one exchange in full"}
	for _, e := range d.Exchanges {
		if e.Removed {
			continue
		}
		if len(r.Exchanges) == 40 {
			r.Note += "; only the first 40 exchanges are listed"
			break
		}
		r.Exchanges = append(r.Exchanges, SessionExchLine{ID: e.ID, Date: e.StartedAt, Status: e.Status,
			Request: clip(strings.Join(strings.Fields(e.Request), " "), 200), Answer: clip(strings.Join(strings.Fields(e.Answer), " "), 300)})
	}
	return r, nil
}
