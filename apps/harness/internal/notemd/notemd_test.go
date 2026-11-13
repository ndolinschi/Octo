package notemd

import (
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
)

func est(chars int) int64 { return int64((chars + 3) / 4) }

func TestRoundTrip(t *testing.T) {
	cases := []Doc{
		{Title: "Plain", Description: "one line", Tags: []string{"a", "b"}, Body: "# H\n\ntext\n"},
		{ID: "nte_1", Title: "Colon: in title", Description: "has # hash and \"quotes\"", Tags: []string{"x y", "a,b", "it's"}, Pinned: true,
			CreatedAt: "2026-01-02T03:04:05.000Z", UpdatedAt: "2026-01-02T03:04:06.000Z", LastReadAt: "2026-02-01T00:00:00.000Z", ReadCount: 7, Body: "body"},
		{Title: "true", Description: "", Body: ""},
		{Title: "Русский заголовок", Description: "Описание: бюджет", Tags: []string{"бюджет"}, DescriptionAuto: true, Body: "\nstarts with a blank line\n---\nnot a delimiter\n"},
		{Title: " lead", Description: "- dash", Body: "x"},
		{Title: "multi\tcontrol", Description: "d", Body: "a\nb"},
	}
	for i, in := range cases {
		t.Run(fmt.Sprint(i), func(t *testing.T) {
			out, err := Parse(Serialize(in))
			if err != nil {
				t.Fatal(err)
			}
			out.HasFrontMatter = false
			if len(in.Tags) == 0 && len(out.Tags) == 0 {
				out.Tags = in.Tags
			}
			if !reflect.DeepEqual(in, out) {
				t.Fatalf("round trip:\n in  %#v\n out %#v\n src %q", in, out, Serialize(in))
			}
		})
	}
}

func TestParseForms(t *testing.T) {
	d, err := Parse("---\r\ntitle: 'It''s'\r\n# comment\r\ndescription: \"a\\nb\"\r\ntags:\r\n  - one\r\n  - \"two words\"\r\npinned: true\r\nunknown: x\r\n---\r\nBody\r\n")
	if err != nil {
		t.Fatal(err)
	}
	if d.Title != "It's" || d.Description != "a\nb" || !reflect.DeepEqual(d.Tags, []string{"one", "two words"}) || !d.Pinned || d.Body != "Body\n" || !d.HasFrontMatter {
		t.Fatalf("%+v", d)
	}
	d, err = Parse("just text\nmore")
	if err != nil || d.HasFrontMatter || d.Body != "just text\nmore" {
		t.Fatalf("%+v %v", d, err)
	}
}

func TestParseErrorsCarryTheLine(t *testing.T) {
	cases := []struct {
		src  string
		line int
		msg  string
	}{
		{"---\ntitle: x\n", 1, "not closed"},
		{"---\ntitle x\n---\n", 2, "key: value"},
		{"---\ntitle: x\npinned: maybe\n---\n", 3, "true or false"},
		{"---\ntitle: x\ntitle: y\n---\n", 3, "duplicate"},
		{"---\ntitle: \"open\n---\n", 2, "double-quoted"},
		{"---\ntitle: x\ntags: a, b\n---\n", 3, "list"},
		{"---\ntitle: x\n - a\n---\n", 3, "list item"},
		{"---\ntitle: x\nread_count: -1\n---\n", 3, "number"},
		{"---\ntitle: x\n  indented: 1\n---\n", 3, "indentation"},
		{"---\ntags: [a, \"b]\n---\n", 2, "quote"},
	}
	for _, c := range cases {
		_, err := Parse(c.src)
		var pe *ParseError
		if !errors.As(err, &pe) || pe.Line != c.line || !strings.Contains(pe.Msg, c.msg) {
			t.Errorf("%q: %v, want line %d %q", c.src, err, c.line, c.msg)
		}
	}
}

func TestValidate(t *testing.T) {
	long := strings.Repeat("я", MaxDescription+1)
	cases := []struct {
		d   Doc
		err string
	}{
		{Doc{Title: "ok", Description: strings.Repeat("я", MaxDescription)}, ""},
		{Doc{Title: " "}, "title is required"},
		{Doc{Title: "a\nb"}, "one line"},
		{Doc{Title: "a", Description: "x\ny"}, "description must be one line"},
		{Doc{Title: "a", Description: long}, "limit is 200"},
		{Doc{Title: "a", Tags: []string{""}}, "tag is empty"},
		{Doc{Title: "a", Tags: make([]string, MaxTags+1)}, "at most"},
	}
	for _, c := range cases {
		err := Validate(c.d)
		if (c.err == "") != (err == nil) || (err != nil && !strings.Contains(err.Error(), c.err)) {
			t.Errorf("%+v: %v, want %q", c.d, err, c.err)
		}
	}
}

func TestAutoDescription(t *testing.T) {
	cases := map[string]string{
		"":                           "",
		"\n\n  first line  \nsecond": "first line",
		strings.Repeat("ж", 300):     strings.Repeat("ж", 200),
	}
	for in, want := range cases {
		if got := AutoDescription(in); got != want {
			t.Errorf("%q: %q", in[:min(len(in), 20)], got)
		}
	}
}

func TestOrderAndBudget(t *testing.T) {
	var es []Entry
	for i := 0; i < 100; i++ {
		es = append(es, Entry{ID: fmt.Sprintf("n%03d", i), Title: fmt.Sprintf("Note number %d", i),
			Description: strings.Repeat("describes the thing ", 5), Tags: []string{"t"},
			UpdatedAt: fmt.Sprintf("2026-01-01T00:00:%02d.000Z", i%60)})
	}
	es[10].Pinned = true
	es[20].LastReadAt = "2027-01-01T00:00:00.000Z" // read recently: first after the pinned one
	es[99].UpdatedAt = es[59].UpdatedAt            // the newest stamp twice
	lines, more := BuildIndex(es, IndexBudget, est)
	if more == 0 || len(lines) != len(es)-more+1 {
		t.Fatalf("more=%d lines=%d", more, len(lines))
	}
	if lines[len(lines)-1] != MoreLine(more) {
		t.Fatalf("last line %q", lines[len(lines)-1])
	}
	if !strings.HasPrefix(lines[0], "n010 · ") || !strings.HasPrefix(lines[1], "n020 · ") {
		t.Fatalf("order: %q / %q", lines[0], lines[1])
	}
	// 59 and 99 share the newest stamp; the later created one comes first.
	if !strings.HasPrefix(lines[2], "n099 · ") {
		t.Fatalf("tie-break: %q", lines[2])
	}
	var tokens int64
	for _, l := range lines {
		tokens += est(len(l) + 1)
	}
	if tokens > IndexBudget {
		t.Fatalf("index is %d tokens", tokens)
	}
	lines, more = BuildIndex(es[:5], IndexBudget, est)
	if more != 0 || len(lines) != 5 || strings.Contains(strings.Join(lines, "\n"), "more notes") {
		t.Fatalf("%d %v", more, lines)
	}
	if l, m := BuildIndex(nil, IndexBudget, est); len(l) != 0 || m != 0 {
		t.Fatal("empty")
	}
}

func TestIndexLine(t *testing.T) {
	got := IndexLine(Entry{ID: "nte_1", Title: "Deploy", Description: "How to\ndeploy", Tags: []string{"ops", "ci"}})
	if got != "nte_1 · Deploy — How to deploy [ops, ci]" {
		t.Fatal(got)
	}
	if got := IndexLine(Entry{ID: "n", Title: "T"}); got != "n · T" {
		t.Fatal(got)
	}
}

func TestCheckPinned(t *testing.T) {
	cases := []struct {
		b  []int
		ok bool
	}{{nil, true}, {[]int{2000}, true}, {[]int{1000, 1000, 1}, false}, {[]int{1, 1, 1, 1}, false}, {[]int{500, 500, 500}, true}}
	for _, c := range cases {
		if err := CheckPinned(c.b); (err == nil) != c.ok {
			t.Errorf("%v: %v", c.b, err)
		}
	}
}
