package bridge_test

import (
	"net/http"
	"strings"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

type noteResp struct {
	projectstore.Note
	Markdown string `json:"markdown"`
}

func TestM5NotesAPIListsWithoutBodiesAndGetsMarkdown(t *testing.T) {
	e := newEnv(t, nil)
	pid, _ := e.v7Project(t, "full")
	base := "/v1/projects/" + pid + "/notes"

	// Create from fields: the description is derived and flagged.
	var a noteResp
	e.into(t, "POST", base, map[string]any{"title": "Deploy", "content": "Run the script.\nThen check."}, http.StatusCreated, &a)
	if a.Description != "Run the script." || !a.DescriptionAuto || a.Content == "" || a.Tags == nil || a.Pinned || a.Size != len("Run the script.\nThen check.") {
		t.Fatalf("created = %+v", a)
	}
	// Create from raw Markdown with front matter.
	src := "---\ntitle: Budget\ndescription: Monthly limits\ntags: [money, \"q4\"]\npinned: true\n---\n\n# Budget\n500 dollars.\n"
	var b noteResp
	e.into(t, "POST", base, map[string]any{"markdown": src}, http.StatusCreated, &b)
	if b.Title != "Budget" || b.Description != "Monthly limits" || b.DescriptionAuto || !b.Pinned || len(b.Tags) != 2 || b.Content != "# Budget\n500 dollars.\n" {
		t.Fatalf("from markdown = %+v", b)
	}
	// A source without front matter: the title comes from the heading or the fallback.
	var c noteResp
	e.into(t, "POST", base, map[string]any{"markdown": "# Imported heading\ntext"}, http.StatusCreated, &c)
	if c.Title != "Imported heading" || c.Description != "# Imported heading" {
		t.Fatalf("plain markdown = %+v", c)
	}

	// The list has the front-matter fields and no bodies.
	var list struct{ Notes []map[string]any }
	e.into(t, "GET", base, nil, http.StatusOK, &list)
	if len(list.Notes) != 3 {
		t.Fatalf("list = %+v", list)
	}
	for _, n := range list.Notes {
		if _, has := n["content"]; has {
			t.Fatalf("a list entry has a body: %v", n)
		}
		for _, k := range []string{"id", "title", "description", "description_auto", "tags", "pinned", "size", "created_at", "updated_at", "last_read_at", "read_count"} {
			if _, ok := n[k]; !ok {
				t.Fatalf("list entry lacks %s: %v", k, n)
			}
		}
	}

	// Get returns the body and the Markdown source; reading over the API is not an agent read.
	var got noteResp
	e.into(t, "GET", base+"/"+b.ID, nil, http.StatusOK, &got)
	if got.Content != b.Content || got.ReadCount != 0 || !strings.HasPrefix(got.Markdown, "---\nid: "+b.ID+"\ntitle: Budget\ndescription: Monthly limits\ntags: [money, q4]\npinned: true\n") ||
		!strings.HasSuffix(got.Markdown, "\n---\n\n# Budget\n500 dollars.\n") {
		t.Fatalf("get = %+v\n%s", got, got.Markdown)
	}
	// The source it returns can be sent back unchanged.
	e.into(t, "PATCH", base+"/"+b.ID, map[string]any{"markdown": got.Markdown}, http.StatusOK, &got)
	if got.Title != "Budget" || got.Content != b.Content {
		t.Fatalf("round trip = %+v", got)
	}

	// Update by fields: a written description stays when the body changes.
	e.into(t, "PATCH", base+"/"+a.ID, map[string]any{"description": "How to ship", "tags": []string{"ops"}}, http.StatusOK, &a)
	e.into(t, "PATCH", base+"/"+a.ID, map[string]any{"content": "New body"}, http.StatusOK, &a)
	if a.Description != "How to ship" || a.DescriptionAuto || a.Content != "New body" || len(a.Tags) != 1 {
		t.Fatalf("patched = %+v", a)
	}

	// Export is the Markdown as a file.
	status, raw := e.do(t, "GET", base+"/"+b.ID+"/export", nil)
	if status != http.StatusOK || !strings.HasPrefix(string(raw), "---\nid: "+b.ID) {
		t.Fatalf("export = %d %s", status, raw)
	}
	e.wantError(t, "GET", base+"/nte_nope", nil, http.StatusNotFound, "not_found")
}

func TestM5NotesAPIRefusesBadInputWithAMessage(t *testing.T) {
	e := newEnv(t, nil)
	pid, _ := e.v7Project(t, "full")
	base := "/v1/projects/" + pid + "/notes"
	cases := []struct {
		name string
		body map[string]any
		want string
	}{
		{"parse error names the line", map[string]any{"markdown": "---\ntitle: x\npinned: maybe\n---\nbody"}, "markdown: line 3: pinned must be true or false"},
		{"unclosed front matter", map[string]any{"markdown": "---\ntitle: x\n"}, "line 1"},
		{"title required", map[string]any{"markdown": "---\ndescription: d\n---\nbody"}, "title is required"},
		{"description too long", map[string]any{"title": "t", "description": strings.Repeat("d", 201)}, "limit is 200"},
		{"description one line", map[string]any{"title": "t", "description": "a\nb"}, "description must be one line"},
	}
	for _, c := range cases {
		status, raw := e.do(t, "POST", base, c.body)
		if status != http.StatusBadRequest || !strings.Contains(string(raw), c.want) {
			t.Errorf("%s: %d %s, want 400 containing %q", c.name, status, raw, c.want)
		}
	}
	// Pin limits.
	big := strings.Repeat("x", 2001)
	if status, raw := e.do(t, "POST", base, map[string]any{"title": "big", "content": big, "pinned": true}); status != http.StatusBadRequest || !strings.Contains(string(raw), "2000 characters") {
		t.Errorf("pinned too long: %d %s", status, raw)
	}
	for i := 0; i < 3; i++ {
		e.into(t, "POST", base, map[string]any{"title": "p" + string(rune('a'+i)), "content": "x", "pinned": true}, http.StatusCreated, nil)
	}
	status, raw := e.do(t, "POST", base, map[string]any{"title": "pd", "content": "x", "pinned": true})
	if status != http.StatusBadRequest || !strings.Contains(string(raw), "at most 3 notes can be pinned") {
		t.Errorf("fourth pin: %d %s", status, raw)
	}
	var one noteResp
	e.into(t, "POST", base, map[string]any{"title": "plain", "content": "x"}, http.StatusCreated, &one)
	status, raw = e.do(t, "PATCH", base+"/"+one.ID, map[string]any{"pinned": true})
	if status != http.StatusBadRequest {
		t.Errorf("pin by patch: %d %s", status, raw)
	}
}
