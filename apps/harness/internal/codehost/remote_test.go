package codehost

import "testing"

func TestParseRemoteURL(t *testing.T) {
	cases := []struct {
		in                string
		host, owner, repo string
		ok                bool
	}{
		{"https://github.com/acme/widgets.git", "github.com", "acme", "widgets", true},
		{"https://github.com/acme/widgets", "github.com", "acme", "widgets", true},
		{"https://user:tok@ghe.example.com/acme/widgets.git", "ghe.example.com", "acme", "widgets", true},
		{"https://GHE.Example.com:8443/acme/widgets/", "ghe.example.com:8443", "acme", "widgets", true},
		{"git@ghe.example.com:acme/widgets.git", "ghe.example.com", "acme", "widgets", true},
		{"ssh://git@ghe.example.com:2222/acme/widgets.git", "ghe.example.com:2222", "acme", "widgets", true},
		{"ssh://git@ghe.example.com/group/sub/widgets.git", "ghe.example.com", "sub", "widgets", true},
		{"/tmp/origin repo.git", "", "", "", false},
		{"file:///tmp/origin.git", "", "", "", false},
		{"C:\\work\\repo", "", "", "", false},
		{"../origin.git", "", "", "", false},
		{"https://ghe.example.com/onlyone", "", "", "", false},
		{"", "", "", "", false},
	}
	for _, c := range cases {
		h, o, r, ok := ParseRemoteURL(c.in)
		if ok != c.ok || h != c.host || o != c.owner || r != c.repo {
			t.Errorf("ParseRemoteURL(%q) = %q %q %q %v, want %q %q %q %v", c.in, h, o, r, ok, c.host, c.owner, c.repo, c.ok)
		}
	}
}

func TestPickRemotePrefersTheRepositoryThenOrigin(t *testing.T) {
	rs := []Remote{
		{Name: "fork", Host: "github.com", Owner: "me", Repo: "widgets"},
		{Name: "origin", Host: "ghe.example.com", Owner: "acme", Repo: "widgets"},
		{Name: "upstream", Host: "github.com", Owner: "oss", Repo: "widgets"},
	}
	if r, _ := PickRemote(rs, "oss/widgets"); r.Name != "upstream" {
		t.Fatalf("by repo = %s", r.Name)
	}
	if r, _ := PickRemote(rs, ""); r.Name != "origin" {
		t.Fatalf("default = %s", r.Name)
	}
	if r, _ := PickRemote(rs, "nobody/else"); r.Name != "origin" {
		t.Fatalf("unknown repo = %s", r.Name)
	}
	if _, ok := PickRemote(nil, ""); ok {
		t.Fatal("no remotes must not pick")
	}
}
