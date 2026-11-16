package sessionimport

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

type claudeIndexFile struct {
	Entries []claudeIndexEntry `json:"entries"`
}

type claudeIndexEntry struct {
	SessionID   string `json:"sessionId"`
	Summary     string `json:"summary"`
	CustomTitle string `json:"customTitle"`
	FirstPrompt string `json:"firstPrompt"`
	ProjectPath string `json:"projectPath"`
	Created     string `json:"created"`
	Modified    string `json:"modified"`
	IsSidechain bool   `json:"isSidechain"`
}

type claudeRecord struct {
	Type        string          `json:"type"`
	SessionID   string          `json:"sessionId"`
	Cwd         string          `json:"cwd"`
	Timestamp   string          `json:"timestamp"`
	Summary     string          `json:"summary"`
	CustomTitle string          `json:"customTitle"`
	IsSidechain bool            `json:"isSidechain"`
	IsMeta      bool            `json:"isMeta"`
	Message     json.RawMessage `json:"message"`
}

type claudeMessage struct {
	Role    string          `json:"role"`
	Model   string          `json:"model"`
	Content json.RawMessage `json:"content"`
}

func (s *Scanner) scanClaude(ctx context.Context, keepTurns bool) []Candidate {
	root := filepath.Join(s.homeDir, ".claude", "projects")
	projDirs, err := os.ReadDir(root)
	if err != nil {
		return nil
	}
	var out []Candidate
	for _, pd := range projDirs {
		if ctx.Err() != nil || !pd.IsDir() {
			continue
		}
		dirPath := filepath.Join(root, pd.Name())
		indexMap := readClaudeIndex(filepath.Join(dirPath, "sessions-index.json"))
		entries, err := os.ReadDir(dirPath)
		if err != nil {
			continue
		}
		for _, ent := range entries {
			if ctx.Err() != nil || ent.IsDir() {
				continue
			}
			name := ent.Name()
			if !strings.HasSuffix(name, ".jsonl") || strings.HasPrefix(name, "agent-") {
				continue
			}
			c, ok := parseClaudeJSONL(filepath.Join(dirPath, name), indexMap, keepTurns)
			if ok {
				out = append(out, c)
			}
		}
	}
	return out
}

func readClaudeIndex(path string) map[string]claudeIndexEntry {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var idx claudeIndexFile
	if json.Unmarshal(b, &idx) != nil {
		return nil
	}
	out := make(map[string]claudeIndexEntry, len(idx.Entries))
	for _, e := range idx.Entries {
		if e.SessionID != "" {
			out[e.SessionID] = e
		}
	}
	return out
}

func parseClaudeJSONL(path string, indexMap map[string]claudeIndexEntry, keepTurns bool) (Candidate, bool) {
	stem := strings.TrimSuffix(filepath.Base(path), ".jsonl")
	var (
		sessionID   string
		cwd         string
		model       string
		customTitle string
		summary     string
		startedAt   string
		updatedAt   string
		turns       []Turn
		isSidechain bool
	)
	_ = readLines(path, func(line []byte) error {
		var rec claudeRecord
		if json.Unmarshal(line, &rec) != nil {
			return nil
		}
		if rec.SessionID != "" && sessionID == "" {
			sessionID = rec.SessionID
		}
		if rec.Cwd != "" && cwd == "" {
			cwd = rec.Cwd
		}
		if rec.IsSidechain {
			isSidechain = true
		}
		if rec.CustomTitle != "" {
			customTitle = rec.CustomTitle
		}
		if rec.Type == "summary" && rec.Summary != "" {
			summary = rec.Summary
		}
		ts := normalizeTime(rec.Timestamp)
		if ts != "" {
			if startedAt == "" || ts < startedAt {
				startedAt = ts
			}
			if updatedAt == "" || ts > updatedAt {
				updatedAt = ts
			}
		}
		if rec.IsSidechain || rec.IsMeta || (rec.Type != "user" && rec.Type != "assistant") {
			return nil
		}
		var msg claudeMessage
		if len(rec.Message) == 0 || json.Unmarshal(rec.Message, &msg) != nil {
			return nil
		}
		role := msg.Role
		if role == "" {
			role = rec.Type
		}
		if role != "user" && role != "assistant" {
			return nil
		}
		if msg.Model != "" && msg.Model != "<synthetic>" {
			model = msg.Model
		}
		txt := extractClaudeText(msg.Content)
		if role == "user" {
			txt = stripClaudeCommandWrapper(txt)
		}
		if strings.TrimSpace(txt) == "" {
			return nil
		}
		turns = append(turns, Turn{Role: role, Text: txt, Timestamp: ts, Model: msg.Model})
		return nil
	})
	if sessionID == "" {
		sessionID = stem
	}
	if idx, ok := indexMap[sessionID]; ok {
		if idx.IsSidechain {
			isSidechain = true
		}
		if cwd == "" {
			cwd = idx.ProjectPath
		}
		if customTitle == "" {
			customTitle = idx.CustomTitle
		}
		if summary == "" {
			summary = idx.Summary
		}
		if startedAt == "" {
			startedAt = normalizeTime(idx.Created)
		}
		if updatedAt == "" {
			updatedAt = normalizeTime(idx.Modified)
		}
	}
	if isSidechain {
		return Candidate{}, false
	}
	turns = collapseTurns(turns)
	ex := countExchanges(turns)
	if len(turns) == 0 || ex == 0 {
		return Candidate{}, false
	}
	fallbackTS := fileModISO(path)
	if startedAt == "" {
		startedAt = fallbackTS
	}
	if updatedAt == "" {
		updatedAt = startedAt
	}
	firstUser := firstUserText(turns)
	c := Candidate{
		Provider:      ProviderClaudeCode,
		ProviderLabel: ProviderLabel(ProviderClaudeCode),
		ID:            sessionID,
		Title:         deriveTitle(customTitle, summary, firstUser),
		Cwd:           cwd,
		Model:         model,
		StartedAt:     startedAt,
		UpdatedAt:     updatedAt,
		MessageCount:  len(turns),
		ExchangeCount: ex,
		Preview:       clipText(firstUser, 140),
		FilePath:      path,
	}
	if keepTurns {
		c.Turns = turns
	}
	return c, true
}

func extractClaudeText(raw json.RawMessage) string {
	raw = json.RawMessage(strings.TrimSpace(string(raw)))
	if len(raw) == 0 {
		return ""
	}
	if raw[0] == '"' {
		var s string
		if json.Unmarshal(raw, &s) == nil {
			return strings.TrimSpace(s)
		}
		return ""
	}
	if raw[0] == '[' {
		var blocks []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		}
		if json.Unmarshal(raw, &blocks) != nil {
			return ""
		}
		var parts []string
		for _, b := range blocks {
			if b.Type == "text" && strings.TrimSpace(b.Text) != "" {
				parts = append(parts, strings.TrimSpace(b.Text))
			}
		}
		return strings.Join(parts, "\n\n")
	}
	return ""
}

func stripClaudeCommandWrapper(s string) string {
	s = strings.TrimSpace(s)
	if strings.HasPrefix(s, "<local-command-stdout>") || strings.HasPrefix(s, "<local-command-caveat>") {
		return ""
	}
	if strings.HasPrefix(s, "<command-message>") || strings.HasPrefix(s, "<command-name>") {
		return ""
	}
	return s
}
