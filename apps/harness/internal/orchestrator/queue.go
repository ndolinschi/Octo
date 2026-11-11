package orchestrator

import (
	"context"
	"errors"
	"log/slog"

	"github.com/ndolinschi/Octo/apps/harness/internal/events"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

// ErrQueueFull: the project already queues projectstore.MaxQueue messages.
var ErrQueueFull = projectstore.ErrQueueFull

// Queue is the persisted FIFO of messages sent while a turn runs. The state
// (messages, paused flag) lives in the project database; qmu serializes every
// decision about it against the end of a turn, so a message never overtakes
// the queue and none is started twice.

// Submit takes a user message: it starts a turn when none runs and nothing is
// ahead of it, else it is queued (queued != nil). A paused queue does not
// block a new message while no turn runs: the user asked for it now.
func (o *Orchestrator) Submit(ctx context.Context, pid, text string) (started projectstore.Message, queued *projectstore.QueuedMessage, err error) {
	o.qmu.Lock()
	defer o.qmu.Unlock()
	db, err := o.store.Get(ctx, pid)
	if err != nil {
		return started, nil, err
	}
	if !o.Running(pid) {
		q, paused, qerr := db.Queue(ctx)
		if qerr != nil {
			return started, nil, qerr
		}
		if len(q) == 0 || paused {
			msg, err := o.Start(ctx, pid, text)
			if !errors.Is(err, ErrTurnInProgress) {
				return msg, nil, err
			}
		}
	}
	m, err := o.enqueue(ctx, db, text)
	if err != nil {
		return started, nil, err
	}
	return started, &m, nil
}

func (o *Orchestrator) enqueue(ctx context.Context, db *projectstore.DB, text string) (projectstore.QueuedMessage, error) {
	q, _, err := db.Queue(ctx)
	if err != nil {
		return projectstore.QueuedMessage{}, err
	}
	if len(q) == 0 {
		// An empty queue is never paused: the flag only matters with messages in it.
		if err := db.SetQueuePaused(ctx, false); err != nil {
			return projectstore.QueuedMessage{}, err
		}
	}
	m, err := db.Enqueue(ctx, text)
	if err != nil {
		return m, err
	}
	o.publishQueue(ctx, db)
	return m, nil
}

func (o *Orchestrator) publishQueue(ctx context.Context, db *projectstore.DB) {
	q, paused, err := db.Queue(ctx)
	if err != nil {
		slog.Error("read queue", "project", db.ID(), "err", err)
		return
	}
	o.hub.Publish(db.ID(), events.QueueUpdated, map[string]any{"paused": paused, "messages": q})
}

// Queue returns the queued messages and whether the queue is paused.
func (o *Orchestrator) Queue(ctx context.Context, pid string) ([]projectstore.QueuedMessage, bool, error) {
	db, err := o.store.Get(ctx, pid)
	if err != nil {
		return nil, false, err
	}
	return db.Queue(ctx)
}

// EditQueued replaces a queued message's text.
func (o *Orchestrator) EditQueued(ctx context.Context, pid, qid, text string) (projectstore.QueuedMessage, error) {
	o.qmu.Lock()
	defer o.qmu.Unlock()
	db, err := o.store.Get(ctx, pid)
	if err != nil {
		return projectstore.QueuedMessage{}, err
	}
	m, err := db.EditQueued(ctx, qid, text)
	if err == nil {
		o.publishQueue(ctx, db)
	}
	return m, err
}

// RemoveQueued deletes a queued message; an empty qid clears the queue.
func (o *Orchestrator) RemoveQueued(ctx context.Context, pid, qid string) error {
	o.qmu.Lock()
	defer o.qmu.Unlock()
	db, err := o.store.Get(ctx, pid)
	if err != nil {
		return err
	}
	if qid == "" {
		err = db.ClearQueue(ctx)
	} else {
		err = db.RemoveQueued(ctx, qid)
	}
	if err == nil {
		o.publishQueue(ctx, db)
	}
	return err
}

// ResumeQueue lifts the pause and, with no turn running, starts the next message.
func (o *Orchestrator) ResumeQueue(ctx context.Context, pid string) error {
	o.qmu.Lock()
	defer o.qmu.Unlock()
	db, err := o.store.Get(ctx, pid)
	if err != nil {
		return err
	}
	if err := db.SetQueuePaused(ctx, false); err != nil {
		return err
	}
	o.publishQueue(ctx, db)
	if !o.Running(pid) {
		o.startNext(db)
	}
	return nil
}

// SendNow runs a queued message next: with a turn running it is cancelled
// first (and the queue is not paused by that cancel); otherwise the message
// starts at once.
func (o *Orchestrator) SendNow(ctx context.Context, pid, qid string) error {
	o.qmu.Lock()
	defer o.qmu.Unlock()
	db, err := o.store.Get(ctx, pid)
	if err != nil {
		return err
	}
	if err := db.MoveQueuedFirst(ctx, qid); err != nil {
		return err
	}
	if err := db.SetQueuePaused(ctx, false); err != nil {
		return err
	}
	if o.Running(pid) {
		o.sendNow[pid] = true
		o.publishQueue(ctx, db)
		o.Cancel(pid)
		return nil
	}
	o.publishQueue(ctx, db)
	o.startNext(db)
	return nil
}

// advance runs after a turn ended (qmu held, the turn's slot released): a
// failed or cancelled turn pauses a non-empty queue, a completed one starts
// the next message. SendNow's cancel is the one cancel that does not pause.
func (o *Orchestrator) advance(pid string, status projectstore.AgentStatus) {
	forced := o.sendNow[pid]
	delete(o.sendNow, pid)
	if o.baseCtx.Err() != nil {
		status = projectstore.StatusCancelled // shutting down: nothing starts, the queue waits
	}
	ctx := context.Background()
	db, err := o.store.Get(ctx, pid)
	if err != nil {
		return // the project is gone
	}
	if (status == projectstore.StatusFailed || status == projectstore.StatusCancelled) && !forced {
		if q, _, err := db.Queue(ctx); err == nil && len(q) > 0 {
			if err := db.SetQueuePaused(ctx, true); err != nil {
				slog.Error("pause queue", "project", pid, "err", err)
			}
			o.publishQueue(ctx, db)
		}
		return
	}
	if o.baseCtx.Err() != nil {
		return
	}
	o.startNext(db)
}

// startNext starts the first queued message when the queue is not paused (qmu
// held). A message that cannot start pauses the queue instead of looping.
func (o *Orchestrator) startNext(db *projectstore.DB) {
	ctx := context.Background()
	q, paused, err := db.Queue(ctx)
	if err != nil || paused || len(q) == 0 {
		return
	}
	first := q[0]
	if _, err := o.Start(ctx, db.ID(), first.Text); err != nil {
		if errors.Is(err, ErrTurnInProgress) {
			return
		}
		slog.Error("start queued message", "project", db.ID(), "err", err)
		_ = db.SetQueuePaused(ctx, true)
		o.publishQueue(ctx, db)
		return
	}
	if err := db.RemoveQueued(ctx, first.ID); err != nil {
		slog.Error("dequeue started message", "project", db.ID(), "err", err)
	}
	o.publishQueue(ctx, db)
}
