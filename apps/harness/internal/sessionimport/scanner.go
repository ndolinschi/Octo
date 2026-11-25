package sessionimport

import (
	"bufio"
	"context"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

const (
	ProviderClaudeCode = "claude-code"
	ProviderCodex      = "codex"
	ProviderGemini     = "gemini"
	ProviderOpenCode   = "opencode"
)

// ProviderLabel returns the human-readable name for a provider key.
func ProviderLabel(p string) string {
	switch p {
	case ProviderClaudeCode:
		return "Claude Code"
	case ProviderCodex:
		return "Codex"
	case ProviderGemini:
		return "Gemini"
	case ProviderOpenCode:
		return "OpenCode"
	default:
		return p
	}
}

// Turn is a single cleaned conversational turn extracted from an external transcript.
type Turn struct {
	Role      string
	Text      string
	Timestamp string
	Model     string
}

// Candidate is an external AI coding session discovered on disk.
type Candidate struct {
	Provider      string `json:"provider"`
	ProviderLabel string `json:"provider_label"`
	ID            string `json:"id"`
	Title         string `json:"title"`
	Cwd           string `json:"cwd"`
	Model         string `json:"model"`
	StartedAt     string `json:"started_at"`
	UpdatedAt     string `json:"updated_at"`
	MessageCount  int    `json:"message_count"`
	ExchangeCount int    `json:"exchange_count"`
	Preview       string `json:"preview"`
	FilePath      string `json:"-"`
	Turns         []Turn `json:"-"`
}

// Scanner finds external AI CLI conversation histories under a user home directory.
type Scanner struct {
	homeDir string
}

// DefaultHomeDir returns HARNESS_IMPORT_HOME if set, else the current user's home directory.
func DefaultHomeDir() string {
	if h := strings.TrimSpace(os.Getenv("HARNESS_IMPORT_HOME")); h != "" {
		return h
	}
	h, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return h
}

// NewScanner returns a scanner rooted at homeDir.
func NewScanner(homeDir string) *Scanner {
	return &Scanner{homeDir: homeDir}
}

// Scan discovers sessions from all supported providers, sorted newest UpdatedAt first.
func (s *Scanner) Scan(ctx context.Context) ([]Candidate, error) {
	if s.homeDir == "" {
		return []Candidate{}, nil
	}
	var out []Candidate
	seen := map[string]bool{}
	add := func(items []Candidate) {
		for _, c := range items {
			key := c.Provider + ":" + c.ID
			if c.ID == "" || seen[key] {
				continue
			}
			seen[key] = true
			// Clear turns on metadata listing so Scan stays compact in callers.
			c.Turns = nil
			out = append(out, c)
		}
	}
	add(s.scanClaude(ctx, false))
	add(s.scanCodex(ctx, false))
	add(s.scanGemini(ctx, false))
	add(s.scanOpenCode(ctx, false))
	slices.SortStableFunc(out, func(a, b Candidate) int {
		return strings.Compare(b.UpdatedAt, a.UpdatedAt)
	})
	if out == nil {
		out = []Candidate{}
	}
	return out, nil
}

// Load finds one specific session and returns it with full parsed Turns.
func (s *Scanner) Load(ctx context.Context, provider, id string) (Candidate, bool) {
	if s.homeDir == "" || id == "" {
		return Candidate{}, false
	}
	var items []Candidate
	switch provider {
	case ProviderClaudeCode:
		items = s.scanClaude(ctx, true)
	case ProviderCodex:
		items = s.scanCodex(ctx, true)
	case ProviderGemini:
		items = s.scanGemini(ctx, true)
	case ProviderOpenCode:
		items = s.scanOpenCode(ctx, true)
	default:
		return Candidate{}, false
	}
	for _, c := range items {
		if c.ID == id {
			return c, true
		}
	}
	return Candidate{}, false
}

// readLines streams every non-empty line from path without a 64KB scanner cap.
func readLines(path string, fn func(line []byte) error) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	r := bufio.NewReaderSize(f, 64*1024)
	for {
		line, err := r.ReadBytes('\n')
		trimmed := strings.TrimSpace(string(line))
		if trimmed != "" {
			if ferr := fn([]byte(trimmed)); ferr != nil {
				return ferr
			}
		}
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
	}
}

func normalizeTime(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04:05.000Z"} {
		if t, err := time.Parse(layout, raw); err == nil {
			return t.UTC().Format("2006-01-02T15:04:05.000Z")
		}
	}
	return raw
}

func unixMillisISO(ms int64) string {
	if ms <= 0 {
		return ""
	}
	return time.UnixMilli(ms).UTC().Format("2006-01-02T15:04:05.000Z")
}

func clipText(s string, maxRunes int) string {
	s = strings.Join(strings.Fields(s), " ")
	r := []rune(s)
	if len(r) <= maxRunes {
		return s
	}
	return strings.TrimSpace(string(r[:maxRunes])) + "…"
}

func deriveTitle(customTitle, summary, firstUser string) string {
	for _, cand := range []string{customTitle, summary, firstUser} {
		line := strings.TrimSpace(cand)
		if idx := strings.IndexAny(line, "\r\n"); idx >= 0 {
			line = strings.TrimSpace(line[:idx])
		}
		if line != "" {
			r := []rune(line)
			if len(r) > 80 {
				line = strings.TrimSpace(string(r[:80]))
			}
			return line
		}
	}
	return "Imported session"
}

func countExchanges(turns []Turn) int {
	n := 0
	for _, t := range turns {
		if t.Role == "user" {
			n++
		}
	}
	return n
}

func firstUserText(turns []Turn) string {
	for _, t := range turns {
		if t.Role == "user" && strings.TrimSpace(t.Text) != "" {
			return t.Text
		}
	}
	return ""
}

// collapseTurns merges adjacent turns with the same role (for example multiple
// assistant text segments emitted across tool calls in one response).
func collapseTurns(in []Turn) []Turn {
	if len(in) == 0 {
		return nil
	}
	out := make([]Turn, 0, len(in))
	for _, t := range in {
		txt := strings.TrimSpace(t.Text)
		if txt == "" {
			continue
		}
		t.Text = txt
		if n := len(out); n > 0 && out[n-1].Role == t.Role {
			out[n-1].Text += "\n\n" + t.Text
			if t.Timestamp != "" {
				out[n-1].Timestamp = t.Timestamp
			}
			if t.Model != "" {
				out[n-1].Model = t.Model
			}
			continue
		}
		out = append(out, t)
	}
	return out
}

func fileModISO(path string) string {
	if fi, err := os.Stat(path); err == nil {
		return fi.ModTime().UTC().Format("2006-01-02T15:04:05.000Z")
	}
	return time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
}

func walkDirIfExists(root string, fn func(path string, d os.DirEntry) error) {
	info, err := os.Stat(root)
	if err != nil || !info.IsDir() {
		return
	}
	_ = filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		return fn(path, d)
	})
}
