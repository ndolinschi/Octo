package projectstore

import (
	"context"
	"database/sql"
)

const projectSchema = `
CREATE TABLE IF NOT EXISTS project (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	name TEXT NOT NULL,
	description TEXT NOT NULL,
	instructions TEXT NOT NULL,
	models_json TEXT NOT NULL,
	max_depth INTEGER NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	budget_usd REAL,
	access TEXT NOT NULL DEFAULT 'full',
	queue_paused INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS folders (
	id TEXT PRIMARY KEY,
	label TEXT NOT NULL UNIQUE,
	path TEXT NOT NULL,
	created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agents (
	id TEXT PRIMARY KEY,
	parent_id TEXT,
	depth INTEGER NOT NULL,
	role TEXT NOT NULL,
	title TEXT NOT NULL,
	task TEXT NOT NULL,
	model TEXT NOT NULL,
	tier TEXT,
	status TEXT NOT NULL,
	result TEXT,
	error TEXT,
	spawn_tool_use_id TEXT,
	input_tokens INTEGER NOT NULL DEFAULT 0,
	output_tokens INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL,
	started_at TEXT,
	finished_at TEXT,
	context_used INTEGER,
	context_size INTEGER
);
CREATE TABLE IF NOT EXISTS messages (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	agent_id TEXT NOT NULL,
	role TEXT NOT NULL,
	content_json TEXT NOT NULL,
	created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_agent ON messages (agent_id, id);
CREATE TABLE IF NOT EXISTS notes (
	id TEXT PRIMARY KEY,
	title TEXT NOT NULL,
	content TEXT NOT NULL,
	author TEXT NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS usage (
	id INTEGER PRIMARY KEY,
	agent_id TEXT NOT NULL,
	model TEXT NOT NULL,
	source TEXT NOT NULL,
	input_tokens INTEGER NOT NULL,
	output_tokens INTEGER NOT NULL,
	cache_read_tokens INTEGER NOT NULL DEFAULT 0,
	cache_write_tokens INTEGER NOT NULL DEFAULT 0,
	cost_usd REAL,
	created_at TEXT NOT NULL,
	served_model TEXT,
	tier TEXT,
	route_trigger TEXT,
	router_request_id TEXT,
	cost_estimated INTEGER NOT NULL DEFAULT 0,
	role TEXT,
	flat_rate INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS usage_created ON usage (created_at);
CREATE TABLE IF NOT EXISTS compactions (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	agent_id TEXT NOT NULL,
	summary TEXT NOT NULL,
	upto_message_id INTEGER NOT NULL,
	created_at TEXT NOT NULL,
	usage_id INTEGER
);
CREATE INDEX IF NOT EXISTS compactions_agent ON compactions (agent_id, id);
CREATE TABLE IF NOT EXISTS acp_sessions (
	agent_id TEXT PRIMARY KEY,
	plugin_agent TEXT NOT NULL,
	model TEXT NOT NULL,
	session_id TEXT NOT NULL,
	updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS side_messages (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	side_id TEXT NOT NULL,
	role TEXT NOT NULL,
	content TEXT NOT NULL,
	created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS blobs (
	hash TEXT PRIMARY KEY,
	content BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS changes (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	turn_id INTEGER NOT NULL,
	agent_id TEXT NOT NULL,
	folder TEXT NOT NULL,
	path TEXT NOT NULL,
	before_hash TEXT,
	after_hash TEXT,
	added INTEGER,
	removed INTEGER,
	created_at TEXT NOT NULL,
	kind TEXT NOT NULL DEFAULT 'modified',
	note TEXT NOT NULL DEFAULT '',
	source TEXT NOT NULL DEFAULT '',
	tool_use_id TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS changes_turn ON changes (turn_id, id);
CREATE TABLE IF NOT EXISTS queue (
	id TEXT PRIMARY KEY,
	seq INTEGER NOT NULL,
	text TEXT NOT NULL,
	created_at TEXT NOT NULL
);`

// DB is one project's database. All methods are safe for concurrent use.
type DB struct {
	id  string
	sql *sql.DB
	// dir is the project's data directory (project.sqlite and its files).
	dir string
}

// Dir is the project's data directory.
func (d *DB) Dir() string { return d.dir }

func (d *DB) ID() string { return d.id }

func (d *DB) init(ctx context.Context, in NewProject) error {
	now := Now()
	_, err := d.sql.ExecContext(ctx,
		`INSERT INTO project (id, name, description, instructions, models_json, max_depth, created_at, updated_at, budget_usd, access)
		 VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		in.Name, in.Description, in.Instructions, in.ModelsJSON, in.MaxDepth, now, now, in.BudgetUSD, orFull(in.Access))
	if err != nil {
		return err
	}
	if err := d.ReplaceFolders(ctx, in.Folders); err != nil {
		return err
	}
	_, err = d.CreateAgent(ctx, NewAgent{Role: OrchestratorRole, Model: in.OrchestratorModel, Status: StatusIdle})
	return err
}

func (d *DB) Info(ctx context.Context) (Project, error) {
	p := Project{ID: d.id}
	var budget sql.NullFloat64
	err := d.sql.QueryRowContext(ctx,
		`SELECT name, description, instructions, models_json, max_depth, created_at, updated_at, budget_usd, access FROM project WHERE id = 1`,
	).Scan(&p.Name, &p.Description, &p.Instructions, &p.ModelsJSON, &p.MaxDepth, &p.CreatedAt, &p.UpdatedAt, &budget, &p.Access)
	if err == sql.ErrNoRows {
		return p, ErrNotFound
	}
	if budget.Valid {
		p.BudgetUSD = &budget.Float64
	}
	return p, err
}

func (d *DB) UpdateInfo(ctx context.Context, patch InfoPatch) error {
	set := newSetter()
	set.str("name", patch.Name)
	set.str("description", patch.Description)
	set.str("instructions", patch.Instructions)
	set.str("models_json", patch.ModelsJSON)
	if patch.MaxDepth != nil {
		set.add("max_depth", *patch.MaxDepth)
	}
	if patch.SetBudget {
		var v any
		if patch.BudgetUSD != nil {
			v = *patch.BudgetUSD
		}
		set.add("budget_usd", v)
	}
	set.str("access", patch.Access)
	set.add("updated_at", Now())
	return set.exec(ctx, d.sql, "project", "id = 1")
}

// Touch records project activity.
func (d *DB) Touch(ctx context.Context) error {
	_, err := d.sql.ExecContext(ctx, `UPDATE project SET updated_at = ? WHERE id = 1`, Now())
	return err
}

func (d *DB) Folders(ctx context.Context) ([]Folder, error) {
	rows, err := d.sql.QueryContext(ctx, `SELECT id, label, path FROM folders ORDER BY created_at, rowid`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Folder{}
	for rows.Next() {
		var f Folder
		if err := rows.Scan(&f.ID, &f.Label, &f.Path); err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

// ReplaceFolders swaps the whole folder set atomically.
func (d *DB) ReplaceFolders(ctx context.Context, folders []Folder) error {
	tx, err := d.sql.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `DELETE FROM folders`); err != nil {
		return err
	}
	now := Now()
	for _, f := range folders {
		id := f.ID
		if id == "" {
			id = NewID("fld")
		}
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO folders (id, label, path, created_at) VALUES (?, ?, ?, ?)`, id, f.Label, f.Path, now); err != nil {
			return err
		}
	}
	return tx.Commit()
}
