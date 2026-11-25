package config

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func writeFile(t *testing.T, dir, content string, mode os.FileMode) string {
	t.Helper()
	p := filepath.Join(dir, EnvFileName)
	if err := os.WriteFile(p, []byte(content), mode); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(p, mode); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestUpdateEnvFilePreservesUnknownLinesAndComments(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "# my settings\n\nFOO=bar\nexport ANTHROPIC_API_KEY=old\nHARNESS_MODEL_FAST=a\nHARNESS_MODEL_FAST=dup\n  # indented comment\nKEEP='quoted value'\nGONE=1\nnot a line\n", 0o600)

	err := UpdateEnvFile(dir, map[string]string{"ANTHROPIC_API_KEY": "sk-new", "HARNESS_MODEL_FAST": "b", "ADDED": "x"}, []string{"GONE"})
	if err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(filepath.Join(dir, EnvFileName))
	want := "# my settings\n\nFOO=bar\nANTHROPIC_API_KEY=sk-new\nHARNESS_MODEL_FAST=b\n  # indented comment\nKEEP='quoted value'\nnot a line\nADDED=x\n"
	if string(got) != want {
		t.Fatalf("file =\n%s\nwant\n%s", got, want)
	}
	// Written values read back as written.
	vals, err := ReadEnvValues(dir)
	if err != nil || vals["ANTHROPIC_API_KEY"] != "sk-new" || vals["KEEP"] != "quoted value" || vals["ADDED"] != "x" {
		t.Fatalf("values = %v, %v", vals, err)
	}
}

func TestUpdateEnvFileCreatesDirAndFileWith0600(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "nested", "data")
	if err := UpdateEnvFile(dir, map[string]string{"A": "1"}, nil); err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" {
		fi, err := os.Stat(filepath.Join(dir, EnvFileName))
		if err != nil || fi.Mode().Perm() != 0o600 {
			t.Fatalf("mode = %v, %v", fi.Mode(), err)
		}
	}
}

func TestUpdateEnvFileFixesALooseMode(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("no mode bits")
	}
	dir := t.TempDir()
	p := writeFile(t, dir, "A=1\n", 0o644)
	if err := UpdateEnvFile(dir, map[string]string{"B": "2"}, nil); err != nil {
		t.Fatal(err)
	}
	fi, _ := os.Stat(p)
	if fi.Mode().Perm() != 0o600 {
		t.Fatalf("mode = %v, want 0600", fi.Mode().Perm())
	}
	// The loader accepts it now.
	t.Setenv("A", "")
	_ = os.Unsetenv("A")
	_ = os.Unsetenv("B")
	t.Cleanup(func() { _ = os.Unsetenv("A"); _ = os.Unsetenv("B") })
	if set := LoadEnvFile(dir); len(set) != 2 {
		t.Fatalf("loaded %v", set)
	}
}

func TestUpdateEnvFileLeavesNoTempFilesAndKeepsTheOldOneOnFailure(t *testing.T) {
	dir := t.TempDir()
	p := writeFile(t, dir, "A=1\n", 0o600)
	if err := UpdateEnvFile(dir, map[string]string{"A": "line1\nB=2"}, nil); err == nil {
		t.Fatal("a newline in a value must be refused")
	}
	if err := UpdateEnvFile(dir, map[string]string{"bad key": "x"}, nil); err == nil {
		t.Fatal("an invalid name must be refused")
	}
	if b, _ := os.ReadFile(p); string(b) != "A=1\n" {
		t.Fatalf("file changed: %q", b)
	}
	if err := UpdateEnvFile(dir, map[string]string{"A": "2"}, nil); err != nil {
		t.Fatal(err)
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Fatalf("leftovers: %v", entries)
	}
}

func TestUpdateEnvFileRefusesADirectoryInItsPlace(t *testing.T) {
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, EnvFileName), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := UpdateEnvFile(dir, map[string]string{"A": "1"}, nil); err == nil {
		t.Fatal("want an error")
	}
}

func TestReadEnvValuesReadsALooseFileAndFirstKeyWins(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "A=1\nA=2\nB=\"x y\"\n", 0o644)
	v, err := ReadEnvValues(dir)
	if err != nil || v["A"] != "1" || v["B"] != "x y" {
		t.Fatalf("values = %v, %v", v, err)
	}
	if v, err := ReadEnvValues(t.TempDir()); err != nil || len(v) != 0 {
		t.Fatalf("missing file: %v, %v", v, err)
	}
}

func TestValidEnvValue(t *testing.T) {
	for _, ok := range []string{"", "sk-ant-abc123", "a=b", "x#y", "has space inside", "http://h:1/p"} {
		if err := ValidEnvValue(ok); err != nil {
			t.Errorf("%q: %v", ok, err)
		}
	}
	for _, bad := range []string{" lead", "trail ", "a\nb", "a\rb", "a\x00b", `"quoted"`, "'q", "tab\there"} {
		err := ValidEnvValue(bad)
		if err == nil {
			t.Errorf("%q accepted", bad)
		} else if strings.Contains(err.Error(), strings.TrimSpace(bad)) && strings.TrimSpace(bad) != "" {
			t.Errorf("error echoes the value: %v", err)
		}
	}
}
