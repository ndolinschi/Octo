package orchestrator

import (
	"context"
	"errors"
	"log/slog"
	"sort"

	"github.com/ndolinschi/Octo/apps/harness/internal/events"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

// ErrQueueFull: the session already queues projectstore.MaxQueue messages.
var ErrQueueFull = projectstore.ErrQueueFull

// Queue is the persisted FIFO of messages sent to a main session while its turn runs, or while the running caps
// are reached (schema 15: one queue per session). The state (messages, paused flag) lives in the project
// database; qmu serializes every decision about any queue against the end of a turn, so a message never
// overtakes its queue, none is started twice, and free slots go to the waiting messages in the order they
// were queued, across sessions and projects (schedule).

// Submit takes a user message for the default session: it starts a turn when none runs and nothing is ahead of
// it, else it is queued (queued != nil). A paused queue does not block a new message while no turn runs: the
// user asked for it now.
func (o *Orchestrator) Submit(ctx context.Context, pid, text string) (started projectstore.Message, queued *projectstore.QueuedMessage, err error) {
	return o.SubmitMode(ctx, pid, text, "")
}

// SubmitMode is Submit with a mode chosen for this message ("": the project's).
func (o *Orchestrator) SubmitMode(ctx context.Context, pid, text, mode string) (started projectstore.Message, queued *projectstore.QueuedMessage, err error) {
	return o.SubmitAttach(ctx, pid, text, mode, nil)
}

// SubmitAttach is SubmitMode with the ids of attached images (validated by the caller).
func (o *Orchestrator) SubmitAttach(ctx context.Context, pid, text, mode string, attachments []string) (started projectstore.Message, queued *projectstore.QueuedMessage, err error) {
	return o.SubmitSession(ctx, pid, "", text, mode, attachments)
}

// SubmitSession is SubmitAttach for one main session ("": the default). A message the running caps do not let
// start waits in the session's queue with waiting_for "slot". ErrNotFound for a session that is not a main
// session of the project.
func (o *Orchestrator) SubmitSession(ctx context.Context, pid, sid, text, mode string, attachments []string) (started projectstore.Message, queued *projectstore.QueuedMessage, err error) {
	o.qmu.Lock()
	defer o.qmu.Unlock()
	db, err := o.store.Get(ctx, pid)
	if err != nil {
		return started, nil, err
	}
	if sid, err = o.mainSession(ctx, db, sid); err != nil {
		return started, nil, err
	}
	if !o.RunningSession(pid, sid) {
		q, paused, qerr := db.SessionQueue(ctx, sid)
		if qerr != nil {
			return started, nil, qerr
		}
		if len(q) == 0 || paused {
			msg, err := o.StartWith(ctx, pid, text, StartOpts{SessionID: sid, Mode: mode, Attachments: attachments})
			if err == nil {
				return msg, nil, nil
			}
			if !errors.Is(err, ErrTurnInProgress) && !errors.Is(err, ErrNoSlot) {
				return msg, nil, err
			}
		}
	}
	waiting := projectstore.WaitingSlot
	if o.RunningSession(pid, sid) {
		waiting = projectstore.WaitingTurn
	}
	m, err := o.enqueue(ctx, db, sid, text, mode, attachments, waiting)
	if err != nil {
		return started, nil, err
	}
	if waiting == projectstore.WaitingSlot {
		// Its session is not running: the message runs as soon as a slot is free (or now, when an earlier
		// waiting message was the one that was blocked).
		o.schedule()
	}
	return started, &m, nil
}

// mainSession resolves "" to the default session and checks that sid is a main session of the project.
func (o *Orchestrator) mainSession(ctx context.Context, db *projectstore.DB, sid string) (string, error) {
	if sid == "" {
		return db.DefaultSessionID(ctx)
	}
	info, err := db.SessionInfoOf(ctx, sid)
	if err != nil {
		return "", err
	}
	if info.Kind != projectstore.KindMain {
		return "", projectstore.ErrNotFound
	}
	return sid, nil
}

func (o *Orchestrator) enqueue(ctx context.Context, db *projectstore.DB, sid, text, mode string, attachments []string, waiting string) (projectstore.QueuedMessage, error) {
	q, _, err := db.SessionQueue(ctx, sid)
	if err != nil {
		return projectstore.QueuedMessage{}, err
	}
	if len(q) == 0 {
		// An empty queue is never paused: the flag only matters with messages in it.
		if err := db.SetSessionQueuePaused(ctx, sid, false); err != nil {
			return projectstore.QueuedMessage{}, err
		}
	}
	m, err := db.EnqueueIn(ctx, sid, text, mode, attachments, waiting)
	if err != nil {
		return m, err
	}
	o.waiting[skey(db.ID(), sid)] = true
	o.publishQueue(ctx, db, sid)
	return m, nil
}

// publishQueue announces a session's queue (queue.updated with its session_id) and the session's state.
func (o *Orchestrator) publishQueue(ctx context.Context, db *projectstore.DB, sid string) {
	q, paused, err := db.SessionQueue(ctx, sid)
	if err != nil {
		slog.Error("read queue", "project", db.ID(), "session", sid, "err", err)
		return
	}
	o.hub.Publish(db.ID(), events.QueueUpdated, map[string]any{"session_id": sid, "paused": paused, "messages": q})
	o.publishSession(ctx, db, sid, false)
}

// Queue returns the default session's queued messages and whether its queue is paused.
func (o *Orchestrator) Queue(ctx context.Context, pid string) ([]projectstore.QueuedMessage, bool, error) {
	return o.SessionQueue(ctx, pid, "")
}

// SessionQueue returns a session's queued messages and whether its queue is paused ("": the default).
func (o *Orchestrator) SessionQueue(ctx context.Context, pid, sid string) ([]projectstore.QueuedMessage, bool, error) {
	db, err := o.store.Get(ctx, pid)
	if err != nil {
		return nil, false, err
	}
	if sid, err = o.mainSession(ctx, db, sid); err != nil {
		return nil, false, err
	}
	return db.SessionQueue(ctx, sid)
}

// queuedIn returns a queued message of the project and checks it belongs to sid ("": any session).
func queuedIn(ctx context.Context, db *projectstore.DB, qid, sid string) (projectstore.QueuedMessage, error) {
	m, err := db.QueuedMessageByID(ctx, qid)
	if err != nil {
		return m, err
	}
	if sid != "" && m.SessionID != sid {
		return m, projectstore.ErrNotFound
	}
	return m, nil
}

// EditQueued replaces a queued message's text.
func (o *Orchestrator) EditQueued(ctx context.Context, pid, qid, text string) (projectstore.QueuedMessage, error) {
	return o.EditSessionQueued(ctx, pid, "", qid, text)
}

// EditSessionQueued is EditQueued for a message of one session ("": the message's own session).
func (o *Orchestrator) EditSessionQueued(ctx context.Context, pid, sid, qid, text string) (projectstore.QueuedMessage, error) {
	o.qmu.Lock()
	defer o.qmu.Unlock()
	db, err := o.store.Get(ctx, pid)
	if err != nil {
		return projectstore.QueuedMessage{}, err
	}
	cur, err := queuedIn(ctx, db, qid, sid)
	if err != nil {
		return cur, err
	}
	m, err := db.EditQueued(ctx, qid, text)
	if err == nil {
		o.publishQueue(ctx, db, cur.SessionID)
	}
	return m, err
}

// RemoveQueued deletes a queued message; an empty qid clears the default session's queue.
func (o *Orchestrator) RemoveQueued(ctx context.Context, pid, qid string) error {
	return o.RemoveSessionQueued(ctx, pid, "", qid)
}

// RemoveSessionQueued deletes a queued message of a session; an empty qid clears that session's queue ("": the
// default's).
func (o *Orchestrator) RemoveSessionQueued(ctx context.Context, pid, sid, qid string) error {
	o.qmu.Lock()
	defer o.qmu.Unlock()
	db, err := o.store.Get(ctx, pid)
	if err != nil {
		return err
	}
	if qid == "" {
		if sid, err = o.mainSession(ctx, db, sid); err != nil {
			return err
		}
		if err := db.ClearSessionQueue(ctx, sid); err != nil {
			return err
		}
		o.publishQueue(ctx, db, sid)
		return nil
	}
	m, err := queuedIn(ctx, db, qid, sid)
	if err != nil {
		return err
	}
	if err := db.RemoveQueued(ctx, qid); err != nil {
		return err
	}
	o.publishQueue(ctx, db, m.SessionID)
	return nil
}

// ResumeQueue lifts the pause of the default session's queue and, with no turn running there, starts its next
// message (when a slot is free).
func (o *Orchestrator) ResumeQueue(ctx context.Context, pid string) error {
	return o.ResumeSessionQueue(ctx, pid, "")
}

// ResumeSessionQueue is ResumeQueue for one session ("": the default).
func (o *Orchestrator) ResumeSessionQueue(ctx context.Context, pid, sid string) error {
	o.qmu.Lock()
	defer o.qmu.Unlock()
	db, err := o.store.Get(ctx, pid)
	if err != nil {
		return err
	}
	if sid, err = o.mainSession(ctx, db, sid); err != nil {
		return err
	}
	if err := db.SetSessionQueuePaused(ctx, sid, false); err != nil {
		return err
	}
	o.publishQueue(ctx, db, sid)
	o.waiting[skey(pid, sid)] = true
	o.schedule()
	return nil
}

// SendNow runs a queued message next (in its own session): with that session's turn running it is cancelled
// first (and the queue is not paused by that cancel); otherwise the message starts at once (when a slot is free).
//
// With interrupt false (the default of the API) a running built-in turn is not
// cancelled: the message is injected as a user message at the turn's next tool
// boundary (see steer.go). An ACP orchestrator's turn cannot take one:
// ErrSteerUnsupported (the caller may repeat with interrupt, or wait).
func (o *Orchestrator) SendNow(ctx context.Context, pid, qid string, interrupt bool) error {
	_, err := o.SendNowSession(ctx, pid, "", qid, interrupt)
	return err
}

// SendNowSession is SendNow restricted to a session's message ("": any session); steered says the running turn
// takes it at its next tool boundary.
func (o *Orchestrator) SendNowSession(ctx context.Context, pid, sid, qid string, interrupt bool) (steered bool, err error) {
	o.qmu.Lock()
	defer o.qmu.Unlock()
	db, err := o.store.Get(ctx, pid)
	if err != nil {
		return false, err
	}
	m, err := queuedIn(ctx, db, qid, sid)
	if err != nil {
		return false, err
	}
	sid = m.SessionID
	key := skey(pid, sid)
	running := o.RunningSession(pid, sid)
	if !interrupt && running {
		box := o.steerBox(key)
		if box == nil {
			return false, ErrSteerUnsupported
		}
		if len(m.Attachments) > 0 {
			return false, ErrSteerUnsupported // images cannot be injected mid-turn; wait or interrupt
		}
		if err := db.MoveQueuedFirst(ctx, qid); err != nil {
			return false, err
		}
		if err := db.SetSessionQueuePaused(ctx, sid, false); err != nil {
			return false, err
		}
		box.add(qid)
		o.publishQueue(ctx, db, sid)
		return true, nil
	}
	if err := db.MoveQueuedFirst(ctx, qid); err != nil {
		return false, err
	}
	if err := db.SetSessionQueuePaused(ctx, sid, false); err != nil {
		return false, err
	}
	o.waiting[key] = true
	if running {
		o.sendNow[key] = true
		o.publishQueue(ctx, db, sid)
		_ = o.CancelSession(ctx, pid, sid)
		return false, nil
	}
	o.publishQueue(ctx, db, sid)
	o.startHead(db, sid)
	return false, nil
}

// advance runs after a session's turn ended (qmu held, the turn's slot released): a failed or cancelled turn
// pauses the session's non-empty queue, a completed one lets its next message wait for the slot; then the free
// slot goes to the oldest waiting message of any session (schedule). SendNow's cancel is the one cancel that
// does not pause.
func (o *Orchestrator) advance(pid, sid string, status projectstore.AgentStatus) {
	key := skey(pid, sid)
	forced := o.sendNow[key]
	delete(o.sendNow, key)
	if o.baseCtx.Err() != nil {
		return // shutting down: nothing starts, the queues wait
	}
	ctx := context.Background()
	db, err := o.store.Get(ctx, pid)
	if err != nil {
		return // the project is gone
	}
	if (status == projectstore.StatusFailed || status == projectstore.StatusCancelled) && !forced {
		if q, _, err := db.SessionQueue(ctx, sid); err == nil && len(q) > 0 {
			if err := db.SetSessionQueuePaused(ctx, sid, true); err != nil {
				slog.Error("pause queue", "project", pid, "session", sid, "err", err)
			}
			delete(o.waiting, key)
			o.publishQueue(ctx, db, sid)
		}
	} else {
		o.waiting[key] = true
	}
	o.schedule()
}

// schedule hands free slots to waiting messages (qmu held): the first message of every session that is not
// running and whose queue is not paused is a candidate; candidates start in the order they were queued, each
// as long as its project and the harness have a free slot. A candidate that cannot start now waits for "slot".
func (o *Orchestrator) schedule() {
	if o.baseCtx.Err() != nil {
		return
	}
	ctx := context.Background()
	type cand struct {
		db   *projectstore.DB
		sid  string
		head projectstore.QueuedMessage
		cap  int
	}
	var cands []cand
	for key := range o.waiting {
		pid, sid := splitKey(key)
		if o.RunningSession(pid, sid) {
			continue // its turn's end decides
		}
		db, err := o.store.Get(ctx, pid)
		if err != nil {
			delete(o.waiting, key)
			continue
		}
		q, paused, err := db.SessionQueue(ctx, sid)
		if err != nil || paused || len(q) == 0 {
			delete(o.waiting, key)
			continue
		}
		cands = append(cands, cand{db: db, sid: sid, head: q[0], cap: o.projectCap(ctx, db)})
	}
	sort.SliceStable(cands, func(i, j int) bool {
		if cands[i].head.CreatedAt != cands[j].head.CreatedAt {
			return cands[i].head.CreatedAt < cands[j].head.CreatedAt
		}
		return cands[i].head.ID < cands[j].head.ID
	})
	for _, c := range cands {
		if o.hasSlot(c.db.ID(), c.cap) && o.startHead(c.db, c.sid) {
			continue
		}
		if c.head.WaitingFor != projectstore.WaitingSlot && !o.RunningSession(c.db.ID(), c.sid) {
			if err := c.db.SetWaitingFor(ctx, c.sid, projectstore.WaitingSlot); err == nil {
				o.publishQueue(ctx, c.db, c.sid)
			}
		}
	}
}

// startHead starts the first queued message of a session when its queue is not paused (qmu held) and reports
// whether it started. A message that cannot start for any reason other than a busy session or the caps pauses
// the queue instead of looping.
func (o *Orchestrator) startHead(db *projectstore.DB, sid string) bool {
	ctx := context.Background()
	q, paused, err := db.SessionQueue(ctx, sid)
	if err != nil || paused || len(q) == 0 {
		return false
	}
	first := q[0]
	if _, err := o.StartWith(ctx, db.ID(), first.Text, StartOpts{SessionID: sid, Mode: first.Mode, Attachments: first.Attachments}); err != nil {
		if errors.Is(err, ErrTurnInProgress) || errors.Is(err, ErrNoSlot) {
			return false
		}
		slog.Error("start queued message", "project", db.ID(), "session", sid, "err", err)
		_ = db.SetSessionQueuePaused(ctx, sid, true)
		delete(o.waiting, skey(db.ID(), sid))
		o.publishQueue(ctx, db, sid)
		return false
	}
	if err := db.RemoveQueued(ctx, first.ID); err != nil {
		slog.Error("dequeue started message", "project", db.ID(), "err", err)
	}
	if rest, _, err := db.SessionQueue(ctx, sid); err == nil && len(rest) > 0 {
		_ = db.SetWaitingFor(ctx, sid, projectstore.WaitingTurn)
	}
	o.publishQueue(ctx, db, sid)
	return true
}

// startNext is the old name of what a released slot does: schedule (qmu held).
func (o *Orchestrator) startNext(db *projectstore.DB, sid string) {
	o.waiting[skey(db.ID(), sid)] = true
	o.schedule()
}
