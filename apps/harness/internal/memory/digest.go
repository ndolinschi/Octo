package memory

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

// DigestFact is one fact the digest found; Supersedes names (by its text) the
// earlier fact it contradicts.
type DigestFact struct {
	Text       string `json:"text"`
	Supersedes string `json:"supersedes"`
	// About is the fact's subject in a few words, when the digest gives one. Without it the fact is about its task
	// (the task's title), so the Knowledge view groups what the harness learnt instead of piling it under "General".
	About string `json:"about"`
}

// Digest is what the side model returns for one finished turn.
type Digest struct {
	Goal        string       `json:"goal"`
	Constraints []string     `json:"constraints"`
	Acceptance  []string     `json:"acceptance"`
	Quotes      []string     `json:"quotes"`
	Decisions   []string     `json:"decisions"`
	Outcome     string       `json:"outcome"`
	Facts       []DigestFact `json:"facts"`
	// Continues is the id of an earlier task this exchange continues (a
	// follow-up); empty when it is a new piece of work.
	Continues string `json:"continues"`
	// State is what is done and what is left (M6 rule 4).
	State string `json:"state"`
	// OpenQuestions are unanswered questions or decisions still needed from the user.
	OpenQuestions []string `json:"open_questions"`
	// GoalMet is the digest's verdict: nil when it did not say, true closes the task, false keeps it open.
	GoalMet *bool `json:"goal_met"`
}

// ParseDigest reads the model's answer: the JSON object in it, however it is wrapped.
func ParseDigest(text string) (Digest, error) {
	var d Digest
	i, j := strings.Index(text, "{"), strings.LastIndex(text, "}")
	if i < 0 || j < i {
		return d, fmt.Errorf("no JSON object in the digest")
	}
	if err := json.Unmarshal([]byte(text[i:j+1]), &d); err != nil {
		return d, fmt.Errorf("digest is not valid JSON: %w", err)
	}
	return d, nil
}

func norm(s string) string { return strings.ToLower(strings.Join(strings.Fields(s), " ")) }

func words(s string) map[string]bool {
	m := map[string]bool{}
	for _, w := range projectstore.Terms(s) {
		m[w] = true
	}
	return m
}

// similar is the Jaccard overlap of the words of a and b.
func similar(a, b string) float64 {
	x, y := words(a), words(b)
	if len(x) == 0 || len(y) == 0 {
		return 0
	}
	n := 0
	for w := range x {
		if y[w] {
			n++
		}
	}
	return float64(n) / float64(len(x)+len(y)-n)
}

// ApplyDigest merges a digest into one task. It only fills and adds: the goal
// is replaced only while it is a rule's rewrite (or an earlier digest's), the
// outcome only while empty, lists only grow, quotes must be in the user's
// request, and nothing the orchestrator or the user wrote is changed or
// deleted. A fact that contradicts an earlier one marks that one superseded
// (the text and date stay). Which task a turn's digest belongs to, and whether
// the turn makes one at all, is SettleTurn's decision.
func (s *Service) ApplyDigest(ctx context.Context, taskID string, messageID int64, d Digest) (projectstore.Task, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	t, err := s.DB.Task(ctx, taskID)
	if err != nil {
		return t, err
	}
	s.applyDigest(ctx, &t, messageID, d)
	t, err = s.DB.SaveTask(ctx, t)
	if err == nil {
		s.publish("task.updated", map[string]any{"task": t})
	}
	return t, err
}

// applyDigest fills t from d in memory (the caller saves). s.mu is held.
func (s *Service) applyDigest(ctx context.Context, t *projectstore.Task, messageID int64, d Digest) {
	if g := strings.TrimSpace(s.redact(d.Goal)); g != "" && (t.GoalBy == "" || t.GoalBy == "harness" || t.GoalBy == "rule" || t.GoalBy == "digest") {
		t.Goal, t.GoalBy = clip(g, MaxGoal), "digest"
	}
	if o := strings.TrimSpace(s.redact(d.Outcome)); o != "" && t.Outcome == "" {
		t.Outcome = clip(o, MaxOutcome)
	}
	red := func(l []string) []string {
		out := make([]string, len(l))
		for i, v := range l {
			out[i] = s.redact(v)
		}
		return cleanList(out, MaxItem)
	}
	// Lists are best effort: past the cap the rest is dropped, not an error.
	t.Constraints, _ = addUnique(t.Constraints, red(d.Constraints), MaxItems)
	t.Acceptance, _ = addUnique(t.Acceptance, red(d.Acceptance), MaxItems)
	t.Decisions, _ = addUnique(t.Decisions, red(d.Decisions), MaxItems)
	if text, _, _, _, merr := s.DB.MessageText(ctx, messageID); merr == nil {
		text = s.redact(text)
		for _, q := range red(d.Quotes) {
			if strings.Contains(text, q) && len(t.Quotes) < MaxItems {
				exists := false
				for _, x := range t.Quotes {
					exists = exists || x.Text == q
				}
				if !exists {
					t.Quotes = append(t.Quotes, projectstore.Quote{Text: q, MessageID: messageID})
				}
			}
		}
	}
	s.applyFacts(ctx, t, messageID, d.Facts)
}

// applyFacts adds the digest's facts to t (a duplicate of a current one is
// skipped; "supersedes" marks the best matching current fact, in t or in any
// other task). s.mu is held.
func (s *Service) applyFacts(ctx context.Context, t *projectstore.Task, messageID int64, facts []DigestFact) {
	now := projectstore.Now()
	for _, f := range facts {
		text := clip(strings.TrimSpace(s.redact(f.Text)), MaxItem)
		if text == "" || len(t.Facts) >= MaxFacts {
			continue
		}
		dup := false
		for _, e := range t.Facts {
			dup = dup || (e.SupersededBy == "" && norm(e.Text) == norm(text))
		}
		if dup {
			continue
		}
		nf := projectstore.Fact{ID: nextFactID(t.Facts), Text: text, Date: now, MessageID: messageID, About: factAbout(s.redact(f.About), t)}
		if old := strings.TrimSpace(f.Supersedes); old != "" {
			if i := matchFact(t.Facts, s.redact(old)); i >= 0 {
				t.Facts[i].SupersededBy = nf.ID
			} else {
				s.supersedeElsewhere(ctx, t.ID, s.redact(old), t.ID+"/"+nf.ID)
			}
		}
		t.Facts = append(t.Facts, nf)
	}
}

// factAbout is the subject of a fact the harness learnt: the digest's own, else the title of its task. The Remembered
// record has no subject (its facts are not about any piece of work).
func factAbout(digestAbout string, t *projectstore.Task) string {
	about := strings.TrimSpace(digestAbout)
	if about == "" && t.Title != RememberedTaskTitle {
		about = strings.TrimSpace(t.Title)
	}
	return clip(about, 120)
}

// supersedeElsewhere marks the current fact of another task that the new fact
// (named by "task/fact id") contradicts. The older fact keeps its text and date.
func (s *Service) supersedeElsewhere(ctx context.Context, except, old, by string) {
	tasks, err := s.DB.Tasks(ctx)
	if err != nil {
		return
	}
	for _, o := range tasks {
		if o.ID == except {
			continue
		}
		if i := matchFact(o.Facts, old); i >= 0 {
			o.Facts[i].SupersededBy = by
			if o, err = s.DB.SaveTask(ctx, o); err == nil {
				s.publish("task.updated", map[string]any{"task": o})
			}
			return
		}
	}
}

// KnownFacts lists the current facts of all tasks, newest first, at most n (the
// digest sees them, so it can say which one a new fact replaces).
func (s *Service) KnownFacts(ctx context.Context, except string, n int) []string {
	tasks, err := s.DB.Tasks(ctx)
	if err != nil {
		return nil
	}
	var out []string
	for _, t := range tasks {
		if t.ID == except {
			continue
		}
		for i := len(t.Facts) - 1; i >= 0; i-- {
			if f := t.Facts[i]; f.SupersededBy == "" && len(out) < n {
				out = append(out, f.Text)
			}
		}
	}
	return out
}

// matchFact finds the current fact a digest says is superseded: the same text,
// else the most similar one (at least half the words in common).
func matchFact(facts []projectstore.Fact, old string) int {
	best, bi := 0.0, -1
	for i, f := range facts {
		if f.SupersededBy != "" {
			continue
		}
		if norm(f.Text) == norm(old) {
			return i
		}
		if sc := similar(f.Text, old); sc >= 0.5 && sc > best {
			best, bi = sc, i
		}
	}
	return bi
}

// DigestPrompt is the system prompt of the side model's digest call (and, for
// an ACP orchestrator, the head of the one prompt asked in its live session).
const DigestPrompt = `You maintain the memory of a software project. You read one finished exchange (the user's request, the orchestrator's final reply, and what the harness observed the turn do) and you return ONLY a JSON object:
{"goal": "<the user's goal rewritten as a goal in one or two sentences, NOT the request's first words; empty only if the exchange states no goal>",
 "state": "<what is done and what is left, one to three sentences>",
 "goal_met": <true if the goal of this exchange is fully met, false if work remains or the user must answer something>,
 "constraints": ["..."], "acceptance": ["..."],
 "open_questions": ["<a question still unanswered or a decision still needed from the user>"],
 "quotes": ["<exact words of the user's request that must not be paraphrased: names, numbers, paths, commands, acceptance criteria>"],
 "decisions": ["..."], "outcome": "<what was done, empty if nothing yet>",
 "continues": "<the id of an earlier task listed above that this exchange continues (a follow-up, a correction, the next step of it), else empty>",
 "facts": [{"text": "<a short standalone statement, e.g. 'CI runs on Rust 1.88'>", "about": "<its subject in a few words, e.g. 'CI', else empty>", "supersedes": "<text of an earlier fact it contradicts, else empty>"}]}
A question that was only answered is not a goal: leave constraints, acceptance, decisions and open_questions empty for it. Quotes must be copied character for character from the request. Facts must stand alone, without "it" or "this". Leave out what is already in the record. Never invent. Empty lists are fine.`

// DigestInput builds the capped user message of the digest call: the exchange,
// what the harness saw the turn do, the facts already known, and the earlier
// tasks of the session this exchange might continue.
func DigestInput(w TurnWork, known []string, candidates ...projectstore.Task) string {
	var b strings.Builder
	if len(candidates) > 0 {
		b.WriteString("Earlier tasks this exchange may continue:\n")
		for _, c := range candidates {
			fmt.Fprintf(&b, "- [%s] (%s) %s: %s\n", c.ID, c.Status, clip(c.Title, 80), clip(c.Goal, 160))
		}
	}
	for _, k := range known {
		fmt.Fprintf(&b, "fact (other task): %s\n", k)
	}
	fmt.Fprintf(&b, "Observed by the harness: %s\n", w.Observed())
	fmt.Fprintf(&b, "\nUser request:\n%s\n\nOrchestrator's final reply:\n%s\n", clip(w.Request, 6000), clip(w.Reply, 4000))
	return clip(b.String(), 14000)
}

// Now is the current time; tests may replace it.
var Now = time.Now
