package mockllm

import (
	"crypto/sha256"
	"encoding/json"
	"sync"
)

// lookback is how many blocks before a breakpoint the real API checks for an
// earlier cache entry; the mock does the same so a breakpoint that moved by one
// turn still finds the previous one.
const lookback = 20

// cacheStore mimics Anthropic's prompt cache: a set of prefix hashes written by
// earlier requests. The prefix order is tools, system, messages; a prefix ends
// at a block and is hashed with cache_control markers removed (the markers do
// not take part in cache keys).
type cacheStore struct {
	mu   sync.Mutex
	seen map[[sha256.Size]byte]struct{}
}

type usageNumbers struct {
	Input, Output, CacheRead, CacheWrite int
}

// element is one block of the flattened prefix.
type element struct {
	data   []byte // canonical JSON, cache_control removed
	marked bool   // carried a cache_control breakpoint
}

// flatten lists the request's blocks in cache order.
func flatten(body []byte) []element {
	var raw struct {
		Model    string            `json:"model"`
		Tools    []json.RawMessage `json:"tools"`
		System   json.RawMessage   `json:"system"`
		Messages []struct {
			Role    string          `json:"role"`
			Content json.RawMessage `json:"content"`
		} `json:"messages"`
	}
	if json.Unmarshal(body, &raw) != nil {
		return nil
	}
	// The cache is per model: the same prefix on another model is a miss.
	out := []element{{data: []byte("model:" + raw.Model)}}
	for _, t := range raw.Tools {
		out = append(out, canonical("tool", t))
	}
	for _, b := range blocksOf(raw.System) {
		out = append(out, canonical("system", b))
	}
	for _, m := range raw.Messages {
		for _, b := range blocksOf(m.Content) {
			out = append(out, canonical(m.Role, b))
		}
	}
	return out
}

// blocksOf splits string or array content into per-block JSON.
func blocksOf(content json.RawMessage) []json.RawMessage {
	if len(content) == 0 || string(content) == "null" {
		return nil
	}
	var arr []json.RawMessage
	if json.Unmarshal(content, &arr) == nil {
		return arr
	}
	return []json.RawMessage{content}
}

func canonical(kind string, raw json.RawMessage) element {
	var v any
	if json.Unmarshal(raw, &v) != nil {
		return element{data: append([]byte(kind+":"), raw...)}
	}
	marked := false
	if m, ok := v.(map[string]any); ok {
		if _, marked = m["cache_control"]; marked {
			delete(m, "cache_control")
		}
	}
	data, err := json.Marshal(v)
	if err != nil {
		data = raw
	}
	return element{data: append([]byte(kind+":"), data...), marked: marked}
}

// elementTokens is the mock's token count of one block, independent of what
// follows it, so a prefix costs the same in every request that contains it.
func elementTokens(e element) int { return len(e.data)/4 + 1 }

// account turns the request's breakpoints into usage numbers. total is the
// request's input token estimate (raised to the sum of its blocks when that is
// larger). Without breakpoints the cache fields are zero and input is total.
func (c *cacheStore) account(body []byte, total int) (read, write, input int) {
	els := flatten(body)
	var marks []int
	for i, e := range els {
		if e.marked {
			marks = append(marks, i)
		}
	}
	if len(marks) == 0 {
		return 0, 0, total
	}
	hashes := make([][sha256.Size]byte, len(els))
	ends := make([]int, len(els)) // cumulative tokens through element i
	h := sha256.New()
	sum := 0
	for i, e := range els {
		h.Write(e.data)
		sum += elementTokens(e)
		ends[i] = sum
		copy(hashes[i][:], h.Sum(nil))
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	if c.seen == nil {
		c.seen = map[[sha256.Size]byte]struct{}{}
	}
	readAt := -1
	for _, b := range marks {
		for i := b; i >= 0 && i > b-lookback; i-- {
			if _, ok := c.seen[hashes[i]]; ok {
				readAt = max(readAt, i)
				break
			}
		}
	}
	last := marks[len(marks)-1]
	total = max(total, sum)
	tokens := func(i int) int {
		if i < 0 {
			return 0
		}
		return ends[i]
	}
	read = tokens(readAt)
	write = max(tokens(last)-read, 0)
	for _, b := range marks {
		c.seen[hashes[b]] = struct{}{}
	}
	return read, write, max(total-read-write, 0)
}
