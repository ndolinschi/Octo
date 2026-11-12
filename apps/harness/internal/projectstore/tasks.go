package projectstore

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
)

// Task statuses.
const (
	TaskOpen    = "open"
	TaskDone    = "done"
	TaskDropped = "dropped"
)

// Quote is wording of the user kept exactly, with the message it came from.
type Quote struct {
	Text      string `json:"text"`
	MessageID int64  `json:"message_id"`
}

// Fact is a short standalone statement with its date. A fact that was
// contradicted later stays, marked superseded by the newer one.
type Fact struct {
	ID           string `json:"id"`
	Text         string `json:"text"`
	Date         string `json:"date"`
	MessageID    int64  `json:"message_id"`
	SupersededBy string `json:"superseded_by,omitempty"`
	// Kind ("fact", "decision", "preference", "todo"), About (the subject) and RememberedBy (the
	// agent, or "user") are set on facts stored by the remember tool.
	Kind         string `json:"kind,omitempty"`
	About        string `json:"about,omitempty"`
	RememberedBy string `json:"remembered_by,omitempty"`
}

// Task is a task record: the detail map of one piece of work.
type Task struct {
	ID     string `json:"id"`
	Title  string `json:"title"`
	Status string `json:"status"`
	Goal   string `json:"goal"`
	// GoalBy says who wrote the goal: "harness" (the fallback: the first 400
	// characters of the request), "orchestrator" or "digest".
	GoalBy string `json:"goal_by"`
	// Auto is true while the record is the one the harness opened for a request
	// and nobody has edited.
	Auto        bool     `json:"auto"`
	Constraints []string `json:"constraints"`
	Acceptance  []string `json:"acceptance"`
	Quotes      []Quote  `json:"quotes"`
	Decisions   []string `json:"decisions"`
	Outcome     string   `json:"outcome"`
	Files       []string `json:"files"`
	Facts       []Fact   `json:"facts"`
	MessageIDs  []int64  `json:"message_ids"`
	CreatedAt   string   `json:"created_at"`
	UpdatedAt   string   `json:"updated_at"`
}

type taskData struct {
	Constraints []string `json:"constraints"`
	Acceptance  []string `json:"acceptance"`
	Quotes      []Quote  `json:"quotes"`
	Decisions   []string `json:"decisions"`
	Files       []string `json:"files"`
	Facts       []Fact   `json:"facts"`
	MessageIDs  []int64  `json:"message_ids"`
}

func (t *Task) normalize() {
	if t.Constraints == nil {
		t.Constraints = []string{}
	}
	if t.Acceptance == nil {
		t.Acceptance = []string{}
	}
	if t.Quotes == nil {
		t.Quotes = []Quote{}
	}
	if t.Decisions == nil {
		t.Decisions = []string{}
	}
	if t.Files == nil {
		t.Files = []string{}
	}
	if t.Facts == nil {
		t.Facts = []Fact{}
	}
	if t.MessageIDs == nil {
		t.MessageIDs = []int64{}
	}
}

func (t Task) data() ([]byte, error) {
	t.normalize()
	return json.Marshal(taskData{t.Constraints, t.Acceptance, t.Quotes, t.Decisions, t.Files, t.Facts, t.MessageIDs})
}

const taskCols = `id, title, status, goal, goal_by, auto, data_json, outcome, created_at, updated_at`

func scanTask(sc interface{ Scan(...any) error }) (Task, error) {
	var t Task
	var data string
	if err := sc.Scan(&t.ID, &t.Title, &t.Status, &t.Goal, &t.GoalBy, &t.Auto, &data, &t.Outcome, &t.CreatedAt, &t.UpdatedAt); err != nil {
		return t, err
	}
	var d taskData
	if err := json.Unmarshal([]byte(data), &d); err != nil {
		return t, err
	}
	t.Constraints, t.Acceptance, t.Quotes, t.Decisions, t.Files, t.Facts, t.MessageIDs =
		d.Constraints, d.Acceptance, d.Quotes, d.Decisions, d.Files, d.Facts, d.MessageIDs
	t.normalize()
	return t, nil
}

// taskDocs are the search documents of a task: the record and each fact.
func taskDocs(t Task) []Doc {
	var b strings.Builder
	add := func(label string, items ...string) {
		for _, s := range items {
			if strings.TrimSpace(s) != "" {
				b.WriteString(label + s + "\n")
			}
		}
	}
	add("goal: ", t.Goal)
	add("constraint: ", t.Constraints...)
	add("acceptance: ", t.Acceptance...)
	for _, q := range t.Quotes {
		add("quote: ", q.Text)
	}
	add("decision: ", t.Decisions...)
	add("outcome: ", t.Outcome)
	add("file: ", t.Files...)
	docs := []Doc{{Kind: DocTask, Ref: t.ID, Title: t.Title, Body: b.String(), Date: t.UpdatedAt, TaskID: t.ID}}
	for _, f := range t.Facts {
		docs = append(docs, Doc{Kind: DocFact, Ref: t.ID + "/" + f.ID, Title: t.Title, Body: f.Text, Date: f.Date,
			Superseded: f.SupersededBy != "", MessageID: f.MessageID, TaskID: t.ID})
	}
	return docs
}

func (d *DB) indexTask(ctx context.Context, x execer, t Task) error {
	if err := delDoc(ctx, x, DocTask, t.ID); err != nil {
		return err
	}
	if err := delDoc(ctx, x, DocFact, t.ID+"/"); err != nil {
		return err
	}
	for _, doc := range taskDocs(t) {
		if err := putDoc(ctx, x, doc); err != nil {
			return err
		}
	}
	return nil
}

// CreateTask stores a new task (ID and timestamps are filled in) and indexes it.
func (d *DB) CreateTask(ctx context.Context, t Task) (Task, error) {
	t.ID, t.CreatedAt, t.UpdatedAt = NewID("tsk"), Now(), Now()
	if t.Status == "" {
		t.Status = TaskOpen
	}
	return t, d.writeTask(ctx, t, true)
}

// SaveTask replaces a stored task (UpdatedAt is set now) and reindexes it.
func (d *DB) SaveTask(ctx context.Context, t Task) (Task, error) {
	t.UpdatedAt = Now()
	return t, d.writeTask(ctx, t, false)
}

func (d *DB) writeTask(ctx context.Context, t Task, create bool) error {
	data, err := t.data()
	if err != nil {
		return err
	}
	tx, err := d.sql.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if create {
		_, err = tx.ExecContext(ctx, `INSERT INTO tasks (`+taskCols+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			t.ID, t.Title, t.Status, t.Goal, t.GoalBy, t.Auto, string(data), t.Outcome, t.CreatedAt, t.UpdatedAt)
	} else {
		var res sql.Result
		res, err = tx.ExecContext(ctx, `UPDATE tasks SET title=?, status=?, goal=?, goal_by=?, auto=?, data_json=?, outcome=?, updated_at=? WHERE id=?`,
			t.Title, t.Status, t.Goal, t.GoalBy, t.Auto, string(data), t.Outcome, t.UpdatedAt, t.ID)
		if err == nil {
			if n, _ := res.RowsAffected(); n == 0 {
				err = ErrNotFound
			}
		}
	}
	if err != nil {
		return err
	}
	if err := d.indexTask(ctx, tx, t); err != nil {
		return err
	}
	return tx.Commit()
}

// Task returns one task record.
func (d *DB) Task(ctx context.Context, id string) (Task, error) {
	t, err := scanTask(d.sql.QueryRowContext(ctx, `SELECT `+taskCols+` FROM tasks WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return t, ErrNotFound
	}
	return t, err
}

// Tasks lists the task records, newest update first.
func (d *DB) Tasks(ctx context.Context) ([]Task, error) {
	rows, err := d.sql.QueryContext(ctx, `SELECT `+taskCols+` FROM tasks ORDER BY updated_at DESC, id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Task{}
	for rows.Next() {
		t, err := scanTask(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// DeleteTask removes a task record and its search documents.
func (d *DB) DeleteTask(ctx context.Context, id string) error {
	tx, err := d.sql.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	res, err := tx.ExecContext(ctx, `DELETE FROM tasks WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	if err := delDoc(ctx, tx, DocTask, id); err != nil {
		return err
	}
	if err := delDoc(ctx, tx, DocFact, id+"/"); err != nil {
		return err
	}
	return tx.Commit()
}

// MemoryFile is a markdown file of the project's memory.
type MemoryFile struct {
	Path      string `json:"path"`
	Summary   string `json:"summary"`
	Content   string `json:"content,omitempty"`
	Size      int    `json:"size"`
	CreatedAt string `json:"created_at"`
	UpdatedAt string `json:"updated_at"`
}

func fileDoc(f MemoryFile) Doc {
	return Doc{Kind: DocFile, Ref: f.Path, Title: f.Path + " — " + f.Summary, Body: f.Content, Date: f.UpdatedAt}
}

// PutFile creates or replaces a memory file and indexes it in the same transaction.
func (d *DB) PutFile(ctx context.Context, f MemoryFile) (MemoryFile, error) {
	now := Now()
	tx, err := d.sql.BeginTx(ctx, nil)
	if err != nil {
		return f, err
	}
	defer func() { _ = tx.Rollback() }()
	var created string
	err = tx.QueryRowContext(ctx, `SELECT created_at FROM memory_files WHERE path = ?`, f.Path).Scan(&created)
	if errors.Is(err, sql.ErrNoRows) {
		created = now
	} else if err != nil {
		return f, err
	}
	f.CreatedAt, f.UpdatedAt, f.Size = created, now, len(f.Content)
	if _, err := tx.ExecContext(ctx, `INSERT INTO memory_files (path, summary, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(path) DO UPDATE SET summary = excluded.summary, content = excluded.content, updated_at = excluded.updated_at`,
		f.Path, f.Summary, f.Content, created, now); err != nil {
		return f, err
	}
	if err := putDoc(ctx, tx, fileDoc(f)); err != nil {
		return f, err
	}
	return f, tx.Commit()
}

// File returns a memory file with its content.
func (d *DB) File(ctx context.Context, path string) (MemoryFile, error) {
	f := MemoryFile{Path: path}
	err := d.sql.QueryRowContext(ctx, `SELECT summary, content, created_at, updated_at FROM memory_files WHERE path = ?`, path).
		Scan(&f.Summary, &f.Content, &f.CreatedAt, &f.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return f, ErrNotFound
	}
	f.Size = len(f.Content)
	return f, err
}

// Files lists the memory files without content, by path.
func (d *DB) Files(ctx context.Context) ([]MemoryFile, error) {
	rows, err := d.sql.QueryContext(ctx, `SELECT path, summary, length(CAST(content AS BLOB)), created_at, updated_at FROM memory_files ORDER BY path`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []MemoryFile{}
	for rows.Next() {
		var f MemoryFile
		if err := rows.Scan(&f.Path, &f.Summary, &f.Size, &f.CreatedAt, &f.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

// DeleteFile removes a memory file from the store and the index.
func (d *DB) DeleteFile(ctx context.Context, path string) error {
	tx, err := d.sql.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	res, err := tx.ExecContext(ctx, `DELETE FROM memory_files WHERE path = ?`, path)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	if err := delDoc(ctx, tx, DocFile, path); err != nil {
		return err
	}
	return tx.Commit()
}

// RenameFile moves a memory file; the target must not exist.
func (d *DB) RenameFile(ctx context.Context, from, to string) error {
	f, err := d.File(ctx, from)
	if err != nil {
		return err
	}
	if _, err := d.File(ctx, to); err == nil {
		return ErrExists
	}
	tx, err := d.sql.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `UPDATE memory_files SET path = ?, updated_at = ? WHERE path = ?`, to, Now(), from); err != nil {
		return err
	}
	if err := delDoc(ctx, tx, DocFile, from); err != nil {
		return err
	}
	f.Path, f.UpdatedAt = to, Now()
	if err := putDoc(ctx, tx, fileDoc(f)); err != nil {
		return err
	}
	return tx.Commit()
}

// ErrExists: the target already exists.
var ErrExists = errors.New("projectstore: already exists")

// messageText joins the text blocks of a stored message.
func messageText(raw []byte) string {
	var parts []string
	for _, b := range NormalizeContent(raw) {
		if b.Type == "text" && b.Text != nil && strings.TrimSpace(*b.Text) != "" {
			parts = append(parts, *b.Text)
		}
	}
	return strings.Join(parts, "\n")
}

func messageDoc(id int64, role, text, created string) Doc {
	return Doc{Kind: DocMessage, Ref: itoa(id), Title: role, Body: text, Date: created, MessageID: id}
}

func itoa(n int64) string {
	b, _ := json.Marshal(n)
	return string(b)
}

// MessageText returns one message's text verbatim, and its role, agent and time.
func (d *DB) MessageText(ctx context.Context, id int64) (text, role, agentID, created string, err error) {
	var raw string
	err = d.sql.QueryRowContext(ctx, `SELECT role, agent_id, content_json, created_at FROM messages WHERE id = ?`, id).
		Scan(&role, &agentID, &raw, &created)
	if errors.Is(err, sql.ErrNoRows) {
		return "", "", "", "", ErrNotFound
	}
	return messageText([]byte(raw)), role, agentID, created, err
}

// backfillMessages indexes the user and assistant texts of a database that
// predates the search indexes.
func (d *DB) backfillMessages(ctx context.Context) error {
	rows, err := d.sql.QueryContext(ctx, `SELECT id, role, content_json, created_at FROM messages WHERE role IN ('user','assistant') ORDER BY id`)
	if err != nil {
		return err
	}
	var docs []Doc
	for rows.Next() {
		var id int64
		var role, raw, created string
		if err := rows.Scan(&id, &role, &raw, &created); err != nil {
			_ = rows.Close()
			return err
		}
		if text := messageText([]byte(raw)); text != "" {
			docs = append(docs, messageDoc(id, role, text, created))
		}
	}
	if err := rows.Close(); err != nil {
		return err
	}
	tx, err := d.sql.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	for _, doc := range docs {
		if err := putDoc(ctx, tx, doc); err != nil {
			return err
		}
	}
	return tx.Commit()
}
