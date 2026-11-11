CREATE TABLE IF NOT EXISTS project (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	name TEXT NOT NULL,
	description TEXT NOT NULL,
	instructions TEXT NOT NULL,
	models_json TEXT NOT NULL,
	max_depth INTEGER NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	budget_usd REAL
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
	role TEXT
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
