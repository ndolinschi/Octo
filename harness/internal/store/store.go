package store

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"fmt"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite"
)

const schema = `
CREATE TABLE IF NOT EXISTS sessions (
	id TEXT PRIMARY KEY,
	model TEXT NOT NULL,
	created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	session_id TEXT NOT NULL,
	role TEXT NOT NULL,
	content_json TEXT NOT NULL,
	created_at TEXT NOT NULL
);
`

type Store struct {
	db   *sql.DB
	path string
}

type SessionInfo struct {
	ID        string `json:"id"`
	Model     string `json:"model"`
	CreatedAt string `json:"created_at"`
}

type StoredMessage struct {
	ID          int64  `json:"id"`
	SessionID   string `json:"session_id"`
	Role        string `json:"role"`
	ContentJSON string `json:"content_json"`
	CreatedAt   string `json:"created_at"`
}

func Open(dataDir string) (*Store, error) {
	dbPath := filepath.Join(dataDir, "harness.sqlite")
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return nil, err
	}
	if _, err := db.Exec(schema); err != nil {
		_ = db.Close()
		return nil, err
	}
	return &Store{db: db, path: dbPath}, nil
}

func (s *Store) CreateSession(ctx context.Context, model string) (string, error) {
	id, err := newSessionID()
	if err != nil {
		return "", err
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	_, err = s.db.ExecContext(ctx,
		`INSERT INTO sessions (id, model, created_at) VALUES (?, ?, ?)`,
		id, model, now,
	)
	if err != nil {
		return "", err
	}
	return id, nil
}

func (s *Store) AppendMessage(ctx context.Context, sessionID, role string, contentJSON []byte) error {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO messages (session_id, role, content_json, created_at) VALUES (?, ?, ?, ?)`,
		sessionID, role, string(contentJSON), now,
	)
	return err
}

func (s *Store) ListSessions(ctx context.Context) ([]SessionInfo, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, model, created_at FROM sessions ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SessionInfo
	for rows.Next() {
		var si SessionInfo
		if err := rows.Scan(&si.ID, &si.Model, &si.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, si)
	}
	return out, rows.Err()
}

func (s *Store) GetMessages(ctx context.Context, sessionID string) ([]StoredMessage, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, session_id, role, content_json, created_at FROM messages WHERE session_id = ? ORDER BY id`,
		sessionID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []StoredMessage
	for rows.Next() {
		var m StoredMessage
		if err := rows.Scan(&m.ID, &m.SessionID, &m.Role, &m.ContentJSON, &m.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

func (s *Store) MessageCount(ctx context.Context, sessionID string) (int, error) {
	var n int
	err := s.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM messages WHERE session_id = ?`, sessionID,
	).Scan(&n)
	if err != nil {
		return 0, err
	}
	return n, nil
}

func (s *Store) Close() error {
	if s.db == nil {
		return nil
	}
	return s.db.Close()
}

func newSessionID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("session id: %w", err)
	}
	return hex.EncodeToString(b[:]), nil
}
