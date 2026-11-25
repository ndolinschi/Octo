package codehost

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestGHListPRsLimit(t *testing.T) {
	d := t.TempDir()
	script := `#!/bin/bash
d="${0%/*}"
printf '%s\n' "$*" >> "$d/calls.log"
case "$1 $2" in
  "api user") echo '{"login":"me"}' ;;
  "pr list")
    if [[ "$*" == *"review-requested:@me"* ]]; then
      echo '[{"number":2}]'
    else
      echo '[{"number":1,"title":"Mine","author":{"login":"me"},"isDraft":false,"url":"https://github.com/o/r/pull/1","headRefName":"a","baseRefName":"main","headRefOid":"h1","additions":1,"deletions":0,"changedFiles":1,"createdAt":"2026-11-01T00:00:00Z","updatedAt":"2026-11-02T00:00:00Z","reviewDecision":"","labels":[],"comments":[],"latestReviews":[],"statusCheckRollup":[]},{"number":2,"title":"Review me","author":{"login":"bob"},"isDraft":false,"url":"https://github.com/o/r/pull/2","headRefName":"b","baseRefName":"main","headRefOid":"h2","additions":2,"deletions":1,"changedFiles":1,"createdAt":"2026-11-01T00:00:00Z","updatedAt":"2026-11-03T00:00:00Z","reviewDecision":"","labels":[],"comments":[],"latestReviews":[{"author":{"login":"me"},"body":"nit","state":"COMMENTED","commit":{"oid":"h1"}}],"statusCheckRollup":[]}]'
    fi
    ;;
  *) echo "unexpected: $*" >&2; exit 2 ;;
esac
`
	if err := os.WriteFile(filepath.Join(d, "gh"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", d)

	g := NewGH()
	prs, err := g.ListPRsLimit(context.Background(), d, Repo{Owner: "o", Name: "r", Host: "github.com"}, 31)
	if err != nil {
		t.Fatalf("ListPRsLimit: %v", err)
	}
	if len(prs) != 2 {
		t.Fatalf("len = %d, want 2", len(prs))
	}
	if !prs[0].Mine || prs[0].ReviewRequested {
		t.Fatalf("pr 1 = %+v", prs[0])
	}
	if prs[1].Mine || !prs[1].ReviewRequested || !prs[1].ReviewedByMe || !prs[1].NewSinceMyReview || prs[1].Comments != 1 {
		t.Fatalf("pr 2 = %+v", prs[1])
	}

	callsBytes, err := os.ReadFile(filepath.Join(d, "calls.log"))
	if err != nil {
		t.Fatal(err)
	}
	calls := string(callsBytes)
	if !strings.Contains(calls, "--limit 31") {
		t.Fatalf("expected --limit 31 in calls:\n%s", calls)
	}
}
