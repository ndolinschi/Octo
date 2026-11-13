package gitx

import (
	"testing"
)

func TestParsePatchNumbersLinesAndMarksNoNewline(t *testing.T) {
	patch := "diff --git a/f b/f\nindex 1..2 100644\n--- a/f\n+++ b/f\n@@ -3,3 +3,4 @@ func x()\n ctx\n-old\n+new\n+added\n tail\n\\ No newline at end of file\n"
	res := ParsePatch([]byte(patch))
	if len(res.Hunks) != 1 || res.Binary {
		t.Fatalf("res = %+v", res)
	}
	h := res.Hunks[0]
	if h.OldStart != 3 || h.OldLines != 3 || h.NewStart != 3 || h.NewLines != 4 || h.Header != "func x()" {
		t.Fatalf("header = %+v", h)
	}
	want := []Line{
		{Type: "context", Old: 3, New: 3, Text: "ctx"},
		{Type: "del", Old: 4, Text: "old"},
		{Type: "add", New: 4, Text: "new"},
		{Type: "add", New: 5, Text: "added"},
		{Type: "context", Old: 5, New: 6, Text: "tail", NoNewline: true},
	}
	if len(h.Lines) != len(want) {
		t.Fatalf("lines = %+v", h.Lines)
	}
	for i, l := range want {
		if h.Lines[i] != l {
			t.Fatalf("line %d = %+v, want %+v", i, h.Lines[i], l)
		}
	}
}

func TestParsePatchBinary(t *testing.T) {
	res := ParsePatch([]byte("diff --git a/x.png b/x.png\nBinary files a/x.png and b/x.png differ\n"))
	if !res.Binary || len(res.Hunks) != 0 {
		t.Fatalf("res = %+v", res)
	}
}

func TestParseRawPairsRenames(t *testing.T) {
	raw := ":100644 100644 " + sha('a') + " " + sha('b') + " M\x00dir with space/файл.go\x00" +
		":100644 100644 " + sha('c') + " " + sha('c') + " R100\x00old.go\x00новое.go\x00" +
		":000000 100644 " + zeros() + " " + sha('d') + " A\x00new.txt\x00"
	files, by, err := parseRaw([]byte(raw))
	if err != nil || len(files) != 3 {
		t.Fatalf("files = %+v %v", files, err)
	}
	if files[0].Path != "dir with space/файл.go" || files[0].Status != "modified" {
		t.Fatalf("0 = %+v", files[0])
	}
	if f := files[1]; f.Status != "renamed" || f.OldPath != "old.go" || f.Path != "новое.go" || f.Sim != 100 {
		t.Fatalf("1 = %+v", f)
	}
	if f := files[2]; f.Status != "added" || f.OldBlob != "" || f.NewBlob == "" {
		t.Fatalf("2 = %+v", f)
	}
	if by["новое.go"] != 1 {
		t.Fatalf("index = %v", by)
	}
	nums := parseNumstat([]byte("3\t1\tdir with space/файл.go\x00" + "0\t0\t\x00old.go\x00новое.go\x00" + "-\t-\tlogo.png\x00"))
	if len(nums) != 3 || nums[0].added != 3 || nums[1].path != "новое.go" || !nums[2].binary {
		t.Fatalf("nums = %+v", nums)
	}
}

func TestValidRefName(t *testing.T) {
	for s, want := range map[string]bool{"main": true, "feature/x-1": true, "v1.2.3": true, "": false, "-x": false, "--upload-pack=y": false, "a b": false, "a..b": false, "a\nb": false} {
		if ValidRefName(s) != want {
			t.Errorf("ValidRefName(%q) = %v", s, !want)
		}
	}
}

func sha(c byte) string {
	b := make([]byte, 40)
	for i := range b {
		b[i] = c
	}
	return string(b)
}

func zeros() string { return sha('0') }
