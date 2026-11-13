package bridge_test

import (
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/bridge"
)

type dirsResp struct {
	Base    string `json:"base"`
	Error   string `json:"error"`
	Entries []struct {
		Name string `json:"name"`
		Path string `json:"path"`
		Git  *struct {
			Branch string `json:"branch"`
		} `json:"git"`
	} `json:"entries"`
}

func (r dirsResp) names() []string {
	out := []string{}
	for _, e := range r.Entries {
		out = append(out, e.Name)
	}
	return out
}

func fsEnv(t *testing.T) *env { return newEnvWith(t, nil, nil, bridge.WithLoopbackBind(true)) }

func dirs(t *testing.T, e *env, path string) dirsResp {
	t.Helper()
	var r dirsResp
	e.into(t, "GET", "/v1/fs/dirs?path="+url.QueryEscape(path), nil, 200, &r)
	return r
}

func mkdirs(t *testing.T, root string, names ...string) {
	t.Helper()
	for _, n := range names {
		if err := os.MkdirAll(filepath.Join(root, n), 0o755); err != nil {
			t.Fatal(err)
		}
	}
}

func eq(a, b []string) bool { return strings.Join(a, "|") == strings.Join(b, "|") }

func TestFsDirsPrefixHiddenFilesAndSort(t *testing.T) {
	e := fsEnv(t)
	root := t.TempDir()
	mkdirs(t, root, "Zeta", "alpha", "Alps", "beta", ".hidden", ".dots")
	if err := os.WriteFile(filepath.Join(root, "alfile"), []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	r := dirs(t, e, root+"/")
	if r.Error != "" || r.Base != root || !eq(r.names(), []string{"alpha", "Alps", "beta", "Zeta"}) {
		t.Fatalf("trailing slash: %+v", r)
	}
	// A prefix is case-insensitive and matches directories only (not "alfile").
	if r := dirs(t, e, root+"/AL"); !eq(r.names(), []string{"alpha", "Alps"}) || r.Base != root {
		t.Fatalf("prefix AL: %+v", r)
	}
	// Hidden ones only when the last segment starts with a dot.
	if r := dirs(t, e, root+"/."); !eq(r.names(), []string{".dots", ".hidden"}) {
		t.Fatalf("prefix dot: %+v", r)
	}
	if r := dirs(t, e, root+"/.h"); !eq(r.names(), []string{".hidden"}) {
		t.Fatalf("prefix .h: %+v", r)
	}
	// Only directories, never file names.
	for _, n := range dirs(t, e, root+"/").names() {
		if n == "alfile" {
			t.Fatal("a file was listed")
		}
	}
	// Entries carry their full path.
	if r := dirs(t, e, root+"/be"); len(r.Entries) != 1 || r.Entries[0].Path != filepath.Join(root, "beta") || r.Entries[0].Git != nil {
		t.Fatalf("entry: %+v", r)
	}
}

func TestFsDirsTildeAndEmptyMeanHome(t *testing.T) {
	e := fsEnv(t)
	home := t.TempDir()
	t.Setenv("HOME", home)
	mkdirs(t, home, "Projects", "Pictures", "work/deep")
	for _, p := range []string{"", "~", "~/"} {
		r := dirs(t, e, p)
		if r.Error != "" || !eq(r.names(), []string{"Pictures", "Projects", "work"}) {
			t.Fatalf("%q: %+v", p, r)
		}
	}
	if r := dirs(t, e, "~/Pr"); !eq(r.names(), []string{"Projects"}) || r.Base != home {
		t.Fatalf("~/Pr: %+v", r)
	}
	if r := dirs(t, e, "~/work/"); !eq(r.names(), []string{"deep"}) {
		t.Fatalf("~/work/: %+v", r)
	}
}

func TestFsDirsSpacesAndCyrillic(t *testing.T) {
	e := fsEnv(t)
	root := t.TempDir()
	mkdirs(t, root, "Мои проекты", "мой код", "My Projects", "Мир")
	if r := dirs(t, e, root+"/мо"); !eq(r.names(), []string{"Мои проекты", "мой код"}) {
		t.Fatalf("cyrillic prefix (case-insensitive): %+v", r)
	}
	if r := dirs(t, e, root+"/my p"); !eq(r.names(), []string{"My Projects"}) {
		t.Fatalf("space prefix: %+v", r)
	}
	mkdirs(t, root, "Мои проекты/каталог с пробелом")
	r := dirs(t, e, root+"/Мои проекты/")
	if !eq(r.names(), []string{"каталог с пробелом"}) || r.Entries[0].Path != filepath.Join(root, "Мои проекты", "каталог с пробелом") {
		t.Fatalf("nested: %+v", r)
	}
}

func TestFsDirsCapsAtFifty(t *testing.T) {
	e := fsEnv(t)
	root := t.TempDir()
	for i := 0; i < 80; i++ {
		mkdirs(t, root, fmt.Sprintf("d%03d", i))
	}
	r := dirs(t, e, root+"/")
	if len(r.Entries) != 50 || r.Entries[0].Name != "d000" || r.Entries[49].Name != "d049" {
		t.Fatalf("got %d entries, first %v", len(r.Entries), r.names()[:1])
	}
}

func TestFsDirsMissingAndNotADirectory(t *testing.T) {
	e := fsEnv(t)
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "f.txt"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{root + "/nope/", root + "/nope/child", root + "/f.txt/", "relative/dir/"} {
		r := dirs(t, e, p)
		if r.Error != "not_found" || len(r.Entries) != 0 {
			t.Fatalf("%q: %+v", p, r)
		}
	}
	// A JSON body, never null, for the empty list.
	status, raw := e.do(t, "GET", "/v1/fs/dirs?path="+url.QueryEscape(root+"/zzz"), nil)
	if status != 200 || !strings.Contains(string(raw), `"entries":[]`) {
		t.Fatalf("%d %s", status, raw)
	}
}

func TestFsDirsNotReadable(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root reads everything")
	}
	e := fsEnv(t)
	root := t.TempDir()
	mkdirs(t, root, "locked")
	if err := os.Chmod(filepath.Join(root, "locked"), 0); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(filepath.Join(root, "locked"), 0o755) })
	if r := dirs(t, e, root+"/locked/"); r.Error != "not_readable" || len(r.Entries) != 0 {
		t.Fatalf("%+v", r)
	}
}

func TestFsDirsSymlinks(t *testing.T) {
	e := fsEnv(t)
	root, outside := t.TempDir(), t.TempDir()
	mkdirs(t, root, "real", "loopA")
	mkdirs(t, outside, "inside-outside")
	if err := os.WriteFile(filepath.Join(outside, "file.txt"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	link := func(target, name string) {
		if err := os.Symlink(target, filepath.Join(root, name)); err != nil {
			t.Skipf("symlinks unavailable: %v", err)
		}
	}
	link(outside, "to-dir")                             // a link to a directory is a directory
	link(filepath.Join(outside, "file.txt"), "to-file") // a link to a file is not listed
	link(filepath.Join(root, "missing"), "dangling")    // nor a dangling one
	link(filepath.Join(root, "loop-b"), "loop-a")       // a loop: both ends point at each other
	link(filepath.Join(root, "loop-a"), "loop-b")
	link(root, "self") // a link to the directory itself lists once, without recursing
	r := dirs(t, e, root+"/")
	if !eq(r.names(), []string{"loopA", "real", "self", "to-dir"}) {
		t.Fatalf("names = %v", r.names())
	}
	// Listing through a loop answers not_found instead of hanging or erroring.
	if r := dirs(t, e, root+"/loop-a/"); r.Error != "not_found" || len(r.Entries) != 0 {
		t.Fatalf("through the loop: %+v", r)
	}
	// Through the link to a file: not a directory.
	if r := dirs(t, e, root+"/to-file/"); r.Error != "not_found" {
		t.Fatalf("through a file link: %+v", r)
	}
	// Nothing of the other directory's file names leaks.
	if r := dirs(t, e, root+"/to-dir/"); !eq(r.names(), []string{"inside-outside"}) {
		t.Fatalf("through a directory link: %+v", r)
	}
}

func TestFsDirsGitBranchFromHEADWithoutRunningGit(t *testing.T) {
	e := fsEnv(t)
	t.Setenv("PATH", "") // git must not be needed
	root := t.TempDir()
	write := func(rel, content string) {
		p := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write("main-repo/.git/HEAD", "ref: refs/heads/feature/ui\n")
	write("detached/.git/HEAD", "0123456789abcdef0123456789abcdef01234567\n")
	write("wt-real/HEAD", "ref: refs/heads/wt-branch\n")
	write("worktree/.git", "gitdir: "+filepath.Join(root, "wt-real")+"\n")
	write("relative/.git", "gitdir: ../rel-real\n")
	write("rel-real/HEAD", "ref: refs/heads/rel\n")
	mkdirs(t, root, "plain", "emptygit/.git")
	r := dirs(t, e, root+"/")
	got := map[string]string{}
	for _, en := range r.Entries {
		if en.Git == nil {
			got[en.Name] = "-"
		} else {
			got[en.Name] = en.Git.Branch
		}
	}
	want := map[string]string{
		"main-repo": "feature/ui", "detached": "0123456", "worktree": "wt-branch", "relative": "rel",
		"plain": "-", "emptygit": "", "wt-real": "-", "rel-real": "-",
	}
	for k, v := range want {
		if got[k] != v {
			t.Fatalf("%s: %q, want %q (all: %v)", k, got[k], v, got)
		}
	}
}

func TestFsEndpointsAreLoopbackOnly(t *testing.T) {
	root := t.TempDir()
	// A bridge that does not listen on loopback answers 403.
	remote := newEnv(t, nil)
	remote.wantError(t, "GET", "/v1/fs/dirs?path="+url.QueryEscape(root+"/"), nil, http.StatusForbidden, "forbidden")
	remote.wantError(t, "GET", "/v1/fs/recent", nil, http.StatusForbidden, "forbidden")

	e := fsEnv(t)
	get := func(path string, hdr map[string]string) int {
		req, _ := http.NewRequest("GET", e.url+path, nil)
		for k, v := range hdr {
			if k == "Host" {
				req.Host = v
			} else {
				req.Header.Set(k, v)
			}
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_ = resp.Body.Close()
		return resp.StatusCode
	}
	p := "/v1/fs/dirs?path=" + url.QueryEscape(root+"/")
	if s := get(p, map[string]string{"Origin": "http://localhost:1420"}); s != 200 {
		t.Fatalf("allowed origin = %d", s)
	}
	if s := get(p, map[string]string{"Origin": "https://evil.example"}); s != 403 {
		t.Fatalf("foreign origin = %d", s)
	}
	if s := get(p, map[string]string{"Host": "rebind.example:8790"}); s != 403 {
		t.Fatalf("foreign Host = %d", s)
	}
	if s := get("/v1/fs/recent", map[string]string{"Origin": "https://evil.example"}); s != 403 {
		t.Fatalf("recent, foreign origin = %d", s)
	}
}

func TestFsRecentIsTheFoldersOfProjectsNewestFirst(t *testing.T) {
	e := fsEnv(t)
	base := t.TempDir()
	mkdirs(t, base, "one", "two", "three", "Мой проект")
	if err := os.MkdirAll(filepath.Join(base, "three", ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(base, "three", ".git", "HEAD"), []byte("ref: refs/heads/main\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	mk := func(name string, folders ...string) {
		var fs []map[string]string
		for _, f := range folders {
			fs = append(fs, map[string]string{"path": filepath.Join(base, f)})
		}
		e.into(t, "POST", "/v1/projects", map[string]any{"name": name, "folders": fs}, 201, nil)
	}
	mk("a", "one")
	mk("b", "two", "one") // "one" again: listed once, at its newest place
	mk("c", "three")
	mk("d", "Мой проект")
	var r dirsResp
	e.into(t, "GET", "/v1/fs/recent", nil, 200, &r)
	if !eq(r.names(), []string{"Мой проект", "three", "two", "one"}) {
		t.Fatalf("recent = %v", r.names())
	}
	if r.Entries[1].Git == nil || r.Entries[1].Git.Branch != "main" || r.Entries[0].Git != nil {
		t.Fatalf("git = %+v / %+v", r.Entries[1].Git, r.Entries[0].Git)
	}
	if r.Entries[0].Path != filepath.Join(base, "Мой проект") {
		t.Fatalf("path = %q", r.Entries[0].Path)
	}
}

func TestFsRecentCapsAtEightAndSkipsMissingFolders(t *testing.T) {
	e := fsEnv(t)
	base := t.TempDir()
	for i := 0; i < 12; i++ {
		mkdirs(t, base, fmt.Sprintf("f%02d", i))
		e.into(t, "POST", "/v1/projects", map[string]any{"name": "p", "folders": []map[string]string{{"path": filepath.Join(base, fmt.Sprintf("f%02d", i))}}}, 201, nil)
	}
	_ = os.RemoveAll(filepath.Join(base, "f11")) // the newest is gone
	var r dirsResp
	e.into(t, "GET", "/v1/fs/recent", nil, 200, &r)
	if len(r.Entries) != 8 || r.Entries[0].Name != "f10" || r.Entries[7].Name != "f03" {
		t.Fatalf("recent = %v", r.names())
	}
	// No projects at all: an empty list, not null.
	status, raw := fsEnv(t).do(t, "GET", "/v1/fs/recent", nil)
	if status != 200 || !strings.Contains(string(raw), `"entries":[]`) {
		t.Fatalf("%d %s", status, raw)
	}
}
