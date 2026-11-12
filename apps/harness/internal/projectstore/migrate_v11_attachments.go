package projectstore

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/ndolinschi/Octo/apps/harness/internal/attachments"
)

// Schema 11 (attach images, B12) adds the attachments table and the
// attachments column of the queue. It is its own file and function so the
// version number can be renumbered when migrations from parallel work are
// merged. Every statement is idempotent.
const attachmentsSchemaVersion = 11

const attachmentsSchema = `
CREATE TABLE IF NOT EXISTS attachments (
	id TEXT PRIMARY KEY,
	sha256 TEXT NOT NULL,
	media_type TEXT NOT NULL,
	bytes INTEGER NOT NULL,
	width INTEGER NOT NULL DEFAULT 0,
	height INTEGER NOT NULL DEFAULT 0,
	name TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL
);
`

func (d *DB) migrateV11Attachments(ctx context.Context) error {
	if _, err := d.sql.ExecContext(ctx, attachmentsSchema); err != nil {
		return fmt.Errorf("attachments schema (v%d): %w", attachmentsSchemaVersion, err)
	}
	have, err := d.columns(ctx, "queue")
	if err != nil {
		return err
	}
	if !have["attachments"] {
		if _, err := d.sql.ExecContext(ctx, `ALTER TABLE queue ADD COLUMN attachments TEXT NOT NULL DEFAULT ''`); err != nil {
			return fmt.Errorf("add queue.attachments: %w", err)
		}
	}
	return nil
}

// Attachment is an uploaded image; its bytes live in the project's data
// directory under attachments/<sha256>.
type Attachment struct {
	ID        string `json:"id"`
	MediaType string `json:"media_type"`
	Bytes     int64  `json:"bytes"`
	Width     int    `json:"width"`
	Height    int    `json:"height"`
	Name      string `json:"name,omitempty"`
	CreatedAt string `json:"created_at,omitempty"`
	sha       string
}

func (d *DB) attachmentPath(sha string) string { return filepath.Join(d.dir, "attachments", sha) }

// PutAttachment stores an image (info from attachments.Describe of data). The
// same content is stored once; storing it again renews its created_at, which
// the cleanup counts from.
func (d *DB) PutAttachment(ctx context.Context, info attachments.Info, name string, data []byte) (Attachment, error) {
	path := d.attachmentPath(info.SHA256)
	if _, err := os.Stat(path); err != nil {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return Attachment{}, err
		}
		tmp := path + ".tmp"
		if err := os.WriteFile(tmp, data, 0o600); err != nil {
			return Attachment{}, err
		}
		if err := os.Rename(tmp, path); err != nil {
			return Attachment{}, err
		}
	}
	a := Attachment{ID: info.ID, MediaType: info.MediaType, Bytes: info.Bytes, Width: info.Width, Height: info.Height, Name: name, CreatedAt: Now(), sha: info.SHA256}
	_, err := d.sql.ExecContext(ctx, `INSERT INTO attachments (id, sha256, media_type, bytes, width, height, name, created_at) VALUES (?,?,?,?,?,?,?,?)
		ON CONFLICT(id) DO UPDATE SET created_at = excluded.created_at, name = excluded.name`,
		a.ID, a.sha, a.MediaType, a.Bytes, a.Width, a.Height, a.Name, a.CreatedAt)
	return a, err
}

// Attachment returns one attachment's record; ErrNotFound for an unknown id.
func (d *DB) Attachment(ctx context.Context, id string) (Attachment, error) {
	var a Attachment
	err := d.sql.QueryRowContext(ctx, `SELECT id, sha256, media_type, bytes, width, height, name, created_at FROM attachments WHERE id = ?`, id).
		Scan(&a.ID, &a.sha, &a.MediaType, &a.Bytes, &a.Width, &a.Height, &a.Name, &a.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return a, ErrNotFound
	}
	return a, err
}

// AttachmentData returns the record and the bytes of an attachment.
func (d *DB) AttachmentData(ctx context.Context, id string) (Attachment, []byte, error) {
	a, err := d.Attachment(ctx, id)
	if err != nil {
		return a, nil, err
	}
	data, err := os.ReadFile(d.attachmentPath(a.sha))
	if errors.Is(err, os.ErrNotExist) {
		return a, nil, ErrNotFound
	}
	return a, data, err
}

// PruneAttachments deletes attachments created before cutoff (a Now() style
// timestamp) that no stored message and no queued message refers to; it returns
// how many it removed.
func (d *DB) PruneAttachments(ctx context.Context, cutoff string) (int, error) {
	rows, err := d.sql.QueryContext(ctx, `SELECT id, sha256 FROM attachments WHERE created_at < ?`, cutoff)
	if err != nil {
		return 0, err
	}
	type cand struct{ id, sha string }
	var cands []cand
	for rows.Next() {
		var c cand
		if err := rows.Scan(&c.id, &c.sha); err != nil {
			rows.Close()
			return 0, err
		}
		cands = append(cands, c)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}
	n := 0
	for _, c := range cands {
		var used int
		if err := d.sql.QueryRowContext(ctx, `SELECT
			(SELECT COUNT(*) FROM messages WHERE content_json LIKE ?) + (SELECT COUNT(*) FROM queue WHERE attachments LIKE ?)`,
			"%"+c.id+"%", "%"+c.id+"%").Scan(&used); err != nil {
			return n, err
		}
		if used > 0 {
			continue
		}
		if _, err := d.sql.ExecContext(ctx, `DELETE FROM attachments WHERE id = ?`, c.id); err != nil {
			return n, err
		}
		if err := os.Remove(d.attachmentPath(c.sha)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return n, err
		}
		n++
	}
	return n, nil
}

func encodeIDs(ids []string) string {
	if len(ids) == 0 {
		return ""
	}
	b, _ := json.Marshal(ids)
	return string(b)
}

func decodeIDs(s string) []string {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	var ids []string
	if json.Unmarshal([]byte(s), &ids) != nil {
		return nil
	}
	return ids
}
