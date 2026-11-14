package orchestrator

import (
	"context"
	"errors"
	"slices"
	"sync"

	"github.com/ndolinschi/Octo/apps/harness/internal/events"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

// ErrSteerUnsupported: the running turn cannot take a message in the middle (an
// ACP orchestrator: the protocol has no way to add input to a prompt turn that
// is running; session/cancel then a new prompt would be an interrupt, not a steer).
var ErrSteerUnsupported = errors.New("orchestrator: this turn cannot be steered")

// steerBox holds the ids of queued messages that "send now" asked to inject into
// the running built-in turn. The messages stay in the queue until the turn takes
// them at a tool boundary, so one that is never taken (the turn ends first)
// simply runs next, as the queue's order says.
type steerBox struct {
	mu  sync.Mutex
	ids []string
}

func (b *steerBox) add(id string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if !slices.Contains(b.ids, id) {
		b.ids = append(b.ids, id)
	}
}

func (b *steerBox) take() []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := b.ids
	b.ids = nil
	return out
}

// openSteerBox registers the running built-in turn of a main session (key: skey) as steerable and
// returns the function that unregisters it.
func (o *Orchestrator) openSteerBox(key string) func() {
	b := &steerBox{}
	o.steerMu.Lock()
	o.steer[key] = b
	o.steerMu.Unlock()
	return func() {
		o.steerMu.Lock()
		if o.steer[key] == b {
			delete(o.steer, key)
		}
		o.steerMu.Unlock()
	}
}

func (o *Orchestrator) steerBox(key string) *steerBox {
	o.steerMu.Lock()
	defer o.steerMu.Unlock()
	return o.steer[key]
}

// steerTexts is the loop's Steer hook (the orchestrator's loop only): at a tool
// boundary it takes the queued messages that were sent now, removes them from the
// queue (a message the user deleted meanwhile is skipped, one the user edited is
// sent as edited) and announces each with message.steered. The texts become user
// messages of the conversation.
func (rt *runtime) steerTexts(ctx context.Context) []string {
	box := rt.o.steerBox(rt.key())
	if box == nil {
		return nil
	}
	ids := box.take()
	if len(ids) == 0 {
		return nil
	}
	o := rt.o
	o.qmu.Lock()
	defer o.qmu.Unlock()
	c, cancel := dbCtx(ctx)
	defer cancel()
	q, _, err := rt.db.SessionQueue(c, rt.sessionID)
	if err != nil {
		rt.logErr("read queue to steer", err)
		return nil
	}
	var out []string
	for _, id := range ids {
		i := slices.IndexFunc(q, func(m projectstore.QueuedMessage) bool { return m.ID == id })
		if i < 0 {
			continue
		}
		if err := rt.db.RemoveQueued(c, id); err != nil {
			rt.logErr("dequeue steered message", err)
			continue
		}
		out = append(out, q[i].Text)
		rt.publish(events.MessageSteered, map[string]any{"queue_id": id, "text": q[i].Text})
	}
	if len(out) > 0 {
		o.publishQueue(c, rt.db, rt.sessionID)
	}
	return out
}
