package plugins

import "time"

// limitNow is the clock of the limit state; tests replace it.
var limitNow = time.Now

// SeenLimit records what a real session of the agent found about its usage
// limit: reached marks the agent as having hit it (resetsAt, when known, is
// when it lifts), !reached clears the mark (a turn that ran, or a recheck).
// It reports whether the recorded state changed. An unknown id is ignored.
func (r *Registry) SeenLimit(id string, resetsAt *time.Time, reached bool) bool {
	if r == nil {
		return false
	}
	// seenMu is taken before the id is looked up: forget (which runs after
	// SetAccounts swaps the view) takes it too, so a limit can never be
	// recorded for an id that is gone after forget has run.
	r.seenMu.Lock()
	defer r.seenMu.Unlock()
	if !r.has(id) {
		return false
	}
	old, had := r.limits[id]
	if !reached {
		if had {
			delete(r.limits, id)
		}
		return had
	}
	if had && sameTime(old.ResetsAt, resetsAt) {
		return false
	}
	if r.limits == nil {
		r.limits = map[string]LimitState{}
	}
	st := LimitState{ReachedAt: limitNow().UTC()}
	if resetsAt != nil {
		t := resetsAt.UTC()
		st.ResetsAt = &t
	}
	r.limits[id] = st
	return true
}

// limitOf is the agent's recorded limit, nil when none or when its reset time has passed.
func (r *Registry) limitOf(id string) *LimitState {
	r.seenMu.Lock()
	defer r.seenMu.Unlock()
	st, ok := r.limits[id]
	if !ok {
		return nil
	}
	if st.ResetsAt != nil && !limitNow().Before(*st.ResetsAt) {
		delete(r.limits, id)
		return nil
	}
	out := st
	if st.ResetsAt != nil {
		t := *st.ResetsAt
		out.ResetsAt = &t
	}
	return &out
}

func sameTime(a, b *time.Time) bool {
	if a == nil || b == nil {
		return a == b
	}
	return a.Equal(*b)
}
