package orchestrator

import "time"

// ReapSideForTest runs the side-session idle check once, against Options.Clock.
func (o *Orchestrator) ReapSideForTest() { o.reapSide() }

// WaitSettledForTest returns when every digest of a finished turn has been applied to the task list.
func (o *Orchestrator) WaitSettledForTest() { o.settling.Wait() }

// SetCheckpointEveryForTest sets how often streamed text is checkpointed; the returned func restores it.
func SetCheckpointEveryForTest(d time.Duration) (restore func()) {
	old := checkpointEvery
	checkpointEvery = d
	return func() { checkpointEvery = old }
}

// SetTurnAliveEveryForTest sets how often a running turn records it is alive; the returned func restores it.
func SetTurnAliveEveryForTest(d time.Duration) (restore func()) {
	old := turnAliveEvery
	turnAliveEvery = d
	return func() { turnAliveEvery = old }
}

// SetBeforeCheckpointWrite makes every checkpoint write wait first (a slow disk) and returns the undo.
func SetBeforeCheckpointWrite(f func()) (restore func()) {
	old := beforeCheckpointWrite.Swap(&f)
	return func() { beforeCheckpointWrite.Store(old) }
}
