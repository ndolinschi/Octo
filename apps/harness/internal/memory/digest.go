package memory

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

// DigestFact is one fact the digest found; Supersedes names (by its text) the
// earlier fact it contradicts.
type DigestFact struct {
	Text       string `json:"text"`
	Supersedes string `json:"supersedes"`
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
}

// DigestOpts tunes ApplyDigest.
type DigestOpts struct {
	// DropIfEmpty deletes the turn's record, when the harness opened it and
	// nobody edited it, if the digest found nothing worth keeping (no fact,
	// decision, quote, constraint or acceptance criterion): a trivial exchange
	// leaves no task record.
	DropIfEmpty bool
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

// ApplyDigest merges a digest into the turn's task. It only fills and adds:
// the goal is replaced only while it is the harness's fallback (or an earlier
// digest's), the outcome only while empty, lists only grow, quotes must be in
// the user's request, and nothing the orchestrator or the user wrote is
// changed or deleted. A fact that contradicts an earlier one marks that one
// superseded (the text and date stay).
func (s *Service) ApplyDigest(ctx context.Context, taskID string, messageID int64, d Digest) (projectstore.Task, error) {
	return s.ApplyDigestOpts(ctx, taskID, messageID, d, DigestOpts{})
}

// ApplyDigestOpts is ApplyDigest with options. When the digest says the turn
// continues another task, the turn's message joins that task, the turn's own
// record (if untouched) is deleted and the digest is merged into the other
// task, which is closed again (the turn is over) with the new outcome; the
// returned task is the one the digest went to. A task deleted for being empty
// is returned with its ID so the caller can tell.
func (s *Service) ApplyDigestOpts(ctx context.Context, taskID string, messageID int64, d Digest, opts DigestOpts) (projectstore.Task, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	t, err := s.DB.Task(ctx, taskID)
	if err != nil {
		return t, err
	}
	if c := strings.TrimSpace(d.Continues); c != "" && c != taskID {
		if target, terr := s.DB.Task(ctx, c); terr == nil && target.Status != projectstore.TaskDropped {
			own := t
			if !slices.Contains(target.MessageIDs, messageID) {
				target.MessageIDs = append(target.MessageIDs, messageID)
			}
			target.Files, _ = addUnique(target.Files, own.Files, MaxItems)
			if own.Auto {
				if err := s.DB.DeleteTask(ctx, own.ID); err == nil {
					s.publish("task.updated", map[string]any{"task_id": own.ID, "deleted": true})
				}
			}
			t = target
			t.Status = projectstore.TaskDone // the follow-up's turn is over
			if o := strings.TrimSpace(s.redact(d.Outcome)); o != "" {
				t.Outcome = clip(o, MaxOutcome)
			}
			d.Outcome = ""
			opts.DropIfEmpty = false
		}
	}
	if g := strings.TrimSpace(s.redact(d.Goal)); g != "" && (t.GoalBy == "harness" || t.GoalBy == "digest") {
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
	now := projectstore.Now()
	for _, f := range d.Facts {
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
		nf := projectstore.Fact{ID: fmt.Sprintf("f%d", len(t.Facts)+1), Text: text, Date: now, MessageID: messageID}
		if old := strings.TrimSpace(f.Supersedes); old != "" {
			if i := matchFact(t.Facts, s.redact(old)); i >= 0 {
				t.Facts[i].SupersededBy = nf.ID
			} else {
				s.supersedeElsewhere(ctx, t.ID, s.redact(old), t.ID+"/"+nf.ID)
			}
		}
		t.Facts = append(t.Facts, nf)
	}
	if opts.DropIfEmpty && t.Auto && len(t.Facts)+len(t.Decisions)+len(t.Quotes)+len(t.Constraints)+len(t.Acceptance) == 0 {
		if err := s.DB.DeleteTask(ctx, t.ID); err == nil {
			s.publish("task.updated", map[string]any{"task_id": t.ID, "deleted": true})
		}
		return t, nil
	}
	t, err = s.DB.SaveTask(ctx, t)
	if err == nil {
		s.publish("task.updated", map[string]any{"task": t})
	}
	return t, err
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

// DigestPrompt is the system prompt of the side model's digest call.
const DigestPrompt = `You maintain the memory of a software project. You read one finished exchange (the user's request, the orchestrator's final reply) and the task record so far, and you return ONLY a JSON object:
{"goal": "<one or two sentences: what the user wants, empty if the record's goal is right>",
 "constraints": ["..."], "acceptance": ["..."],
 "quotes": ["<exact words of the user's request that must not be paraphrased: names, numbers, paths, commands, acceptance criteria>"],
 "decisions": ["..."], "outcome": "<what was done, empty if nothing yet>",
 "continues": "<the id of an earlier task listed above that this exchange continues (a follow-up, a correction, the next step of it), else empty>",
 "facts": [{"text": "<a short standalone statement, e.g. 'CI runs on Rust 1.88'>", "supersedes": "<text of an earlier fact it contradicts, else empty>"}]}
Quotes must be copied character for character from the request. Facts must stand alone, without "it" or "this". Leave out what is already in the record. Never invent. Empty lists are fine.`

// DigestInput builds the capped user message of the digest call. candidates are
// earlier tasks this exchange might continue.
func DigestInput(t projectstore.Task, known []string, request, reply string, candidates ...projectstore.Task) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Task record so far:\ntitle: %s\ngoal: %s\n", t.Title, t.Goal)
	if len(candidates) > 0 {
		b.WriteString("Earlier tasks this exchange may continue:\n")
		for _, c := range candidates {
			fmt.Fprintf(&b, "- [%s] (%s) %s: %s\n", c.ID, c.Status, clip(c.Title, 80), clip(c.Goal, 160))
		}
	}
	for _, f := range t.Facts {
		if f.SupersededBy == "" {
			fmt.Fprintf(&b, "fact (%s): %s\n", f.Date[:10], f.Text)
		}
	}
	for _, k := range known {
		fmt.Fprintf(&b, "fact (other task): %s\n", k)
	}
	fmt.Fprintf(&b, "\nUser request:\n%s\n\nOrchestrator's final reply:\n%s\n", clip(request, 6000), clip(reply, 4000))
	return clip(b.String(), 14000)
}

// Now is the current time; tests may replace it.
var Now = time.Now
