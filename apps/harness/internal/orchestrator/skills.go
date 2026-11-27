package orchestrator

import (
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/ndolinschi/Octo/apps/harness/internal/acp"
	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

type skillSource struct {
	dir      string
	commands bool // true = *.md command files; false = */SKILL.md skill directories
}

// discoverAgentSkills scans the project's folders and the user's home directory for
// skills and slash-command files belonging to the selected ACP agent. An account
// of an agent ("codex@work") reads its base agent's places; env is that agent's
// resolved environment, where an account's own CLI home is set.
func discoverAgentSkills(agentID string, env map[string]string, folders []projectstore.Folder, home string) []acp.Command {
	id := strings.ToLower(strings.TrimSpace(agentID))
	if id == "" {
		return nil
	}
	// An account of an agent ("claude-code@work") reads the agent's own skill folders.
	slug := ""
	if base, acct, ok := plugins.SplitAccountID(id); ok {
		id, slug = base, acct
	}
	var sources []skillSource
	for _, f := range folders {
		root := strings.TrimSpace(f.Path)
		if root == "" {
			continue
		}
		sources = append(sources, projectSkillSources(id, root)...)
	}
	if home != "" && id != "scripted" {
		var account map[string]string
		if slug != "" {
			account = env
		}
		sources = append(sources, homeSkillSources(id, home, account)...)
	}

	var out []acp.Command
	seen := map[string]bool{}
	seenDirs := map[string]bool{}
	for _, src := range sources {
		cleanDir := filepath.Clean(src.dir)
		if seenDirs[cleanDir] {
			continue
		}
		seenDirs[cleanDir] = true
		var found []acp.Command
		if src.commands {
			found = scanCommandDir(cleanDir)
		} else {
			found = scanSkillDir(cleanDir)
		}
		for _, c := range found {
			key := strings.ToLower(c.Name)
			if key == "" || seen[key] {
				continue
			}
			seen[key] = true
			out = append(out, c)
		}
	}
	return out
}

func projectSkillSources(id, root string) []skillSource {
	switch id {
	case "claude-code", "claude":
		return []skillSource{
			{dir: filepath.Join(root, ".claude", "skills")},
			{dir: filepath.Join(root, ".claude", "commands"), commands: true},
			{dir: filepath.Join(root, ".agents", "skills")},
		}
	case "codex":
		return []skillSource{
			{dir: filepath.Join(root, ".codex", "skills")},
			{dir: filepath.Join(root, ".agents", "skills")},
		}
	case "cursor":
		return []skillSource{
			{dir: filepath.Join(root, ".cursor", "skills")},
			{dir: filepath.Join(root, ".cursor", "commands"), commands: true},
			{dir: filepath.Join(root, ".claude", "skills")},
			{dir: filepath.Join(root, ".agents", "skills")},
		}
	case "opencode":
		return []skillSource{
			{dir: filepath.Join(root, ".opencode", "skills")},
			{dir: filepath.Join(root, ".opencode", "command"), commands: true},
			{dir: filepath.Join(root, ".opencode", "commands"), commands: true},
			{dir: filepath.Join(root, ".claude", "skills")},
			{dir: filepath.Join(root, ".agents", "skills")},
		}
	case "antigravity":
		return []skillSource{
			{dir: filepath.Join(root, ".agent", "skills")},
			{dir: filepath.Join(root, ".agents", "skills")},
		}
	case "gemini":
		return []skillSource{
			{dir: filepath.Join(root, ".gemini", "skills")},
			{dir: filepath.Join(root, ".agents", "skills")},
		}
	case "copilot":
		return []skillSource{
			{dir: filepath.Join(root, ".github", "skills")},
			{dir: filepath.Join(root, ".agents", "skills")},
		}
	default:
		return []skillSource{
			{dir: filepath.Join(root, "."+id, "skills")},
			{dir: filepath.Join(root, ".agents", "skills")},
		}
	}
}

// homeSkillSources lists the skill folders under the user's home; account is
// the environment of a non-default account (nil for the default one), whose
// own CLI home replaces the harness's.
func homeSkillSources(id, home string, account map[string]string) []skillSource {
	switch id {
	case "claude-code", "claude":
		claudeDir := accountHome(account, "CLAUDE_CONFIG_DIR", filepath.Join(home, ".claude"))
		return []skillSource{
			{dir: filepath.Join(claudeDir, "skills")},
			{dir: filepath.Join(claudeDir, "commands"), commands: true},
			{dir: filepath.Join(home, ".agents", "skills")},
		}
	case "codex":
		codexHome := strings.TrimSpace(os.Getenv("CODEX_HOME"))
		if account != nil {
			codexHome = strings.TrimSpace(account["CODEX_HOME"])
		}
		if codexHome == "" && account == nil {
			codexHome = strings.TrimSpace(os.Getenv("OCTO_CODEX_HOME"))
		}
		if codexHome == "" {
			codexHome = filepath.Join(home, ".codex")
		}
		return []skillSource{
			{dir: filepath.Join(codexHome, "skills")},
			{dir: filepath.Join(home, ".agents", "skills")},
		}
	case "cursor":
		return []skillSource{
			{dir: filepath.Join(home, ".cursor", "skills")},
			{dir: filepath.Join(home, ".cursor", "commands"), commands: true},
			{dir: filepath.Join(home, ".claude", "skills")},
			{dir: filepath.Join(home, ".agents", "skills")},
		}
	case "opencode":
		return []skillSource{
			{dir: filepath.Join(home, ".config", "opencode", "skills")},
			{dir: filepath.Join(home, ".config", "opencode", "command"), commands: true},
			{dir: filepath.Join(home, ".config", "opencode", "commands"), commands: true},
			{dir: filepath.Join(home, ".claude", "skills")},
			{dir: filepath.Join(home, ".agents", "skills")},
		}
	case "antigravity":
		return []skillSource{
			{dir: filepath.Join(home, ".gemini", "antigravity", "skills")},
			{dir: filepath.Join(home, ".agents", "skills")},
		}
	case "gemini":
		// GEMINI_CLI_HOME stands in for the home folder: Gemini CLI keeps .gemini under it.
		return []skillSource{
			{dir: filepath.Join(accountHome(account, "GEMINI_CLI_HOME", home), ".gemini", "skills")},
			{dir: filepath.Join(home, ".agents", "skills")},
		}
	case "copilot":
		return []skillSource{
			{dir: filepath.Join(home, ".copilot", "skills")},
			{dir: filepath.Join(home, ".agents", "skills")},
		}
	default:
		return []skillSource{
			{dir: filepath.Join(home, "."+id, "skills")},
			{dir: filepath.Join(home, ".agents", "skills")},
		}
	}
}

func scanSkillDir(dir string) []acp.Command {
	var out []acp.Command
	_ = filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			name := d.Name()
			if path != dir && strings.HasPrefix(name, ".") {
				return filepath.SkipDir
			}
			rel, _ := filepath.Rel(dir, path)
			if rel != "." && strings.Count(rel, string(filepath.Separator)) >= 2 {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.EqualFold(d.Name(), "SKILL.md") {
			return nil
		}
		parentName := filepath.Base(filepath.Dir(path))
		if c, ok := parseSkillMarkdown(path, parentName, true); ok {
			out = append(out, c)
		}
		return nil
	})
	slices.SortFunc(out, func(a, b acp.Command) int {
		return strings.Compare(strings.ToLower(a.Name), strings.ToLower(b.Name))
	})
	return out
}

func scanCommandDir(dir string) []acp.Command {
	var out []acp.Command
	_ = filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			if path != dir && strings.HasPrefix(d.Name(), ".") {
				return filepath.SkipDir
			}
			rel, _ := filepath.Rel(dir, path)
			if rel != "." && strings.Count(rel, string(filepath.Separator)) >= 2 {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.EqualFold(filepath.Ext(d.Name()), ".md") {
			return nil
		}
		rel, err := filepath.Rel(dir, path)
		if err != nil {
			return nil
		}
		noExt := strings.TrimSuffix(rel, filepath.Ext(rel))
		fallback := strings.ReplaceAll(filepath.ToSlash(noExt), "/", ":")
		if c, ok := parseSkillMarkdown(path, fallback, false); ok {
			out = append(out, c)
		}
		return nil
	})
	slices.SortFunc(out, func(a, b acp.Command) int {
		return strings.Compare(strings.ToLower(a.Name), strings.ToLower(b.Name))
	})
	return out
}

func parseSkillMarkdown(path, fallbackName string, isSkill bool) (acp.Command, bool) {
	f, err := os.Open(path)
	if err != nil {
		return acp.Command{}, false
	}
	defer f.Close()
	buf := make([]byte, 8192)
	n, _ := f.Read(buf)
	text := strings.ReplaceAll(string(buf[:n]), "\r\n", "\n")

	meta, body := parseFrontmatter(text)
	if v, ok := meta["user-invocable"]; ok && strings.EqualFold(strings.TrimSpace(v), "false") {
		return acp.Command{}, false
	}
	name := cleanSkillName(meta["name"])
	if name == "" {
		name = cleanSkillName(fallbackName)
	}
	if name == "" {
		return acp.Command{}, false
	}
	desc := strings.TrimSpace(meta["description"])
	if desc == "" && !isSkill {
		desc = firstBodyLine(body)
	}
	if desc == "" {
		desc = "Skill"
	}
	return acp.Command{
		Name:        name,
		Description: desc,
		InputHint:   strings.TrimSpace(meta["argument-hint"]),
	}, true
}

func cleanSkillName(s string) string {
	s = strings.TrimSpace(s)
	s = strings.TrimLeft(s, "/")
	if i := strings.IndexAny(s, " \t\r\n"); i >= 0 {
		s = s[:i]
	}
	return s
}

func parseFrontmatter(text string) (meta map[string]string, body string) {
	meta = map[string]string{}
	if !strings.HasPrefix(text, "---\n") {
		return meta, text
	}
	rest := text[4:]
	end := strings.Index(rest, "\n---")
	if end < 0 {
		return meta, text
	}
	fm := rest[:end]
	body = rest[end+4:]
	lines := strings.Split(fm, "\n")
	for i := 0; i < len(lines); i++ {
		line := lines[i]
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		colon := strings.IndexByte(line, ':')
		if colon <= 0 {
			continue
		}
		key := strings.ToLower(strings.TrimSpace(line[:colon]))
		val := strings.TrimSpace(line[colon+1:])
		if val == "|" || val == ">" || val == "|-" || val == ">-" {
			var parts []string
			for j := i + 1; j < len(lines); j++ {
				next := lines[j]
				if len(next) == 0 || (next[0] != ' ' && next[0] != '\t') {
					break
				}
				parts = append(parts, strings.TrimSpace(next))
				i = j
			}
			val = strings.Join(parts, " ")
		} else {
			val = unquoteYAML(val)
		}
		if key != "" && val != "" {
			meta[key] = val
		}
	}
	return meta, body
}

func unquoteYAML(s string) string {
	if len(s) >= 2 && ((s[0] == '"' && s[len(s)-1] == '"') || (s[0] == '\'' && s[len(s)-1] == '\'')) {
		return s[1 : len(s)-1]
	}
	return s
}

func firstBodyLine(body string) string {
	for _, line := range strings.Split(body, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "---") {
			continue
		}
		line = strings.TrimSpace(strings.TrimLeft(line, "#"))
		if line != "" {
			return line
		}
	}
	return ""
}

// accountHome is the folder an account's env names in key, else fallback (the
// default login's, also when the account has none).
func accountHome(account map[string]string, key, fallback string) string {
	if d := strings.TrimSpace(account[key]); d != "" {
		return d
	}
	return fallback
}
