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
	// inUse counts running sub-agent processes per agent id.
	inUse map[string]int
}

// running notes a sub-agent process of agentID and returns the function that
// ends the note.
func (s *advertisedStore) running(agentID string) func() {
	s.mu.Lock()
	if s.inUse == nil {
		s.inUse = map[string]int{}
	}
	s.inUse[agentID]++
	s.mu.Unlock()
	return func() {
		s.mu.Lock()
		s.inUse[agentID]--
		s.mu.Unlock()
	}
}

// AgentInUse reports whether a process of the ACP agent is running for a
// project (an orchestrator session or a sub-agent). Model discovery leaves such
// an agent alone: its live session already reports its models.
func (o *Orchestrator) AgentInUse(agentID string) bool {
	o.adv.mu.Lock()
	n := o.adv.inUse[agentID]
	o.adv.mu.Unlock()
	if n > 0 {
		return true
	}
	o.acp.mu.Lock()
	all := make([]*orchSession, 0, len(o.acp.sessions))
	for _, s := range o.acp.sessions {
		all = append(all, s)
	}
	o.acp.mu.Unlock()
	for _, s := range all {
		s.mu.Lock()
		live := s.client != nil && s.pluginID == agentID
		s.mu.Unlock()
		if live {
			return true
		}
	}
	return false
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
