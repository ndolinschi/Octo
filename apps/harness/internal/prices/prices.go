// Package prices reads the harness's own optional price table (prices.toml in
// the data directory) and turns token counts into an estimated USD cost. It
// never reads the router's price file.
package prices

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"strconv"
	"strings"
)

// File is the table's name inside the data directory.
const File = "prices.toml"

const perMillion = 1_000_000

// Default cache price multipliers, applied to a model's input price when its
// entry has no cache_read / cache_write. They follow Anthropic's published
// ratios (a cache read costs 0.1x input, a 5-minute cache write 1.25x) and are
// an assumption, not data: an explicit cache_read / cache_write in prices.toml
// always overrides them, and a provider with other ratios needs those keys.
const (
	DefaultCacheReadMultiplier  = 0.1
	DefaultCacheWriteMultiplier = 1.25
)

// Price is USD per one million tokens. Cache prices are optional: a missing
// cache_read is estimated at DefaultCacheReadMultiplier x Input and a missing
// cache_write at DefaultCacheWriteMultiplier x Input.
type Price struct {
	Input      float64
	Output     float64
	CacheRead  *float64
	CacheWrite *float64
}

// Table maps a model id to its price. The zero value has no prices.
type Table struct{ models map[string]Price }

// Tokens are the counts a cost is estimated from.
type Tokens struct{ Input, Output, CacheRead, CacheWrite int64 }

// Estimate returns the USD cost of the tokens; ok is false when the model has
// no price (a cost is then unknown, not zero).
func (t Table) Estimate(model string, tok Tokens) (float64, bool) {
	p, ok := t.models[model]
	if !ok {
		return 0, false
	}
	cacheRead, cacheWrite := p.Input*DefaultCacheReadMultiplier, p.Input*DefaultCacheWriteMultiplier
	if p.CacheRead != nil {
		cacheRead = *p.CacheRead
	}
	if p.CacheWrite != nil {
		cacheWrite = *p.CacheWrite
	}
	usd := float64(tok.Input)*p.Input + float64(tok.Output)*p.Output +
		float64(tok.CacheRead)*cacheRead + float64(tok.CacheWrite)*cacheWrite
	return usd / perMillion, true
}

// Len is the number of priced models.
func (t Table) Len() int { return len(t.models) }

// Load reads path. A missing file is an empty table with no error; a malformed
// one yields an empty table and the parse error, for the caller to log.
func Load(path string) (Table, error) {
	raw, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return Table{}, nil
	}
	if err != nil {
		return Table{}, err
	}
	t, err := Parse(string(raw))
	if err != nil {
		return Table{}, fmt.Errorf("%s: %w", path, err)
	}
	return t, nil
}

// Parse reads the TOML subset the price file uses: `[models."id"]` tables
// (the id may be unquoted when it is a bare key) holding `key = number` lines
// and `#` comments. Keys: input and output (required), cache_read and
// cache_write (optional); unknown keys are ignored.
func Parse(src string) (Table, error) {
	models := map[string]Price{}
	var cur *Price
	var curID string
	var seen map[string]bool
	finish := func() error {
		if cur == nil {
			return nil
		}
		if !seen["input"] || !seen["output"] {
			return fmt.Errorf("model %q needs input and output prices", curID)
		}
		models[curID] = *cur
		return nil
	}
	for n, line := range strings.Split(src, "\n") {
		line = strings.TrimSpace(stripComment(line))
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "[") {
			if err := finish(); err != nil {
				return Table{}, err
			}
			id, err := parseHeader(line)
			if err != nil {
				return Table{}, fmt.Errorf("line %d: %w", n+1, err)
			}
			if _, dup := models[id]; dup {
				return Table{}, fmt.Errorf("line %d: model %q defined twice", n+1, id)
			}
			cur, curID, seen = &Price{}, id, map[string]bool{}
			continue
		}
		if cur == nil {
			return Table{}, fmt.Errorf("line %d: key outside a [models.\"id\"] table", n+1)
		}
		if err := setKey(cur, seen, line); err != nil {
			return Table{}, fmt.Errorf("line %d: %w", n+1, err)
		}
	}
	if err := finish(); err != nil {
		return Table{}, err
	}
	return Table{models: models}, nil
}

func stripComment(line string) string {
	inQuote := false
	for i, r := range line {
		switch {
		case r == '"':
			inQuote = !inQuote
		case r == '#' && !inQuote:
			return line[:i]
		}
	}
	return line
}

func parseHeader(line string) (string, error) {
	inner, ok := strings.CutSuffix(strings.TrimPrefix(line, "["), "]")
	if !ok {
		return "", errors.New("unterminated table header")
	}
	rest, ok := strings.CutPrefix(strings.TrimSpace(inner), "models.")
	if !ok {
		return "", errors.New("only [models.\"id\"] tables are allowed")
	}
	rest = strings.TrimSpace(rest)
	if strings.HasPrefix(rest, `"`) {
		id, ok := strings.CutSuffix(strings.TrimPrefix(rest, `"`), `"`)
		if !ok || id == "" || strings.ContainsAny(id, `"\`) {
			return "", errors.New("bad quoted model id")
		}
		return id, nil
	}
	if rest == "" || strings.Trim(rest, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-") != "" {
		return "", errors.New("model id with other characters must be quoted")
	}
	return rest, nil
}

func setKey(p *Price, seen map[string]bool, line string) error {
	key, val, ok := strings.Cut(line, "=")
	if !ok {
		return errors.New("want key = number")
	}
	key = strings.TrimSpace(key)
	f, err := strconv.ParseFloat(strings.TrimSpace(strings.ReplaceAll(val, "_", "")), 64)
	if err != nil || f < 0 {
		return fmt.Errorf("%s: want a non-negative number", key)
	}
	switch key {
	case "input":
		p.Input = f
	case "output":
		p.Output = f
	case "cache_read":
		p.CacheRead = &f
	case "cache_write":
		p.CacheWrite = &f
	}
	seen[key] = true
	return nil
}
