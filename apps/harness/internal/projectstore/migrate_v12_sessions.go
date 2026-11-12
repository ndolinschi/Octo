package projectstore

import (
	"context"
	"fmt"
	"strings"
	"time"
)

// Schema 12 (memory M4) adds sessions and their exchanges: one record per
// finished orchestrator turn with the request and the final answer. It is its
// own file and function so the version number can be renumbered when
// migrations from parallel work are merged. Every statement is idempotent; a
// database that predates it is back-filled from its stored messages.
const sessionsSchemaVersion = 12

// SessionGap is how long a conversation may be quiet before the next request
// starts a new session.
const SessionGap = 6 * time.Hour

const sessionsSchema = `
CREATE TABLE IF NOT EXISTS sessions (
	id TEXT PRIMARY KEY,
	title TEXT NOT NULL DEFAULT '',
	started_at TEXT NOT NULL,
	ended_at TEXT NOT NULL,
	closed INTEGER NOT NULL DEFAULT 0,
	reason TEXT NOT NULL DEFAULT '',
	summary TEXT NOT NULL DEFAULT '',
	summary_source TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS sessions_started ON sessions (started_at);
CREATE TABLE IF NOT EXISTS exchanges (
	id TEXT PRIMARY KEY,
	session_id TEXT NOT NULL,
	turn_id INTEGER NOT NULL UNIQUE,
	message_id INTEGER NOT NULL DEFAULT 0,
	request TEXT NOT NULL DEFAULT '',
	answer TEXT NOT NULL DEFAULT '',
	answer_truncated INTEGER NOT NULL DEFAULT 0,
	status TEXT NOT NULL,
	started_at TEXT NOT NULL,
	duration_ms INTEGER NOT NULL DEFAULT 0,
	model TEXT NOT NULL DEFAULT '',
	files_json TEXT NOT NULL DEFAULT '[]',
	agents_json TEXT NOT NULL DEFAULT '[]',
	input_tokens INTEGER NOT NULL DEFAULT 0,
	output_tokens INTEGER NOT NULL DEFAULT 0,
	cost_usd REAL,
	task_id TEXT NOT NULL DEFAULT '',
	removed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS exchanges_session ON exchanges (session_id, started_at);
`

func (d *DB) migrateV12Sessions(ctx context.Context) error {
	if _, err := d.sql.ExecContext(ctx, sessionsSchema); err != nil {
		return fmt.Errorf("sessions schema (v%d): %w", sessionsSchemaVersion, err)
	}
	// The exchange code reads schema 13's columns, so they exist before any back-fill runs.
	if err := d.addSessionColumns(ctx); err != nil {
		return err
	}
	if v, err := userVersion(ctx, d.sql); err != nil {
		return err
	} else if v >= sessionsSchemaVersion {
		return nil
	}
	if err := d.backfillExchanges(ctx); err != nil {
		return fmt.Errorf("back-fill exchanges: %w", err)
	}
	return nil
}

type bfMsg struct {
	id            int64
	role, raw, at string
	stopped       bool
}

// backfillExchanges builds the exchanges of the orchestrator's stored
// messages: each user message with text starts one, the last assistant text up
// to the next such message is its answer. What was not kept (tokens, cost,
// sub-agents) stays empty; the model is the orchestrator's current one.
func (d *DB) backfillExchanges(ctx context.Context) error {
	var n int
	if err := d.sql.QueryRowContext(ctx, `SELECT COUNT(*) FROM exchanges`).Scan(&n); err != nil || n > 0 {
		return err
	}
	var orchID, model string
	if err := d.sql.QueryRowContext(ctx, `SELECT id, model FROM agents WHERE parent_id IS NULL ORDER BY rowid LIMIT 1`).Scan(&orchID, &model); err != nil {
		return nil // no orchestrator yet: nothing to back-fill
	}
	rows, err := d.sql.QueryContext(ctx, `SELECT id, role, content_json, created_at, stopped FROM messages
		WHERE agent_id = ? AND rewound_at IS NULL ORDER BY id`, orchID)
	if err != nil {
		return err
	}
	var msgs []bfMsg
	for rows.Next() {
		var m bfMsg
		if err := rows.Scan(&m.id, &m.role, &m.raw, &m.at, &m.stopped); err != nil {
			_ = rows.Close()
			return err
		}
		msgs = append(msgs, m)
	}
	if err := rows.Close(); err != nil {
		return err
	}
	taskOf := map[int64]string{}
	if ts, err := d.Tasks(ctx); err == nil {
		for _, t := range ts {
			for _, id := range t.MessageIDs {
				taskOf[id] = t.ID
			}
		}
	}
	filesOf := map[int64][]string{}
	if cs, err := d.Changes(ctx, 0); err == nil {
		for _, c := range cs {
			if fs := filesOf[c.TurnID]; len(fs) < 50 && !containsStr(fs, c.Path) {
				filesOf[c.TurnID] = append(fs, c.Path)
			}
		}
	}
	// A /clear (schema 9) ends a session: the first request after its boundary starts a new one, and the
	// session that ended keeps the clear's summary.
	type boundary struct {
		upto            int64
		summary, source string
	}
	var clears []boundary
	if crs, err := d.sql.QueryContext(ctx, `SELECT upto_message_id, summary, summary_source FROM compactions WHERE agent_id = ? AND cleared = 1 ORDER BY id`, orchID); err == nil {
		for crs.Next() {
			var b boundary
			if err := crs.Scan(&b.upto, &b.summary, &b.source); err == nil {
				clears = append(clears, b)
			}
		}
		_ = crs.Close()
	}
	tx, err := d.sql.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	var prevTurn int64
	for i := 0; i < len(msgs); i++ {
		m := msgs[i]
		req := strings.TrimSpace(messageText([]byte(m.raw)))
		if m.role != "user" || req == "" {
			continue
		}
		for _, b := range clears {
			if prevTurn != 0 && prevTurn <= b.upto && m.id > b.upto {
				if _, err := tx.ExecContext(ctx, `UPDATE sessions SET closed = 1, reason = 'clear', summary = ?, summary_source = ? WHERE closed = 0 AND id =
					(SELECT id FROM sessions ORDER BY started_at DESC, rowid DESC LIMIT 1)`, b.summary, b.source); err != nil {
					return err
				}
			}
		}
		prevTurn = m.id
		e := Exchange{TurnID: m.id, Request: d.scrub(req), Status: ExchangeCompleted, StartedAt: m.at, Model: model, TaskID: taskOf[m.id]}
		last, end := i, m
		var answered bool
		for j := i + 1; j < len(msgs); j++ {
			if msgs[j].role == "user" && strings.TrimSpace(messageText([]byte(msgs[j].raw))) != "" {
				break
			}
			last = j
			if msgs[j].role == "assistant" {
				end = msgs[j]
				if t := strings.TrimSpace(messageText([]byte(msgs[j].raw))); t != "" {
					e.Answer, e.MessageID, answered = d.scrub(t), msgs[j].id, true
					e.Status = ExchangeCompleted
					if msgs[j].stopped {
						e.Status = ExchangeStopped
					}
				}
			}
		}
		if !answered {
			e.Status = ExchangeFailed
		}
		e.Answer, e.AnswerTruncated = CapAnswer(e.Answer)
		if ms := parseStamp(end.at).Sub(parseStamp(m.at)).Milliseconds(); ms > 0 {
			e.DurationMS = ms
		}
		e.Files = filesOf[m.id]
		if _, _, err := recordExchange(ctx, tx, e, SessionGap, d.scrub); err != nil {
			return err
		}
		i = last
	}
	return tx.Commit()
}

func containsStr(l []string, s string) bool {
	for _, v := range l {
		if v == s {
			return true
		}
	}
	return false
}

// MaxAnswerBytes caps a stored answer.
const MaxAnswerBytes = 64 << 10

// AnswerMarker ends an answer that was cut.
const AnswerMarker = "\n\n[answer cut: it was longer than 64 KiB]"

// CapAnswer cuts an answer at MaxAnswerBytes on a character boundary and says
// whether it did; the marker is appended to the cut text.
func CapAnswer(s string) (string, bool) {
	if len(s) <= MaxAnswerBytes {
		return s, false
	}
	cut := MaxAnswerBytes
	for cut > 0 && s[cut]&0xC0 == 0x80 {
		cut--
	}
	return s[:cut] + AnswerMarker, true
}
