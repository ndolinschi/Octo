package bridge_test

import (
	"math"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/config"
	"github.com/ndolinschi/Octo/apps/harness/internal/fakeacp"
	"github.com/ndolinschi/Octo/apps/harness/internal/limits"
	"github.com/ndolinschi/Octo/apps/harness/internal/mockllm"
	"github.com/ndolinschi/Octo/apps/harness/internal/project"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

const opusOnlyPrices = `
[models."claude-opus-5-5"]
input = 5.0
output = 25.0
`

func usageURL(params map[string]string) string {
	q := url.Values{}
	for k, v := range params {
		q.Set(k, v)
	}
	return "/v1/usage?" + q.Encode()
}

func (s *usageStack) report(t *testing.T, params map[string]string) project.UsageReport {
	t.Helper()
	if _, ok := params["to"]; !ok {
		params["to"] = time.Now().UTC().AddDate(0, 0, 2).Format(time.DateOnly)
	}
	var rep project.UsageReport
	s.into(t, http.MethodGet, usageURL(params), nil, http.StatusOK, &rep)
	return rep
}

func near(a, b float64) bool { return math.Abs(a-b) < 1e-9 }

func assertTotalIsSum(t *testing.T, rep project.UsageReport) {
	t.Helper()
	var sum project.UsageBucket
	var cost float64
	anyCost := false
	for _, b := range rep.Buckets {
		sum.InputTokens += b.InputTokens
		sum.OutputTokens += b.OutputTokens
		sum.CacheReadTokens += b.CacheReadTokens
		sum.CacheWriteTokens += b.CacheWriteTokens
		sum.Requests += b.Requests
		if b.CostUSD != nil {
			anyCost, cost = true, cost+*b.CostUSD
		}
	}
	tot := rep.Total
	if tot.InputTokens != sum.InputTokens || tot.OutputTokens != sum.OutputTokens || tot.CacheReadTokens != sum.CacheReadTokens ||
		tot.CacheWriteTokens != sum.CacheWriteTokens || tot.Requests != sum.Requests {
		t.Errorf("total %+v != sum of buckets %+v", tot, sum)
	}
	if (tot.CostUSD != nil) != anyCost || (anyCost && !near(*tot.CostUSD, cost)) {
		t.Errorf("total cost %v != sum %v (any=%v)", tot.CostUSD, cost, anyCost)
	}
}

// Acceptance 1 and 2: rows per response, per-agent sums equal agent totals,
// all four groupings across projects and for one, totals equal bucket sums.
func TestUsageGroupsAcrossProjects(t *testing.T) {
	s := newUsageStack(t, "", nil)
	pidA := s.runTurn(t, "alpha", "", "Add retry logic to the fetch helper")
	pidB := s.runTurn(t, "beta", "", "a quick question")

	var agentsA struct{ Agents []projectstore.Agent }
	s.into(t, "GET", "/v1/projects/"+pidA+"/agents", nil, http.StatusOK, &agentsA)
	var agentsB struct{ Agents []projectstore.Agent }
	s.into(t, "GET", "/v1/projects/"+pidB+"/agents", nil, http.StatusOK, &agentsB)

	t.Run("agent", func(t *testing.T) {
		rep := s.report(t, map[string]string{"group": "agent", "project": pidA})
		if len(rep.Buckets) != len(agentsA.Agents) {
			t.Fatalf("buckets = %d, agents = %d", len(rep.Buckets), len(agentsA.Agents))
		}
		byKey := map[string]project.UsageBucket{}
		for _, b := range rep.Buckets {
			byKey[b.Key] = b
		}
		for _, a := range agentsA.Agents {
			b, ok := byKey[a.ID]
			if !ok {
				t.Fatalf("no bucket for agent %s", a.ID)
			}
			if b.Label != a.Role || b.InputTokens != a.InputTokens || b.OutputTokens != a.OutputTokens {
				t.Errorf("agent %s: bucket %+v vs totals in=%d out=%d", a.Role, b, a.InputTokens, a.OutputTokens)
			}
			var msgs struct{ Messages []projectstore.Message }
			s.into(t, "GET", "/v1/projects/"+pidA+"/agents/"+a.ID+"/messages", nil, http.StatusOK, &msgs)
			responses := int64(0)
			for _, m := range msgs.Messages {
				if m.Role == "assistant" {
					responses++
				}
			}
			if b.Requests != responses {
				t.Errorf("agent %s: %d usage rows for %d model responses", a.Role, b.Requests, responses)
			}
		}
		assertTotalIsSum(t, rep)
	})

	t.Run("project across projects", func(t *testing.T) {
		rep := s.report(t, map[string]string{"group": "project"})
		if len(rep.Buckets) != 2 {
			t.Fatalf("buckets = %+v", rep.Buckets)
		}
		labels := map[string]string{}
		for _, b := range rep.Buckets {
			labels[b.Key] = b.Label
			if b.InputTokens == 0 || b.Requests == 0 {
				t.Errorf("empty bucket %+v", b)
			}
		}
		if labels[pidA] != "alpha" || labels[pidB] != "beta" {
			t.Fatalf("labels = %v", labels)
		}
		assertTotalIsSum(t, rep)
		one := s.report(t, map[string]string{"group": "project", "project": pidB})
		if len(one.Buckets) != 1 || one.Buckets[0].Key != pidB {
			t.Fatalf("narrowed = %+v", one.Buckets)
		}
	})

	t.Run("model", func(t *testing.T) {
		rep := s.report(t, map[string]string{"group": "model"})
		models := config.DefaultModels()
		got := map[string]bool{}
		for _, b := range rep.Buckets {
			got[b.Key] = true
			if b.Label != b.Key {
				t.Errorf("model label %q != key %q", b.Label, b.Key)
			}
		}
		for _, m := range []string{models.Orchestrator, models.Fast, models.Balanced} {
			if !got[m] {
				t.Errorf("no bucket for %s in %+v", m, rep.Buckets)
			}
		}
		assertTotalIsSum(t, rep)
	})

	t.Run("day", func(t *testing.T) {
		rep := s.report(t, map[string]string{"group": "day"})
		today := time.Now().UTC().Format(time.DateOnly)
		if len(rep.Buckets) < 1 || rep.Buckets[len(rep.Buckets)-1].Key != today && rep.Buckets[0].Key != today {
			t.Fatalf("buckets = %+v, want today %s", rep.Buckets, today)
		}
		def := s.report(t, map[string]string{"group": ""})
		if def.Group != "day" {
			t.Errorf("default group = %q", def.Group)
		}
		assertTotalIsSum(t, rep)
		var in int64
		for _, a := range append(agentsA.Agents, agentsB.Agents...) {
			in += a.InputTokens
		}
		if rep.Total.InputTokens != in {
			t.Errorf("total input %d != sum of agent totals %d", rep.Total.InputTokens, in)
		}
	})
}

// Acceptance 3: estimated cost with a price table, null without, and a model
// missing from the table does not zero (or null) a bucket that has priced parts.
func TestUsageCostFromPriceTable(t *testing.T) {
	models := config.DefaultModels()
	t.Run("with prices", func(t *testing.T) {
		s := newUsageStack(t, opusOnlyPrices, nil)
		s.runTurn(t, "alpha", "", "Add retry logic to the fetch helper")
		byModel := map[string]project.UsageBucket{}
		for _, b := range s.report(t, map[string]string{"group": "model"}).Buckets {
			byModel[b.Key] = b
		}
		opus := byModel[models.Orchestrator]
		if opus.CostUSD == nil || !opus.CostEstimated {
			t.Fatalf("priced model bucket = %+v", opus)
		}
		if want := (float64(opus.InputTokens)*5 + float64(opus.OutputTokens)*25) / 1e6; !near(*opus.CostUSD, want) {
			t.Errorf("cost = %v, want tokens x prices = %v", *opus.CostUSD, want)
		}
		for _, m := range []string{models.Fast, models.Balanced} {
			if b := byModel[m]; b.CostUSD != nil || b.CostEstimated {
				t.Errorf("unpriced model %s bucket = %+v, want null cost", m, b)
			}
		}
		day := s.report(t, map[string]string{"group": "day"})
		if day.Total.CostUSD == nil || !near(*day.Total.CostUSD, *opus.CostUSD) || !day.Total.CostEstimated {
			t.Errorf("mixed bucket must carry the priced part only: %+v vs %+v", day.Total, opus)
		}
		assertTotalIsSum(t, day)
	})
	t.Run("without prices", func(t *testing.T) {
		s := newUsageStack(t, "", nil)
		s.runTurn(t, "alpha", "", "a quick question")
		rep := s.report(t, map[string]string{"group": "model"})
		if len(rep.Buckets) == 0 {
			t.Fatal("no usage recorded")
		}
		for _, b := range append(rep.Buckets, rep.Total) {
			if b.CostUSD != nil || b.CostEstimated {
				t.Errorf("bucket %+v has a cost without a price table", b)
			}
		}
	})
	t.Run("malformed table is treated as missing", func(t *testing.T) {
		s := newUsageStackLenient(t, "[models.x]\ninput = nope\n")
		s.runTurn(t, "alpha", "", "a quick question")
		if rep := s.report(t, map[string]string{"group": "model"}); rep.Total.CostUSD != nil {
			t.Errorf("total = %+v", rep.Total)
		}
	})
}

func TestUsageEmptyRangeAndBadParameters(t *testing.T) {
	s := newUsageStack(t, "", nil)
	s.into(t, "GET", "/v1/usage", nil, http.StatusOK, &project.UsageReport{}) // no projects at all
	s.runTurn(t, "alpha", "", "a quick question")

	var raw map[string]any
	s.into(t, "GET", "/v1/usage?from=2001-01-01&to=2001-01-02&group=model", nil, http.StatusOK, &raw)
	if b, ok := raw["buckets"].([]any); !ok || len(b) != 0 {
		t.Fatalf("buckets = %#v, want []", raw["buckets"])
	}
	var empty project.UsageReport
	s.into(t, "GET", "/v1/usage?from=2001-01-01&to=2001-01-02", nil, http.StatusOK, &empty)
	if empty.Total.Requests != 0 || empty.Total.CostUSD != nil || empty.From != "2001-01-01T00:00:00Z" || empty.To != "2001-01-02T00:00:00Z" {
		t.Fatalf("empty report = %+v", empty)
	}

	// `to` is exclusive and RFC 3339 is accepted.
	now := time.Now().UTC()
	rep := s.report(t, map[string]string{"from": now.Add(-time.Hour).Format(time.RFC3339), "to": now.Add(time.Hour).Format(time.RFC3339)})
	if rep.Total.Requests == 0 {
		t.Fatalf("RFC 3339 range missed today's usage: %+v", rep)
	}
	if rep := s.report(t, map[string]string{"from": now.Add(-48 * time.Hour).Format(time.DateOnly), "to": now.Add(-24 * time.Hour).Format(time.DateOnly)}); rep.Total.Requests != 0 {
		t.Fatalf("past range returned usage: %+v", rep.Total)
	}

	for _, tc := range []struct {
		name, query string
		status      int
		code        string
	}{
		{"bad group", "group=week", 400, "invalid_request"},
		{"bad from", "from=yesterday", 400, "invalid_request"},
		{"bad to", "to=2026-13-45", 400, "invalid_request"},
		{"from after to", "from=2026-11-10&to=2026-11-01", 400, "invalid_request"},
		{"unknown project", "project=prj_nope", 404, "not_found"},
	} {
		t.Run(tc.name, func(t *testing.T) { s.wantError(t, "GET", "/v1/usage?"+tc.query, nil, tc.status, tc.code) })
	}
}

// Acceptance 4 and 6: the mock's headers show up in /v1/limits, in both
// styles; no headers means no entries; a later response replaces earlier values.
func TestLimitsEndpoint(t *testing.T) {
	type resp struct{ Limits []limits.Limit }
	get := func(t *testing.T, s *usageStack) resp {
		t.Helper()
		var r resp
		s.into(t, "GET", "/v1/limits", nil, http.StatusOK, &r)
		return r
	}
	kinds := func(r resp) map[limits.Kind]limits.Limit {
		m := map[limits.Kind]limits.Limit{}
		for _, l := range r.Limits {
			m[l.Kind] = l
		}
		return m
	}

	t.Run("anthropic style, replaced by the next response", func(t *testing.T) {
		s := newUsageStack(t, "", nil)
		if got := get(t, s); got.Limits == nil || len(got.Limits) != 0 {
			t.Fatalf("before any request: %+v (want an empty list)", got)
		}
		pid := s.runTurn(t, "alpha", "", "a quick question")
		first := get(t, s)
		k := kinds(first)
		if len(first.Limits) != 4 || k[limits.Requests].Limit == nil || *k[limits.Requests].Limit != 50 {
			t.Fatalf("limits = %+v", first.Limits)
		}
		l := k[limits.Requests]
		if l.Provider != s.llmHost || l.Model != config.DefaultModels().Orchestrator || l.ResetsAt == nil || l.Remaining == nil {
			t.Fatalf("requests limit = %+v (host %s)", l, s.llmHost)
		}
		if _, err := time.Parse(time.RFC3339, *l.ResetsAt); err != nil {
			t.Errorf("resets_at = %q: %v", *l.ResetsAt, err)
		}
		before := *l.Remaining
		s.post(t, pid, "another quick question")
		after := kinds(get(t, s))[limits.Requests]
		if after.Remaining == nil || *after.Remaining >= before {
			t.Errorf("remaining %d then %v; the later response must replace the earlier", before, after.Remaining)
		}
	})
	t.Run("x-ratelimit style with duration resets", func(t *testing.T) {
		s := newUsageStack(t, "", nil, mockllm.WithRateLimitStyle(mockllm.StyleOpenAI))
		s.runTurn(t, "alpha", "", "a quick question")
		got := get(t, s)
		k := kinds(got)
		if len(got.Limits) != 2 || k[limits.Requests].Limit == nil || k[limits.Tokens].Limit == nil {
			t.Fatalf("limits = %+v", got.Limits)
		}
		for _, l := range got.Limits {
			obs, err1 := time.Parse(time.RFC3339, l.ObservedAt)
			reset, err2 := time.Parse(time.RFC3339, *l.ResetsAt)
			if err1 != nil || err2 != nil || !reset.After(obs) {
				t.Errorf("limit %+v: reset must be observed_at plus the duration", l)
			}
		}
	})
	t.Run("no headers, no entries", func(t *testing.T) {
		s := newUsageStack(t, "", nil, mockllm.WithRateLimitStyle(mockllm.StyleNone))
		s.runTurn(t, "alpha", "", "a quick question")
		if got := get(t, s); got.Limits == nil || len(got.Limits) != 0 {
			t.Fatalf("limits = %+v", got)
		}
	})
}

// Acceptance 5 at the HTTP level: context fields and the USD cost increase.
func TestACPUsageOverHTTP(t *testing.T) {
	s := newUsageStack(t, "", fakeACPRegistry(t))
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("# usage\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	pid := s.runTurn(t, "acp", dir, "[acp] summarize this repo")
	var agents struct{ Agents []projectstore.Agent }
	s.into(t, "GET", "/v1/projects/"+pid+"/agents", nil, http.StatusOK, &agents)
	var child projectstore.Agent
	for _, a := range agents.Agents {
		if a.Model == "acp:fake" {
			child = a
		}
	}
	if child.ContextUsed == nil || *child.ContextUsed != 1800 || child.ContextSize == nil || *child.ContextSize != 200000 {
		t.Fatalf("context = %v / %v, want 1800 / 200000", child.ContextUsed, child.ContextSize)
	}
	rep := s.report(t, map[string]string{"group": "agent", "project": pid})
	var b *project.UsageBucket
	for i := range rep.Buckets {
		if rep.Buckets[i].Key == child.ID {
			b = &rep.Buckets[i]
		}
	}
	if b == nil || b.CostUSD == nil || !near(*b.CostUSD, fakeacp.CostAfterEdit) || b.CostEstimated || b.InputTokens != 1800 {
		t.Fatalf("acp agent bucket = %+v, want cost %v reported (not estimated)", b, fakeacp.CostAfterEdit)
	}
	var orch *projectstore.Agent
	for i := range agents.Agents {
		if agents.Agents[i].ParentID == nil {
			orch = &agents.Agents[i]
		}
	}
	if orch.ContextUsed != nil || orch.ContextSize != nil {
		t.Errorf("API agents have no context fields: %v / %v", orch.ContextUsed, orch.ContextSize)
	}
}
