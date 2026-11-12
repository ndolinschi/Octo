package memory

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

var t0 = time.Date(2026, 11, 12, 9, 0, 0, 0, time.UTC)

func (r *rig) exchange(turn int64, at time.Time, req, ans, status string) projectstore.Exchange {
	r.t.Helper()
	e, err := r.svc.RecordExchange(context.Background(), ExchangeInput{
		TurnID: turn, MessageID: turn + 1, Request: req, Answer: ans, Status: status, StartedAt: at, Duration: 2 * time.Second,
		Model: "m", Files: []string{"a.go"}, Agents: []string{"worker"}, Tokens: projectstore.Tokens{Input: 10, Output: 5},
	})
	if err != nil {
		r.t.Fatal(err)
	}
	return e
}

func TestExchangeIsWrittenOncePerTurnAndKeepsTheTextsWhole(t *testing.T) {
	r := newRig(t)
	long := strings.Repeat("я", 40<<10) // 80 KiB in bytes
	a := r.exchange(1, t0, "Сделай калькулятор\nвторая строка", "ответ", projectstore.ExchangeFailed)
	b := r.exchange(1, t0, "Сделай калькулятор\nвторая строка", long, projectstore.ExchangeCompleted) // the retry
	if a.ID != b.ID || a.SessionID != b.SessionID {
		t.Fatalf("a retried turn must replace its record: %q %q", a.ID, b.ID)
	}
	d, err := r.svc.Session(context.Background(), b.SessionID)
	if err != nil || len(d.Exchanges) != 1 {
		t.Fatalf("session = %+v %v", d, err)
	}
	got := d.Exchanges[0]
	if got.Status != "completed" || !got.AnswerTruncated || !strings.HasSuffix(got.Answer, projectstore.AnswerMarker) || len(got.Answer) > projectstore.MaxAnswerBytes+100 {
		t.Fatalf("answer cap: truncated=%v len=%d status=%s", got.AnswerTruncated, len(got.Answer), got.Status)
	}
	if got.Request != "Сделай калькулятор\nвторая строка" || d.Session.Title != "Сделай калькулятор" || got.DurationMS != 2000 ||
		got.Files[0] != "a.go" || got.Agents[0] != "worker" || got.Tokens.Output != 5 || got.MessageID != 2 {
		t.Fatalf("exchange = %+v session = %+v", got, d.Session)
	}
}

func TestFailedAndStoppedTurnsAreRecorded(t *testing.T) {
	r := newRig(t)
	r.exchange(1, t0, "one", "", projectstore.ExchangeFailed)
	e := r.exchange(5, t0.Add(time.Minute), "two", "half an answ", projectstore.ExchangeStopped)
	d, _ := r.svc.Session(context.Background(), e.SessionID)
	if len(d.Exchanges) != 2 || d.Exchanges[0].Status != "failed" || d.Exchanges[1].Status != "stopped" || d.Session.Exchanges != 2 {
		t.Fatalf("%+v", d)
	}
}

func TestSessionBoundaries(t *testing.T) {
	r := newRig(t)
	ctx := context.Background()
	a := r.exchange(1, t0, "first", "x", "completed")
	b := r.exchange(3, t0.Add(5*time.Hour), "five hours later", "x", "completed") // within 6 h of the end of the last
	if a.SessionID != b.SessionID {
		t.Fatal("5 h of quiet must not start a session")
	}
	c := r.exchange(5, t0.Add(5*time.Hour+7*time.Hour), "seven hours later", "x", "completed")
	if c.SessionID == b.SessionID {
		t.Fatal("more than 6 h of quiet must start a session")
	}
	if _, err := r.svc.StartSession(ctx, "clear"); err != nil {
		t.Fatal(err)
	}
	d := r.exchange(7, t0.Add(13*time.Hour), "after clear", "x", "completed")
	if d.SessionID == c.SessionID {
		t.Fatal("/clear must start a session")
	}
	list, _ := r.svc.Sessions(ctx, 10, "")
	if len(list) != 3 || list[0].ID != d.SessionID || !list[0].Open || list[1].Open || list[1].Reason != "clear" || list[2].Exchanges != 2 || list[2].Title != "first" {
		t.Fatalf("sessions = %+v", list)
	}
	// Closing twice, or with nothing open, is harmless.
	if _, err := r.svc.StartSession(ctx, "clear"); err != nil {
		t.Fatal(err)
	}
	if _, err := r.svc.StartSession(ctx, "clear"); err != nil {
		t.Fatal(err)
	}
}

func TestPreviousSessionPointerAndRecall(t *testing.T) {
	r := newRig(t)
	ctx := context.Background()
	now := t0
	r.svc.Now = func() time.Time { return now }
	if r.svc.PreviousSessionPointer(ctx) != "" {
		t.Fatal("no pointer without an earlier session")
	}
	e := r.exchange(1, t0, "Plan the release", "Release plan: tag, build, announce", "completed")
	now = t0.Add(time.Hour)
	if r.svc.PreviousSessionPointer(ctx) != "" {
		t.Fatal("the current session is not its own previous one")
	}
	now = t0.Add(10 * time.Hour) // the next request opens a new session
	p := r.svc.PreviousSessionPointer(ctx)
	if strings.Count(p, "\n") != 3 || !strings.Contains(p, "Plan the release") || !strings.Contains(p, e.SessionID) || strings.Contains(p, "tag, build") {
		t.Fatalf("pointer = %q", p)
	}
	rs, err := r.svc.RecallSession(ctx, e.SessionID)
	if err != nil || len(rs.Exchanges) != 1 || rs.Exchanges[0].ID != e.ID {
		t.Fatalf("session recall = %+v %v", rs, err)
	}
	re, err := r.svc.RecallExchange(ctx, e.ID)
	if err != nil || re.Answer != "Release plan: tag, build, announce" || re.Request != "Plan the release" {
		t.Fatalf("exchange recall = %+v %v", re, err)
	}
	if _, err := r.svc.RecallExchange(ctx, "exc_nope"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("unknown exchange = %v", err)
	}
}

func TestSearchFindsExchangesIncludingRussianAndForgetRemovesThem(t *testing.T) {
	r := newRig(t)
	ctx := context.Background()
	m := r.say("user", "Напиши калькулятор со скобками")
	r.say("assistant", "Готово: калькулятор поддерживает скобки")
	e := r.exchange(m.ID, t0, "Напиши калькулятор со скобками", "Готово: калькулятор поддерживает скобки", "completed")
	res, err := r.svc.Search(ctx, SearchParams{Query: "калькуляторами"})
	if err != nil || len(res.Hits) == 0 {
		t.Fatalf("stemmed search = %+v %v", res, err)
	}
	var hit *Hit
	for i, h := range res.Hits {
		if h.Kind == "exchange" {
			hit = &res.Hits[i]
		}
		if h.Kind == "message" {
			t.Fatalf("a message an exchange hit shows must not be listed twice: %+v", res.Hits)
		}
	}
	if hit == nil || hit.ID != e.ID || hit.SessionID != e.SessionID {
		t.Fatalf("hits = %+v", res.Hits)
	}
	only, _ := r.svc.Search(ctx, SearchParams{Query: "калькулятор", In: []string{"exchanges"}})
	if len(only.Hits) != 1 {
		t.Fatalf("in=exchanges = %+v", only)
	}
	if err := r.svc.ForgetExchange(ctx, e.ID); err != nil {
		t.Fatal(err)
	}
	if err := r.svc.ForgetExchange(ctx, "exc_nope"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("forget unknown = %v", err)
	}
	after, _ := r.svc.Search(ctx, SearchParams{Query: "калькулятор", In: []string{"exchanges"}})
	if len(after.Hits) != 0 {
		t.Fatalf("a forgotten exchange is still found: %+v", after)
	}
	d, _ := r.svc.Session(ctx, e.SessionID)
	if len(d.Exchanges) != 1 || !d.Exchanges[0].Removed || d.Exchanges[0].Request != "" || d.Exchanges[0].Answer != "" || d.Session.Exchanges != 0 {
		t.Fatalf("marker = %+v", d)
	}
	// Recording the same turn again does not bring it back.
	r.exchange(m.ID, t0, "Напиши калькулятор со скобками", "again", "completed")
	d, _ = r.svc.Session(ctx, e.SessionID)
	if !d.Exchanges[0].Removed || d.Exchanges[0].Answer != "" {
		t.Fatalf("resurrected: %+v", d.Exchanges[0])
	}
	raw, _ := r.db.DumpForTest(ctx, "search_docs")
	if strings.Contains(raw, "exc_") {
		t.Fatalf("search_docs still holds the exchange: %s", raw)
	}
}

func TestExchangeSecretsAreRedactedEverywhere(t *testing.T) {
	r := newRig(t)
	ctx := context.Background()
	e := r.exchange(1, t0, "use key "+secretValue+" please", "I saw "+secretValue, "completed")
	if strings.Contains(e.Request+e.Answer, secretValue) {
		t.Fatalf("exchange = %+v", e)
	}
	for _, table := range []string{"exchanges", "sessions", "search_docs", "search_u", "search_t", "search_s"} {
		dump, err := r.db.DumpForTest(ctx, table)
		if err != nil || strings.Contains(dump, secretValue) {
			t.Fatalf("%s holds the secret (err %v)", table, err)
		}
	}
	res, _ := r.svc.Search(ctx, SearchParams{Query: secretValue})
	b, _ := json.Marshal(res)
	if strings.Contains(string(b), secretValue) {
		t.Fatal("search echoes the secret")
	}
}
