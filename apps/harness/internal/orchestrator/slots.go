package orchestrator

import (
	"context"

	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

// projectCap is the project's sessions.max_running (how many of its main sessions run turns at once).
func (o *Orchestrator) projectCap(ctx context.Context, db *projectstore.DB) int {
	c, cancel := dbCtx(ctx)
	defer cancel()
	return db.SessionsSettings(c).MaxRunning
}

// Reschedule hands free slots to waiting messages (after the project's running cap changed).
func (o *Orchestrator) Reschedule() {
	o.qmu.Lock()
	defer o.qmu.Unlock()
	o.schedule()
}

// ForgetSession drops what the orchestrator keeps for a deleted main session: its ACP process and its place
// among the sessions waiting for a slot.
func (o *Orchestrator) ForgetSession(pid, sid string) {
	key := skey(pid, sid)
	o.resetACPSession(key)
	o.acp.mu.Lock()
	delete(o.acp.sessions, key)
	o.acp.mu.Unlock()
	o.qmu.Lock()
	delete(o.waiting, key)
	o.qmu.Unlock()
}
