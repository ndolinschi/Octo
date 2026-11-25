package orchestrator

import (
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
	"github.com/ndolinschi/Octo/apps/harness/internal/router"
)

func TestCouldNotReadsTheMarkerAtTheStartOfTheReport(t *testing.T) {
	for _, s := range []string{"Could not do it: x", "  **Could not do it**: x", "could NOT do it.", "# Could not do it"} {
		if !couldNot(s) {
			t.Errorf("%q not read as could-not", s)
		}
	}
	for _, s := range []string{"Done. I could not do it any faster.", "", "Could not reproduce, but fixed anyway"} {
		if couldNot(s) {
			t.Errorf("%q read as could-not", s)
		}
	}
}

func TestSameWorkMatchesTitlesOrMostlyEqualBriefs(t *testing.T) {
	if !sameWork("Fix the  Parser", "a", "fix the parser", "b") {
		t.Error("same title")
	}
	if !sameWork("A", "make the parser accept trailing commas", "B", "make the parser accept trailing commas, really") {
		t.Error("mostly equal briefs")
	}
	if sameWork("A", "make the parser accept trailing commas", "B", "write the release notes for version two") {
		t.Error("different work")
	}
	if sameWork("", "fix it", "", "fix it") {
		t.Error("briefs of under three words never match")
	}
}

func TestOnlyFailuresThatSayAnythingAboutTheCandidateEscalate(t *testing.T) {
	cases := []struct {
		run  spawnRun
		want string
	}{
		{spawnRun{status: router.StatusAgentError}, router.StatusAgentError},
		{spawnRun{status: router.StatusTimedOut}, router.StatusTimedOut},
		{spawnRun{status: router.StatusFailed}, router.StatusFailed},
		{spawnRun{status: router.StatusFailed, errKind: "budget"}, ""},
		{spawnRun{status: router.StatusStopped}, ""},
		{spawnRun{status: router.StatusCompleted, signal: router.SignalCouldNot}, "could_not"},
		{spawnRun{status: router.StatusCompleted, signal: router.SignalDone}, ""},
		{spawnRun{status: router.StatusCompleted, signal: router.SignalNone}, ""},
	}
	for _, c := range cases {
		if got := c.run.failed(); got != c.want {
			t.Errorf("%+v: failed() = %q, want %q", c.run, got, c.want)
		}
	}
	if nextTier(projectstore.TierFast) != projectstore.TierBalanced || nextTier(projectstore.TierDeep) != "" {
		t.Error("nextTier")
	}
}
