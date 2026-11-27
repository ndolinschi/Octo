package orchestrator

import (
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

func writeSkillFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestDiscoverAgentSkillsClaudeCode(t *testing.T) {
	proj := t.TempDir()
	home := t.TempDir()

	writeSkillFile(t, filepath.Join(proj, ".claude", "skills", "deploy", "SKILL.md"), "---\nname: deploy\ndescription: Deploy to staging\nargument-hint: <env>\n---\nBody\n")
	writeSkillFile(t, filepath.Join(proj, ".claude", "skills", "internal", "SKILL.md"), "---\nname: internal\ndescription: Hidden\nuser-invocable: false\n---\n")
	writeSkillFile(t, filepath.Join(proj, ".claude", "commands", "review-pr.md"), "---\ndescription: Review the open PR\n---\nReview PR\n")
	writeSkillFile(t, filepath.Join(home, ".claude", "skills", "commit", "SKILL.md"), "---\ndescription: >\n  Create a clean\n  git commit\n---\n")
	// Duplicate of project skill "deploy" in home should be ignored in favor of project.
	writeSkillFile(t, filepath.Join(home, ".claude", "skills", "deploy", "SKILL.md"), "---\nname: deploy\ndescription: Home deploy\n---\n")

	got := discoverAgentSkills("claude-code", nil, []projectstore.Folder{{Path: proj}}, home)
	if len(got) != 3 {
		t.Fatalf("got %d skills: %+v", len(got), got)
	}
	byName := map[string]struct {
		desc string
		hint string
	}{}
	for _, c := range got {
		byName[c.Name] = struct {
			desc string
			hint string
		}{c.Description, c.InputHint}
	}
	if byName["deploy"].desc != "Deploy to staging" || byName["deploy"].hint != "<env>" {
		t.Fatalf("deploy = %+v", byName["deploy"])
	}
	if byName["review-pr"].desc != "Review the open PR" {
		t.Fatalf("review-pr = %+v", byName["review-pr"])
	}
	if byName["commit"].desc != "Create a clean git commit" {
		t.Fatalf("commit = %+v", byName["commit"])
	}
	if _, ok := byName["internal"]; ok {
		t.Fatalf("user-invocable: false skill should be omitted")
	}
}

func TestDiscoverAgentSkillsOtherProviders(t *testing.T) {
	proj := t.TempDir()
	home := t.TempDir()
	t.Setenv("CODEX_HOME", filepath.Join(home, ".codex"))

	writeSkillFile(t, filepath.Join(proj, ".codex", "skills", "fix-ci", "SKILL.md"), "---\ndescription: Fix CI failures\n---\n")
	writeSkillFile(t, filepath.Join(proj, ".cursor", "skills", "polish", "SKILL.md"), "---\ndescription: Polish UI\n---\n")
	writeSkillFile(t, filepath.Join(proj, ".opencode", "command", "audit.md"), "# Audit security\n")
	writeSkillFile(t, filepath.Join(proj, ".agent", "skills", "plan", "SKILL.md"), "---\ndescription: Plan work\n---\n")
	writeSkillFile(t, filepath.Join(proj, ".agents", "skills", "shared", "SKILL.md"), "---\ndescription: Shared skill\n---\n")

	codex := discoverAgentSkills("codex", nil, []projectstore.Folder{{Path: proj}}, home)
	if len(codex) != 2 || codex[0].Name != "fix-ci" || codex[1].Name != "shared" {
		t.Fatalf("codex = %+v", codex)
	}
	cursor := discoverAgentSkills("cursor", nil, []projectstore.Folder{{Path: proj}}, home)
	if len(cursor) != 2 || cursor[0].Name != "polish" || cursor[1].Name != "shared" {
		t.Fatalf("cursor = %+v", cursor)
	}
	opencode := discoverAgentSkills("opencode", nil, []projectstore.Folder{{Path: proj}}, home)
	if len(opencode) != 2 || opencode[0].Name != "audit" || opencode[1].Name != "shared" {
		t.Fatalf("opencode = %+v", opencode)
	}
	agy := discoverAgentSkills("antigravity", nil, []projectstore.Folder{{Path: proj}}, home)
	if len(agy) != 2 || agy[0].Name != "plan" || agy[1].Name != "shared" {
		t.Fatalf("antigravity = %+v", agy)
	}
}

// An account's own CLI home replaces the default login's skill folders
// (CLAUDE_CONFIG_DIR for Claude Code, GEMINI_CLI_HOME for Gemini); the shared
// ~/.agents folder stays.
func TestHomeSkillSourcesOfAnAccount(t *testing.T) {
	home, acct := "/home/u", "/accts/work"
	for _, tc := range []struct {
		name    string
		id      string
		account map[string]string
		want    []string
	}{
		{"claude default", "claude-code", nil, []string{"/home/u/.claude/skills", "/home/u/.claude/commands", "/home/u/.agents/skills"}},
		{"claude account", "claude-code", map[string]string{"CLAUDE_CONFIG_DIR": acct}, []string{"/accts/work/skills", "/accts/work/commands", "/home/u/.agents/skills"}},
		{"claude account without the variable", "claude-code", map[string]string{}, []string{"/home/u/.claude/skills", "/home/u/.claude/commands", "/home/u/.agents/skills"}},
		{"gemini default", "gemini", nil, []string{"/home/u/.gemini/skills", "/home/u/.agents/skills"}},
		{"gemini account", "gemini", map[string]string{"GEMINI_CLI_HOME": acct}, []string{"/accts/work/.gemini/skills", "/home/u/.agents/skills"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var got []string
			for _, src := range homeSkillSources(tc.id, home, tc.account) {
				got = append(got, filepath.ToSlash(src.dir))
			}
			if !slices.Equal(got, tc.want) {
				t.Fatalf("dirs = %v, want %v", got, tc.want)
			}
		})
	}
}
