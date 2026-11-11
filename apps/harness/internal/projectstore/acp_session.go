package projectstore

import (
	"context"
	"database/sql"
)

// ACPSession remembers the ACP session an ACP-run orchestrator last used, so a
// restarted process (or harness) can resume it with session/load.
type ACPSession struct {
	AgentID     string // the project agent row (the orchestrator)
	PluginAgent string // the plugin agent id the session belongs to
	Model       string
	SessionID   string
}

// ACPSession returns the stored session of an agent row.
func (d *DB) ACPSession(ctx context.Context, agentID string) (ACPSession, bool, error) {
	s := ACPSession{AgentID: agentID}
	err := d.sql.QueryRowContext(ctx,
		`SELECT plugin_agent, model, session_id FROM acp_sessions WHERE agent_id = ?`, agentID,
	).Scan(&s.PluginAgent, &s.Model, &s.SessionID)
	if err == sql.ErrNoRows {
		return ACPSession{}, false, nil
	}
	return s, err == nil, err
}

// SaveACPSession upserts the session of an agent row.
func (d *DB) SaveACPSession(ctx context.Context, s ACPSession) error {
	_, err := d.sql.ExecContext(ctx,
		`INSERT INTO acp_sessions (agent_id, plugin_agent, model, session_id, updated_at) VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT(agent_id) DO UPDATE SET plugin_agent = excluded.plugin_agent, model = excluded.model,
		 session_id = excluded.session_id, updated_at = excluded.updated_at`,
		s.AgentID, s.PluginAgent, s.Model, s.SessionID, Now())
	return err
}

// DeleteACPSession forgets the stored session of an agent row.
func (d *DB) DeleteACPSession(ctx context.Context, agentID string) error {
	_, err := d.sql.ExecContext(ctx, `DELETE FROM acp_sessions WHERE agent_id = ?`, agentID)
	return err
}
