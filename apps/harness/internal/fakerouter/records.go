package fakerouter

import (
	"net/http"
)

func (r *Router) callRecord(w http.ResponseWriter, id string) {
	r.mu.Lock()
	rec := r.records[id]
	ready := rec != nil && rec.complete && !r.opts.NoRecords
	if ready {
		rec.fetched++
		ready = rec.fetched > r.opts.NotReady
	}
	r.mu.Unlock()
	if !ready {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "not ready"})
		return
	}
	writeJSON(w, http.StatusOK, rec.body)
}

// finishCall records the request and, once its response is complete, its call record.
func (r *Router) finishCall(e Request, key string, in, out int) {
	rate, ok := r.opts.Rates[e.Tier]
	if !ok {
		rate = [2]float64{3, 15}
	}
	cost := (float64(in)*rate[0] + float64(out)*rate[1]) / 1e6
	source := r.opts.CostSource
	if r.opts.Unpriced {
		cost, source = 0, "estimated"
	}
	e.Status = max(e.Status, http.StatusOK)
	r.mu.Lock()
	defer r.mu.Unlock()
	r.requests = append(r.requests, e)
	r.spent[key] += cost
	if e.Trigger == "classifier" {
		r.spent[key] += r.opts.ClassifierUSD
	}
	r.records[e.ID] = &record{complete: true, body: map[string]any{
		"model": e.Served, "tier": e.Tier, "trigger": e.Trigger,
		"input_tokens": in, "output_tokens": out, "cache_read_tokens": 0, "cache_write_tokens": 0,
		"cost_usd": cost, "cost_source": source,
	}}
	if r.opts.SpentAfter {
		r.records[e.ID].body["spent_after_usd"] = r.spent[key]
	}
}

// decide is the fake's routing: its classifier always says mid. Under fixed the
// hint's tier is served, under ceiling the lower of hint and classifier, under
// auto (the default) the classifier's tier, which may be above the hint.
func decide(h http.Header) (tier, trigger string) {
	hint, ok := hintTier[h.Get("x-octo-tier-hint")]
	if !ok {
		return "mid", "classifier"
	}
	switch h.Get("x-octo-tier-policy") {
	case "fixed":
		return hint, "hint"
	case "ceiling":
		if tierRank[hint] < tierRank["mid"] {
			return hint, "classifier"
		}
		return "mid", "classifier"
	}
	return "mid", "classifier"
}
