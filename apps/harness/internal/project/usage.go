package project

import (
	"cmp"
	"context"
	"slices"
	"strings"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/prices"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

const defaultUsageDays = 30

// UsageQuery is GET /v1/usage as received: every field is the raw parameter.
type UsageQuery struct {
	From, To  string
	Group     string
	ProjectID string
}

type UsageBucket struct {
	Key              string   `json:"key"`
	Label            string   `json:"label"`
	InputTokens      int64    `json:"input_tokens"`
	OutputTokens     int64    `json:"output_tokens"`
	CacheReadTokens  int64    `json:"cache_read_tokens"`
	CacheWriteTokens int64    `json:"cache_write_tokens"`
	Requests         int64    `json:"requests"`
	CostUSD          *float64 `json:"cost_usd"`
	CostEstimated    bool     `json:"cost_estimated"`
}

type UsageReport struct {
	From    string        `json:"from"`
	To      string        `json:"to"`
	Group   string        `json:"group"`
	Buckets []UsageBucket `json:"buckets"`
	Total   UsageBucket   `json:"total"`
}

// Usage aggregates usage rows across all projects, or one when q.ProjectID is set.
func (s *Service) Usage(ctx context.Context, q UsageQuery) (UsageReport, error) {
	group, from, to, err := s.usageRange(q)
	if err != nil {
		return UsageReport{}, err
	}
	dbs, err := s.usageDBs(ctx, q.ProjectID)
	if err != nil {
		return UsageReport{}, err
	}
	fromS, toS := projectstore.Stamp(from), projectstore.Stamp(to)
	acc := map[string]*UsageBucket{}
	cost := map[string]*costSum{}
	var keys []string
	for _, db := range dbs {
		rows, err := db.UsageRows(ctx, fromS, toS, group)
		if err != nil {
			return UsageReport{}, err
		}
		for _, r := range rows {
			b, ok := acc[r.Key]
			if !ok {
				b, cost[r.Key] = &UsageBucket{Key: r.Key, Label: r.Label}, &costSum{}
				acc[r.Key] = b
				keys = append(keys, r.Key)
			}
			addRow(b, cost[r.Key], r, s.prices)
		}
	}
	rep := UsageReport{
		From: from.Format(time.RFC3339), To: to.Format(time.RFC3339), Group: string(group),
		Buckets: make([]UsageBucket, 0, len(keys)),
		Total:   UsageBucket{Key: "total", Label: "Total"},
	}
	var totalCost costSum
	for _, k := range keys {
		b := acc[k]
		cost[k].apply(b)
		totalCost.merge(*cost[k])
		rep.Buckets = append(rep.Buckets, *b)
		sumTokens(&rep.Total, *b)
	}
	totalCost.apply(&rep.Total)
	sortBuckets(rep.Buckets, group)
	return rep, nil
}

func (s *Service) usageRange(q UsageQuery) (projectstore.UsageGroup, time.Time, time.Time, error) {
	group := projectstore.UsageGroup(q.Group)
	if q.Group == "" {
		group = projectstore.GroupDay
	}
	if !group.Valid() {
		return "", time.Time{}, time.Time{}, invalid("group must be day, model, project or agent")
	}
	var from, to time.Time
	var err error
	if q.To != "" {
		if to, err = parseUsageTime("to", q.To); err != nil {
			return "", from, to, err
		}
	} else {
		tomorrow := s.now().UTC().AddDate(0, 0, 1)
		to = time.Date(tomorrow.Year(), tomorrow.Month(), tomorrow.Day(), 0, 0, 0, 0, time.UTC)
	}
	if q.From != "" {
		if from, err = parseUsageTime("from", q.From); err != nil {
			return "", from, to, err
		}
	} else {
		from = to.AddDate(0, 0, -defaultUsageDays)
	}
	if from.After(to) {
		return "", from, to, invalid("from must not be after to")
	}
	return group, from, to, nil
}

// parseUsageTime accepts RFC 3339 or a UTC day (YYYY-MM-DD).
func parseUsageTime(name, v string) (time.Time, error) {
	if t, err := time.Parse(time.RFC3339, v); err == nil {
		return t.UTC(), nil
	}
	if t, err := time.Parse(time.DateOnly, v); err == nil {
		return t, nil
	}
	return time.Time{}, invalid("%s must be RFC 3339 or YYYY-MM-DD", name)
}

func (s *Service) usageDBs(ctx context.Context, pid string) ([]*projectstore.DB, error) {
	if pid != "" {
		db, err := s.db(ctx, pid)
		if err != nil {
			return nil, err
		}
		return []*projectstore.DB{db}, nil
	}
	ids, err := s.store.IDs(ctx)
	if err != nil {
		return nil, err
	}
	dbs := make([]*projectstore.DB, 0, len(ids))
	for _, id := range ids {
		db, err := s.db(ctx, id)
		if err != nil {
			return nil, err
		}
		dbs = append(dbs, db)
	}
	return dbs, nil
}

// costSum tracks a bucket's cost: source-reported parts are summed as they
// are; API rows without one are estimated from the price table when the model
// has a price. A bucket with neither has no cost (nil, never zero).
type costSum struct {
	usd       float64
	any       bool
	estimated bool
}

func (c *costSum) merge(o costSum) {
	c.usd += o.usd
	c.any = c.any || o.any
	c.estimated = c.estimated || o.estimated
}

func (c costSum) apply(b *UsageBucket) {
	if c.any {
		v := c.usd
		b.CostUSD = &v
	}
	b.CostEstimated = c.estimated
}

func addRow(b *UsageBucket, c *costSum, r projectstore.UsageRow, tab prices.Table) {
	b.InputTokens += r.InputTokens
	b.OutputTokens += r.OutputTokens
	b.CacheReadTokens += r.CacheReadTokens
	b.CacheWriteTokens += r.CacheWriteTokens
	b.Requests += r.Requests
	switch {
	case r.Reported:
		c.usd += r.ReportedCostUSD
		c.any = true
	case r.Source == projectstore.SourceAPI:
		est, ok := tab.Estimate(r.Model, prices.Tokens{
			Input: r.InputTokens, Output: r.OutputTokens, CacheRead: r.CacheReadTokens, CacheWrite: r.CacheWriteTokens,
		})
		if ok {
			c.usd += est
			c.any, c.estimated = true, true
		}
	}
}

func sumTokens(t *UsageBucket, b UsageBucket) {
	t.InputTokens += b.InputTokens
	t.OutputTokens += b.OutputTokens
	t.CacheReadTokens += b.CacheReadTokens
	t.CacheWriteTokens += b.CacheWriteTokens
	t.Requests += b.Requests
}

// sortBuckets orders days oldest first and the other groups by tokens, largest first.
func sortBuckets(bs []UsageBucket, g projectstore.UsageGroup) {
	slices.SortFunc(bs, func(a, b UsageBucket) int {
		if g == projectstore.GroupDay {
			return strings.Compare(a.Key, b.Key)
		}
		return cmp.Or(cmp.Compare(b.InputTokens+b.OutputTokens, a.InputTokens+a.OutputTokens), strings.Compare(a.Key, b.Key))
	})
}
