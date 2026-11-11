package projectstore

import (
	"context"
	"database/sql"
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Kinds of a search document.
const (
	DocTask    = "task"
	DocFact    = "fact"
	DocFile    = "file"
	DocMessage = "message"
)

// Doc is one searchable item. Ref identifies it within its kind (task id,
// "task/fact id", file path, message id).
type Doc struct {
	Kind, Ref, Title, Body, Date string
	Superseded                   bool
	MessageID                    int64
	TaskID                       string
}

// execer is a database or a transaction.
type execer interface {
	ExecContext(ctx context.Context, q string, args ...any) (sql.Result, error)
	QueryContext(ctx context.Context, q string, args ...any) (*sql.Rows, error)
}

// putDoc inserts or replaces the document (kind, ref) in both indexes.
func putDoc(ctx context.Context, x execer, d Doc) error {
	if err := delDoc(ctx, x, d.Kind, d.Ref); err != nil {
		return err
	}
	res, err := x.ExecContext(ctx,
		`INSERT INTO search_docs (kind, ref, title, body, date, superseded, message_id, task_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		d.Kind, d.Ref, d.Title, d.Body, d.Date, d.Superseded, d.MessageID, d.TaskID)
	if err != nil {
		return err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return err
	}
	for _, t := range []string{"search_u", "search_t"} {
		if _, err := x.ExecContext(ctx, `INSERT INTO `+t+` (rowid, title, body) VALUES (?, ?, ?)`, id, d.Title, d.Body); err != nil {
			return err
		}
	}
	return nil
}

// delDoc removes the document (kind, ref); with prefix semantics for a ref
// ending in "/": every document whose ref starts with it.
func delDoc(ctx context.Context, x execer, kind, ref string) error {
	q, arg := `SELECT id FROM search_docs WHERE kind = ? AND ref = ?`, ref
	if strings.HasSuffix(ref, "/") {
		q, arg = `SELECT id FROM search_docs WHERE kind = ? AND substr(ref, 1, ?) = ?`, ref
	}
	var rows *sql.Rows
	var err error
	if strings.HasSuffix(ref, "/") {
		rows, err = x.QueryContext(ctx, q, kind, len(ref), arg)
	} else {
		rows, err = x.QueryContext(ctx, q, kind, arg)
	}
	if err != nil {
		return err
	}
	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			_ = rows.Close()
			return err
		}
		ids = append(ids, id)
	}
	if err := rows.Close(); err != nil {
		return err
	}
	for _, id := range ids {
		for _, t := range []string{"search_u", "search_t"} {
			if _, err := x.ExecContext(ctx, `DELETE FROM `+t+` WHERE rowid = ?`, id); err != nil {
				return err
			}
		}
		if _, err := x.ExecContext(ctx, `DELETE FROM search_docs WHERE id = ?`, id); err != nil {
			return err
		}
	}
	return nil
}

// Hit is one search result before shaping.
type Hit struct {
	Doc
	// Exact is true when the exact-word index matched (ranked first).
	Exact bool
}

// SearchQuery is a lexical search over the project's memory.
type SearchQuery struct {
	Text string
	// Kinds restricts the kinds (empty: all).
	Kinds []string
	// After (inclusive) and Before (exclusive) bound the document date; ISO
	// date or time strings, "" for open.
	After, Before string
	Limit         int
}

// MaxHits is the most hits a search returns.
const MaxHits = 10

// Terms splits a query into lower-case words.
func Terms(q string) []string {
	var out []string
	for _, w := range strings.FieldsFunc(q, func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) && r != '_' }) {
		if w = strings.ToLower(w); w != "" && !slices.Contains(out, w) {
			out = append(out, w)
		}
	}
	return out
}

// Stem trims the ending of a longer word so that inflected forms match as a
// substring in the trigram index ("бюджета" finds "бюджет"): 2 runes off a
// word of 5 to 7, 3 off a longer one; shorter words are used whole.
func Stem(w string) string {
	n := utf8.RuneCountInString(w)
	cut := 0
	switch {
	case n >= 8:
		cut = 3
	case n >= 5:
		cut = 2
	}
	r := []rune(w)
	return string(r[:len(r)-cut])
}

func ftsPhrase(s string) string { return `"` + strings.ReplaceAll(s, `"`, `""`) + `"` }

// Search runs both indexes (exact words, then substrings and stems), merges
// them with exact hits first, and puts superseded facts after current ones.
func (d *DB) Search(ctx context.Context, q SearchQuery) ([]Hit, error) {
	terms := Terms(q.Text)
	if len(terms) == 0 {
		return nil, nil
	}
	limit := q.Limit
	if limit <= 0 || limit > MaxHits {
		limit = MaxHits
	}
	var exact, loose []string
	for _, t := range terms {
		exact = append(exact, ftsPhrase(t))
		if utf8.RuneCountInString(t) >= 3 {
			loose = append(loose, ftsPhrase(Stem(t)))
		}
	}
	var hits []Hit
	seen := map[int64]bool{}
	run := func(table string, match []string, op string, isExact bool) error {
		if len(match) == 0 {
			return nil
		}
		ids, err := d.matchIDs(ctx, table, strings.Join(match, op), q)
		if err != nil {
			return err
		}
		for _, h := range ids {
			if !seen[h.id] {
				seen[h.id] = true
				h.Hit.Exact = isExact
				hits = append(hits, h.Hit)
			}
		}
		return nil
	}
	// All words first. Failing that, the significant words (no stop words, at
	// least 4 characters) any of which may match, kept only when at least half of
	// them are in the document: a long natural-language question still finds its
	// document, and a question about something that is not there finds nothing.
	if err := run("search_u", exact, " AND ", true); err != nil {
		return nil, err
	}
	if err := run("search_t", loose, " AND ", false); err != nil {
		return nil, err
	}
	if len(hits) == 0 && len(terms) > 1 {
		sig := significant(terms)
		if len(sig) > 0 {
			var sx, sl []string
			for _, t := range sig {
				sx, sl = append(sx, ftsPhrase(t)), append(sl, ftsPhrase(Stem(t)))
			}
			before := len(hits)
			_ = run("search_u", sx, " OR ", true)
			_ = run("search_t", sl, " OR ", false)
			need := (len(sig) + 1) / 2
			kept := hits[:before]
			for _, h := range hits[before:] {
				if containsTerms(h.Doc, sig) >= need {
					kept = append(kept, h)
				}
			}
			hits = kept
		}
	}
	// Exact first (stable), then current before superseded.
	slices.SortStableFunc(hits, func(a, b Hit) int {
		if a.Superseded != b.Superseded {
			if a.Superseded {
				return 1
			}
			return -1
		}
		if a.Exact != b.Exact {
			if a.Exact {
				return -1
			}
			return 1
		}
		return 0
	})
	if len(hits) > limit {
		hits = hits[:limit]
	}
	return hits, nil
}

type idHit struct {
	id int64
	Hit
}

func (d *DB) matchIDs(ctx context.Context, table, match string, q SearchQuery) ([]idHit, error) {
	sqlq := `SELECT d.id, d.kind, d.ref, d.title, d.body, d.date, d.superseded, d.message_id, d.task_id
		FROM ` + table + ` JOIN search_docs d ON d.id = ` + table + `.rowid WHERE ` + table + ` MATCH ?`
	args := []any{match}
	if len(q.Kinds) > 0 {
		sqlq += ` AND d.kind IN (?` + strings.Repeat(`,?`, len(q.Kinds)-1) + `)`
		for _, k := range q.Kinds {
			args = append(args, k)
		}
	}
	if q.After != "" {
		sqlq += ` AND d.date >= ?`
		args = append(args, q.After)
	}
	if q.Before != "" {
		sqlq += ` AND d.date < ?`
		args = append(args, q.Before)
	}
	sqlq += ` ORDER BY ` + table + `.rank LIMIT 50`
	rows, err := d.sql.QueryContext(ctx, sqlq, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []idHit
	for rows.Next() {
		var h idHit
		if err := rows.Scan(&h.id, &h.Kind, &h.Ref, &h.Title, &h.Body, &h.Date, &h.Superseded, &h.MessageID, &h.TaskID); err != nil {
			return nil, err
		}
		out = append(out, h)
	}
	return out, rows.Err()
}

var stopWords = map[string]bool{}

func init() {
	for _, w := range strings.Fields(`about above after again also another because been before being between both could does doing done from have having here into just like more most much must need nothing only other over really same should some such than that their them then there these they this those very want was were what when where which while will with would your
	что как это так вот для или его она они тоже чтобы если when было были быть этот эта эти того там тут уже ещё еще при про под над без между после перед через какой какая какие какое кто где когда почему зачем нужно можно надо будет есть нет`) {
		stopWords[w] = true
	}
}

// significant keeps the words worth searching for alone.
func significant(terms []string) []string {
	var out []string
	for _, t := range terms {
		if utf8.RuneCountInString(t) >= 4 && !stopWords[t] {
			out = append(out, t)
		}
	}
	return out
}

// containsTerms counts the terms whose stem occurs in the document.
func containsTerms(d Doc, terms []string) int {
	text := strings.ToLower(d.Title + " " + d.Body)
	n := 0
	for _, t := range terms {
		if strings.Contains(text, Stem(t)) {
			n++
		}
	}
	return n
}
