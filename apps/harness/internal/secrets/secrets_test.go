package secrets

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func newMgr(t *testing.T) (*Manager, string) {
	dir := t.TempDir()
	return New(func(string) string { return dir }), dir
}

func TestPutListDeleteAndFileMode(t *testing.T) {
	m, dir := newMgr(t)
	if err := m.Put("p", "api_key", "sk-very-secret"); err != nil {
		t.Fatal(err)
	}
	if err := m.Put("p", "other", "another-value"); err != nil {
		t.Fatal(err)
	}
	st, err := os.Stat(filepath.Join(dir, file))
	if err != nil || st.Mode().Perm() != 0o600 {
		t.Fatalf("file: %v %v", st, err)
	}
	list, err := m.List("p")
	if err != nil || len(list) != 2 || list[0].Name != "api_key" || list[1].Name != "other" {
		t.Fatalf("list = %+v %v", list, err)
	}
	// A fresh manager (a restart) reads it back.
	m2 := New(func(string) string { return dir })
	got, err := m2.Resolve("p", map[string]string{"KEY": "secret:api_key"})
	if err != nil || got["KEY"] != "sk-very-secret" {
		t.Fatalf("resolve = %v %v", got, err)
	}
	if err := m.Delete("p", "api_key"); err != nil {
		t.Fatal(err)
	}
	if err := m.Delete("p", "api_key"); err != ErrNotFound {
		t.Fatalf("second delete = %v", err)
	}
	if m.Has("p", "api_key") || !m.Has("p", "other") {
		t.Fatal("Has")
	}
}

func TestValidation(t *testing.T) {
	m, _ := newMgr(t)
	for _, name := range []string{"", "1abc", "a b", "a/b", strings.Repeat("x", 65)} {
		if err := m.Put("p", name, "valid-value"); err != ErrInvalidName {
			t.Errorf("name %q: %v", name, err)
		}
	}
	for _, v := range []string{"", "abc", "has\x00nul", strings.Repeat("x", MaxLen+1)} {
		if err := m.Put("p", "k", v); err != ErrInvalidValue {
			t.Errorf("value len %d: %v", len(v), err)
		}
	}
}

func TestResolveErrorsNeverContainValues(t *testing.T) {
	m, _ := newMgr(t)
	_ = m.Put("p", "k", "topsecretvalue")
	for _, refs := range []map[string]string{{"A": "literal"}, {"A": "secret:missing"}} {
		_, err := m.Resolve("p", refs)
		if err == nil || strings.Contains(err.Error(), "topsecretvalue") {
			t.Fatalf("err = %v", err)
		}
	}
}

func TestRedact(t *testing.T) {
	m, _ := newMgr(t)
	_ = m.Put("p", "k", `pa"ss/word`)
	_ = m.Put("p", "k2", "tok-12345")
	in := `echo pa"ss/word and {"v":"pa\"ss/word"} and tok-12345 and tok-1234`
	out := m.Redact("p", in)
	if strings.Contains(out, "ss/word") || strings.Contains(out, "tok-12345") || !strings.Contains(out, "tok-1234") {
		t.Fatalf("out = %q", out)
	}
	if string(m.RedactBytes("p", []byte(`{"text":"pa\"ss/word"}`))) != `{"text":"`+Mask+`"}` {
		t.Fatal("RedactBytes")
	}
	if m.Redact("other-project-without-store", "tok-12345") == "" {
		t.Fatal("unexpected")
	}
}

func TestStreamCatchesSplitValues(t *testing.T) {
	m, _ := newMgr(t)
	_ = m.Put("p", "k", "sk-split-secret")
	s := m.NewStream("p")
	var out strings.Builder
	for _, chunk := range []string{"the key is sk-sp", "lit-sec", "ret and then more text that is long enough", " to flush"} {
		out.WriteString(s.Write(chunk))
	}
	out.WriteString(s.Flush())
	got := out.String()
	if strings.Contains(got, "sk-sp") || strings.Contains(got, "secret") && !strings.Contains(got, Mask) {
		t.Fatalf("leaked: %q", got)
	}
	if got != "the key is "+Mask+" and then more text that is long enough to flush" {
		t.Fatalf("got %q", got)
	}
}

func TestStreamPassesThroughWithoutSecrets(t *testing.T) {
	m, _ := newMgr(t)
	s := m.NewStream("p")
	if s.Write("hello ") != "hello " || s.Write("world") != "world" || s.Flush() != "" {
		t.Fatal("not a passthrough")
	}
}
