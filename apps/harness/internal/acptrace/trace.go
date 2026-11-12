// Package acptrace is the opt-in wire trace of ACP sessions: one JSON-lines
// file per agent process under {data-dir}/traces/, every message the harness
// sends to the agent and every line it gets back, with a timestamp and the
// direction. Off by default (HARNESS_ACP_TRACE=1, or the setting of the same
// name). Environment values, bearer tokens and anything named like a secret
// are redacted before a line is written; a file is capped (oldest lines are
// dropped) and so is the number of files. Its purpose is to diagnose a failed
// run with a real CLI from the file.
package acptrace

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	// MaxFileBytes caps one trace file; past it the oldest lines are dropped.
	MaxFileBytes = 5 << 20
	// MaxFiles caps the number of trace files kept; the oldest files go.
	MaxFiles = 20
	// Redacted replaces a value.
	Redacted = "[redacted]"
)

var (
	enabled atomic.Bool
	dirPath atomic.Pointer[string]
	counter atomic.Int64
)

// Configure sets where trace files go (the data directory) and whether
// tracing is on. Safe to call at any time; sessions started earlier keep what
// they decided at their start.
func Configure(dataDir string, on bool) {
	d := filepath.Join(dataDir, "traces")
	dirPath.Store(&d)
	enabled.Store(on)
}

var (
	everywhereMu sync.Mutex
	everywhere   []string
)

// HideEverywhere makes every trace redact v, whichever process it belongs to
// (the harness's own bridge API token). Values under 8 bytes are ignored.
func HideEverywhere(v string) {
	if len(v) < 8 {
		return
	}
	everywhereMu.Lock()
	defer everywhereMu.Unlock()
	everywhere = append(everywhere, v)
}

func hiddenEverywhere() []string {
	everywhereMu.Lock()
	defer everywhereMu.Unlock()
	return append([]string(nil), everywhere...)
}

// SetEnabled switches tracing on or off for sessions that start afterwards.
func SetEnabled(on bool) { enabled.Store(on) }

// Enabled reports whether new sessions are traced.
func Enabled() bool { return enabled.Load() && dirPath.Load() != nil }

// Dir is the trace directory ("" before Configure).
func Dir() string {
	if p := dirPath.Load(); p != nil {
		return *p
	}
	return ""
}

// Files lists the trace files, newest first.
func Files() []string {
	d := Dir()
	if d == "" {
		return []string{}
	}
	ents, _ := os.ReadDir(d)
	var out []string
	for _, e := range ents {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".jsonl") {
			out = append(out, filepath.Join(d, e.Name()))
		}
	}
	slices.Sort(out)
	slices.Reverse(out)
	if out == nil {
		out = []string{}
	}
	return out
}

// Trace writes one session's file. A nil *Trace ignores everything.
type Trace struct {
	mu      sync.Mutex
	path    string
	f       *os.File
	size    int64
	max     int64
	scrub   func(string) string
	exact   []string
	started time.Time
}

// Begin opens a trace for an agent process when tracing is on, else returns
// nil. envValues are values to hide wherever they occur (the agent's
// environment); scrub, when set, is an extra redactor (the project's secrets).
func Begin(agentName string, envValues []string, scrub func(string) string) *Trace {
	if !Enabled() {
		return nil
	}
	d := Dir()
	if err := os.MkdirAll(d, 0o700); err != nil {
		return nil
	}
	prune(d)
	name := fmt.Sprintf("%s-%s-%d.jsonl", time.Now().UTC().Format("20060102T150405"), safeName(agentName), counter.Add(1))
	f, err := os.OpenFile(filepath.Join(d, name), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return nil
	}
	var exact []string
	for _, v := range envValues {
		if len(v) >= 4 { // shorter values would mangle the trace
			exact = append(exact, v)
		}
	}
	slices.SortFunc(exact, func(a, b string) int { return len(b) - len(a) })
	t := &Trace{path: f.Name(), f: f, max: MaxFileBytes, scrub: scrub, exact: exact, started: time.Now()}
	t.record("meta", fmt.Sprintf("trace of agent %q started", agentName), nil)
	return t
}

// Hide makes the trace redact v wherever it occurs from now on (a token the
// harness issued after the process started). Values under 4 bytes are ignored.
func (t *Trace) Hide(v string) {
	if t == nil || len(v) < 4 {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	t.exact = append(t.exact, v)
	slices.SortFunc(t.exact, func(a, b string) int { return len(b) - len(a) })
}

// Path is the trace file ("" for a nil trace).
func (t *Trace) Path() string {
	if t == nil {
		return ""
	}
	return t.path
}

// Sent records a message the harness wrote to the agent.
func (t *Trace) Sent(line []byte) { t.line("client->agent", line) }

// Received records a line the agent wrote on stdout.
func (t *Trace) Received(line []byte) { t.line("agent->client", line) }

// Stderr records a line the agent wrote on stderr.
func (t *Trace) Stderr(line string) {
	if t != nil {
		t.record("agent-stderr", line, nil)
	}
}

// Close ends the trace.
func (t *Trace) Close() {
	if t == nil {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.f != nil {
		_ = t.f.Close()
		t.f = nil
	}
}

func (t *Trace) line(dir string, line []byte) {
	if t == nil {
		return
	}
	var v any
	if json.Unmarshal(line, &v) == nil {
		t.record(dir, "", v)
		return
	}
	t.record(dir, string(line), nil)
}

func (t *Trace) record(dir, text string, msg any) {
	entry := map[string]any{"t": time.Now().UTC().Format(time.RFC3339Nano), "dir": dir}
	if msg != nil {
		entry["msg"] = t.redactValue("", msg)
	} else {
		entry["text"] = t.redactString(text)
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false) // "client->agent" stays readable
	if err := enc.Encode(entry); err != nil {
		return
	}
	b := buf.Bytes() // Encode ends the line
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.f == nil {
		return
	}
	n, err := t.f.Write(b)
	if err != nil {
		return
	}
	t.size += int64(n)
	if t.size > t.max {
		t.truncateLocked()
	}
}

// truncateLocked drops the oldest lines: the file keeps its newest half.
func (t *Trace) truncateLocked() {
	data, err := os.ReadFile(t.path)
	if err != nil {
		return
	}
	keep := data[len(data)/2:]
	if i := strings.IndexByte(string(keep), '\n'); i >= 0 {
		keep = keep[i+1:]
	}
	head := []byte(fmt.Sprintf(`{"t":%q,"dir":"meta","text":"older lines were dropped (file cap %d bytes)"}`+"\n",
		time.Now().UTC().Format(time.RFC3339Nano), t.max))
	keep = append(head, keep...)
	_ = t.f.Close()
	if err := os.WriteFile(t.path, keep, 0o600); err != nil {
		t.f = nil
		return
	}
	f, err := os.OpenFile(t.path, os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		t.f = nil
		return
	}
	t.f, t.size = f, int64(len(keep))
}

func prune(dir string) {
	files := Files()
	if len(files) < MaxFiles {
		return
	}
	for _, p := range files[MaxFiles-1:] { // newest first: drop the oldest, leaving room for the new file
		_ = os.Remove(p)
	}
}

func safeName(s string) string {
	return regexp.MustCompile(`[^A-Za-z0-9._-]+`).ReplaceAllString(s, "_")
}
