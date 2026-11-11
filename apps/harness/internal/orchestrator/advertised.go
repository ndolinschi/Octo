package orchestrator

import (
	"slices"
	"sync"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/acp"
)

// AdvertisedModel is a model an ACP agent offered in a session.
type AdvertisedModel = acp.AdvertisedModel

// Advertised is what an agent said its sessions can use the last time one
// was opened, and when.
type Advertised struct {
	Models  []AdvertisedModel
	Current string
	SeenAt  time.Time
}

type advertisedStore struct {
	mu       sync.Mutex
	byAgent  map[string]Advertised
	onChange []func(agentID string)
}

// AdvertisedModels returns the models agentID advertised in its last session
// (session/new config option or model list), with the one it was using and
// the time seen; ok is false until a session of that agent has been opened by
// this process. The harness keeps no history: a model that is no longer in the
// list is the caller's to flag stale.
func (o *Orchestrator) AdvertisedModels(agentID string) (Advertised, bool) {
	o.adv.mu.Lock()
	defer o.adv.mu.Unlock()
	a, ok := o.adv.byAgent[agentID]
	a.Models = slices.Clone(a.Models)
	return a, ok
}

// OnAdvertisedModels registers fn, called (on the goroutine that opened the
// session) with the agent id each time an agent's advertised list differs
// from the one before, the first time included.
func (o *Orchestrator) OnAdvertisedModels(fn func(agentID string)) {
	o.adv.mu.Lock()
	defer o.adv.mu.Unlock()
	o.adv.onChange = append(o.adv.onChange, fn)
}

func (o *Orchestrator) noteAdvertised(agentID string, models []AdvertisedModel, current string) {
	o.adv.mu.Lock()
	if o.adv.byAgent == nil {
		o.adv.byAgent = map[string]Advertised{}
	}
	prev, had := o.adv.byAgent[agentID]
	o.adv.byAgent[agentID] = Advertised{Models: slices.Clone(models), Current: current, SeenAt: time.Now()}
	changed := !had || !slices.Equal(prev.Models, models)
	fns := slices.Clone(o.adv.onChange)
	o.adv.mu.Unlock()
	if changed {
		for _, fn := range fns {
			fn(agentID)
		}
	}
}
