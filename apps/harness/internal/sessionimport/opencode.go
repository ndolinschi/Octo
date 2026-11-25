package sessionimport

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
)

type opencodeSession struct {
	ID        string `json:"id"`
	Directory string `json:"directory"`
	Title     string `json:"title"`
	Time      struct {
		Created int64 `json:"created"`
		Updated int64 `json:"updated"`
	} `json:"time"`
}

type opencodeMessage struct {
	ID      string `json:"id"`
	Role    string `json:"role"`
	ModelID string `json:"modelID"`
	Time    struct {
		Created int64 `json:"created"`
	} `json:"time"`
}

type opencodePart struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

func (s *Scanner) scanOpenCode(ctx context.Context, keepTurns bool) []Candidate {
	storageRoot := filepath.Join(s.homeDir, ".local", "share", "opencode", "storage")
	sessionRoot := filepath.Join(storageRoot, "session")
	var files []string
	walkDirIfExists(sessionRoot, func(path string, d os.DirEntry) error {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if !d.IsDir() && strings.HasSuffix(d.Name(), ".json") {
			files = append(files, path)
		}
		return nil
	})
	var out []Candidate
	for _, f := range files {
		if ctx.Err() != nil {
			break
		}
		if c, ok := parseOpenCodeSession(storageRoot, f, keepTurns); ok {
			out = append(out, c)
		}
	}
	return out
}

func parseOpenCodeSession(storageRoot, path string, keepTurns bool) (Candidate, bool) {
	b, err := os.ReadFile(path)
	if err != nil {
		return Candidate{}, false
	}
	var doc opencodeSession
	if json.Unmarshal(b, &doc) != nil || doc.ID == "" {
		return Candidate{}, false
	}
	msgDir := filepath.Join(storageRoot, "message", doc.ID)
	entries, err := os.ReadDir(msgDir)
	if err != nil {
		return Candidate{}, false
	}
	type loadedMsg struct {
		msg  opencodeMessage
		text string
	}
	var loaded []loadedMsg
	var model string
	for _, ent := range entries {
		if ent.IsDir() || !strings.HasSuffix(ent.Name(), ".json") {
			continue
		}
		mb, err := os.ReadFile(filepath.Join(msgDir, ent.Name()))
		if err != nil {
			continue
		}
		var m opencodeMessage
		if json.Unmarshal(mb, &m) != nil || m.ID == "" {
			continue
		}
		if m.Role != "user" && m.Role != "assistant" {
			continue
		}
		if m.ModelID != "" {
			model = m.ModelID
		}
		txt := readOpenCodeParts(filepath.Join(storageRoot, "part", m.ID))
		if txt == "" {
			continue
		}
		loaded = append(loaded, loadedMsg{msg: m, text: txt})
	}
	slices.SortStableFunc(loaded, func(a, b loadedMsg) int {
		if a.msg.Time.Created != b.msg.Time.Created {
			if a.msg.Time.Created < b.msg.Time.Created {
				return -1
			}
			return 1
		}
		return strings.Compare(a.msg.ID, b.msg.ID)
	})
	var turns []Turn
	for _, item := range loaded {
		turns = append(turns, Turn{
			Role:      item.msg.Role,
			Text:      item.text,
			Timestamp: unixMillisISO(item.msg.Time.Created),
			Model:     item.msg.ModelID,
		})
	}
	turns = collapseTurns(turns)
	ex := countExchanges(turns)
	if len(turns) == 0 || ex == 0 {
		return Candidate{}, false
	}
	startedAt := unixMillisISO(doc.Time.Created)
	updatedAt := unixMillisISO(doc.Time.Updated)
	fallbackTS := fileModISO(path)
	if startedAt == "" {
		startedAt = fallbackTS
	}
	if updatedAt == "" {
		updatedAt = startedAt
	}
	firstUser := firstUserText(turns)
	c := Candidate{
		Provider:      ProviderOpenCode,
		ProviderLabel: ProviderLabel(ProviderOpenCode),
		ID:            doc.ID,
		Title:         deriveTitle(doc.Title, "", firstUser),
		Cwd:           doc.Directory,
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

func readOpenCodeParts(dir string) string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return ""
	}
	var names []string
	for _, ent := range entries {
		if !ent.IsDir() && strings.HasSuffix(ent.Name(), ".json") {
			names = append(names, ent.Name())
		}
	}
	slices.Sort(names)
	var parts []string
	for _, name := range names {
		b, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			continue
		}
		var p opencodePart
		if json.Unmarshal(b, &p) == nil && p.Type == "text" {
			if t := strings.TrimSpace(p.Text); t != "" {
				parts = append(parts, t)
			}
		}
	}
	return strings.Join(parts, "\n\n")
}
