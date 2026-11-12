package orchestrator

// ReapSideForTest runs the side-session idle check once, against Options.Clock.
func (o *Orchestrator) ReapSideForTest() { o.reapSide() }
