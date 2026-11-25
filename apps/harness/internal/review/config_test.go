package review_test

import (
	"context"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

func TestReviewConfigFoldsConfiguredGlobsAndIsReturnedWithTheReview(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	v := f.openPR(1)
	if v.Config.Prefer != "auto" || len(v.Config.MechanicalGlobs) != 0 || v.Config.Commands == nil {
		t.Fatalf("default config = %+v", v.Config)
	}
	before := byPath(f.files(v.ID).Files, "README.md")
	if before.Group == "mechanical" || before.Folded {
		t.Fatalf("README.md before = %+v", before)
	}

	cfg := `{"commands":["Tests"],"mechanical_globs":["*.md","src/session.go"],"prefer":"unified"}`
	if err := f.db.SetSetting(ctx, projectstore.SettingReviewConfig, cfg); err != nil {
		t.Fatal(err)
	}
	files := f.files(v.ID) // the cached order is not reused: the globs are part of its key
	for _, p := range []string{"README.md", "src/session.go"} {
		got := byPath(files.Files, p)
		if got.Group != "mechanical" || got.Reason != "configured" || !got.Folded {
			t.Fatalf("%s = group %s reason %s folded %v", p, got.Group, got.Reason, got.Folded)
		}
	}
	// Built-in reasons win, and an unmatched core file stays core.
	if got := byPath(files.Files, "package-lock.json"); got.Reason != "lockfile" {
		t.Fatalf("lock file reason = %s", got.Reason)
	}
	if got := byPath(files.Files, "src/auth.go"); got.Group != "core" {
		t.Fatalf("src/auth.go = %s", got.Group)
	}
	// They sort with the mechanical group (last) and count in the totals.
	last := files.Files[len(files.Files)-1]
	if last.Group != "mechanical" || files.Total.Mechanical < 5 {
		t.Fatalf("order/totals: last %s, mechanical %d", last.Group, files.Total.Mechanical)
	}

	got, err := f.svc.Get(ctx, f.pid, v.ID)
	if err != nil || got.Config.Prefer != "unified" || len(got.Config.Commands) != 1 || got.Config.Commands[0] != "Tests" ||
		len(got.Config.MechanicalGlobs) != 2 || got.Totals.Mechanical != files.Total.Mechanical {
		t.Fatalf("review config = %+v totals %+v %v", got.Config, got.Totals, err)
	}

	// Removing the globs unfolds them again.
	if err := f.db.DeleteSetting(ctx, projectstore.SettingReviewConfig); err != nil {
		t.Fatal(err)
	}
	if got := byPath(f.files(v.ID).Files, "README.md"); got.Group == "mechanical" {
		t.Fatal("README.md still folded after the globs were removed")
	}
}
