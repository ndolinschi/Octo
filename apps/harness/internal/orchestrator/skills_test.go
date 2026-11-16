package orchestrator

import (
	"os"
	"path/filepath"
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

	got := discoverAgentSkills("claude-code", []projectstore.Folder{{Path: proj}}, home)
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

	codex := discoverAgentSkills("codex", []projectstore.Folder{{Path: proj}}, home)
	if len(codex) != 2 || codex[0].Name != "fix-ci" || codex[1].Name != "shared" {
		t.Fatalf("codex = %+v", codex)
	}
	cursor := discoverAgentSkills("cursor", []projectstore.Folder{{Path: proj}}, home)
	if len(cursor) != 2 || cursor[0].Name != "polish" || cursor[1].Name != "shared" {
		t.Fatalf("cursor = %+v", cursor)
	}
	opencode := discoverAgentSkills("opencode", []projectstore.Folder{{Path: proj}}, home)
	if len(opencode) != 2 || opencode[0].Name != "audit" || opencode[1].Name != "shared" {
		t.Fatalf("opencode = %+v", opencode)
	}
	agy := discoverAgentSkills("antigravity", []projectstore.Folder{{Path: proj}}, home)
	if len(agy) != 2 || agy[0].Name != "plan" || agy[1].Name != "shared" {
		t.Fatalf("antigravity = %+v", agy)
	}
}
