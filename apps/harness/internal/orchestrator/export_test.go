package orchestrator

// ReapSideForTest runs the side-session idle check once, against Options.Clock.
func (o *Orchestrator) ReapSideForTest() { o.reapSide() }

// WaitSettledForTest returns when every digest of a finished turn has been applied to the task list.
func (o *Orchestrator) WaitSettledForTest() { o.settling.Wait() }
