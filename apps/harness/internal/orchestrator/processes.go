package orchestrator

import "time"

// WorkerProcess describes a live ACP agent subprocess owned by the orchestrator.
type WorkerProcess struct {
	ID        string
	SessionID string
	Name      string
	Model     string
	Command   string
	Cwd       string
	PID       int
	Busy      bool
	StartedAt time.Time
	Stderr    string
}

// WorkerProcesses returns all live ACP orchestrator subprocesses of projectID.
func (o *Orchestrator) WorkerProcesses(projectID string) []WorkerProcess {
	o.acp.mu.Lock()
	var mine []*orchSession
	for k, s := range o.acp.sessions {
		if ofProject(k, projectID) {
			mine = append(mine, s)
		}
	}
	o.acp.mu.Unlock()

	out := make([]WorkerProcess, 0, len(mine))
	for _, s := range mine {
		s.mu.Lock()
		if !s.aliveLocked() || s.client == nil {
			s.mu.Unlock()
			continue
		}
		wp := WorkerProcess{
			ID:        "acp:" + s.sid,
			SessionID: s.sid,
			Name:      s.pluginID,
			Model:     s.model,
			Command:   s.cmdLine,
			Cwd:       s.cwd,
			PID:       s.client.PID(),
			Busy:      s.busy,
			StartedAt: s.startedAt,
			Stderr:    s.client.Stderr(),
		}
		s.mu.Unlock()
		out = append(out, wp)
	}
	return out
}

// StopWorkerProcess ends one live ACP orchestrator subprocess (cancelling an in-flight turn if any).
// Its stored session id is preserved so the next turn resumes cleanly on a fresh process.
func (o *Orchestrator) StopWorkerProcess(projectID, sessionID string) bool {
	s := o.acp.lookup(skey(projectID, sessionID))
	if s == nil {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.aliveLocked() {
		return false
	}
	if s.turnCancel != nil {
		s.turnCancel()
	}
	s.closeLocked()
	return true
}
