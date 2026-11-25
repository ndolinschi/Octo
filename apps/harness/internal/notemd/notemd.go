// Package notemd is the Markdown form of a project note: a front-matter block
// (title, description, tags, pinned and the fields the harness keeps) followed
// by a Markdown body, and the index of descriptions the model sees instead of
// the bodies. Everything here is a pure function.
package notemd

import (
	"bytes"
	"encoding/json"
	"fmt"
	"slices"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Limits of a note.
const (
	MaxDescription = 200  // characters, one line
	MaxTitle       = 200  // characters, one line
	MaxTags        = 12   // per note
	MaxTagLen      = 40   // characters
	MaxPinned      = 3    // pinned notes per project
	MaxPinnedChars = 2000 // body characters of all pinned notes together
	IndexBudget    = 1500 // tokens of the index the model sees
)

// Doc is a note as a document. The harness-kept fields (ID, CreatedAt,
// UpdatedAt, LastReadAt, ReadCount, DescriptionAuto) are written out and read
// back, but the API ignores them on input.
type Doc struct {
	ID              string
	Title           string
	Description     string
	DescriptionAuto bool
	Tags            []string
	Pinned          bool
	CreatedAt       string
	UpdatedAt       string
	LastReadAt      string
	ReadCount       int
	Body            string

	// HasFrontMatter is set by Parse: the source began with a front-matter block.
	HasFrontMatter bool
}

// ParseError is a front-matter error with the 1-based line it is on.
type ParseError struct {
	Line int
	Msg  string
}

func (e *ParseError) Error() string { return fmt.Sprintf("line %d: %s", e.Line, e.Msg) }

func perr(line int, format string, a ...any) error {
	return &ParseError{Line: line, Msg: fmt.Sprintf(format, a...)}
}

// Parse reads a note from Markdown source. A source that does not begin with a
// "---" line has no front matter: the whole text is the body. Parse does not
// require a title (see Validate).
func Parse(src string) (Doc, error) {
	src = strings.TrimPrefix(src, string(rune(0xFEFF)))
	src = strings.ReplaceAll(strings.ReplaceAll(src, "\r\n", "\n"), "\r", "\n")
	lines := strings.Split(src, "\n")
	if strings.TrimRight(lines[0], " \t") != "---" {
		return Doc{Body: src}, nil
	}
	d := Doc{HasFrontMatter: true}
	end := -1
	seen := map[string]bool{}
	listKey := "" // the key whose block list is being read
	for i := 1; i < len(lines); i++ {
		n := i + 1
		raw := strings.TrimRight(lines[i], " \t")
		if raw == "---" {
			end = i
			break
		}
		t := strings.TrimSpace(raw)
		if t == "" || strings.HasPrefix(t, "#") {
			continue
		}
		if strings.HasPrefix(t, "- ") || t == "-" {
			if listKey != "tags" {
				return Doc{}, perr(n, "a list item outside the tags list")
			}
			v, err := scalar(strings.TrimSpace(strings.TrimPrefix(t, "-")), n)
			if err != nil {
				return Doc{}, err
			}
			d.Tags = append(d.Tags, v)
			continue
		}
		listKey = ""
		if raw[0] == ' ' || raw[0] == '\t' {
			return Doc{}, perr(n, "unexpected indentation")
		}
		key, val, ok := strings.Cut(raw, ":")
		if !ok {
			return Doc{}, perr(n, "expected key: value")
		}
		key, val = strings.TrimSpace(key), strings.TrimSpace(val)
		if seen[key] {
			return Doc{}, perr(n, "duplicate key %q", key)
		}
		seen[key] = true
		if err := d.set(key, val, n, &listKey); err != nil {
			return Doc{}, err
		}
	}
	if end < 0 {
		return Doc{}, perr(1, "the front matter is not closed by a --- line")
	}
	body := strings.Join(lines[end+1:], "\n")
	d.Body = strings.TrimPrefix(body, "\n")
	return d, nil
}

func (d *Doc) set(key, val string, n int, listKey *string) error {
	str := func(dst *string) error {
		v, err := scalar(val, n)
		*dst = v
		return err
	}
	boolean := func(dst *bool) error {
		switch val {
		case "true":
			*dst = true
		case "false":
			*dst = false
		default:
			return perr(n, "%s must be true or false", key)
		}
		return nil
	}
	switch key {
	case "id":
		return str(&d.ID)
	case "title":
		return str(&d.Title)
	case "description":
		return str(&d.Description)
	case "created_at":
		return str(&d.CreatedAt)
	case "updated_at":
		return str(&d.UpdatedAt)
	case "last_read_at":
		return str(&d.LastReadAt)
	case "pinned":
		return boolean(&d.Pinned)
	case "description_auto":
		return boolean(&d.DescriptionAuto)
	case "read_count":
		c, err := strconv.Atoi(val)
		if err != nil || c < 0 {
			return perr(n, "read_count must be a number")
		}
		d.ReadCount = c
	case "tags":
		if val == "" {
			*listKey = "tags"
			return nil
		}
		tags, err := flowList(val, n)
		if err != nil {
			return err
		}
		d.Tags = tags
	}
	// Other keys are tolerated (a note exported by another tool) and dropped.
	return nil
}

// scalar reads a plain, "double quoted" or 'single quoted' value.
func scalar(v string, n int) (string, error) {
	switch {
	case v == "":
		return "", nil
	case v[0] == '"':
		var s string
		dec := json.NewDecoder(strings.NewReader(v))
		if err := dec.Decode(&s); err != nil {
			return "", perr(n, "bad double-quoted string")
		}
		if rest := strings.TrimSpace(v[dec.InputOffset():]); rest != "" {
			return "", perr(n, "unexpected text after the closing quote")
		}
		return s, nil
	case v[0] == '\'':
		if len(v) < 2 || v[len(v)-1] != '\'' {
			return "", perr(n, "unterminated single-quoted string")
		}
		return strings.ReplaceAll(v[1:len(v)-1], "''", "'"), nil
	}
	if i := strings.Index(v, " #"); i >= 0 {
		v = strings.TrimSpace(v[:i])
	}
	return v, nil
}

// flowList reads [a, "b, c", 'd'].
func flowList(v string, n int) ([]string, error) {
	if v[0] != '[' || v[len(v)-1] != ']' {
		return nil, perr(n, "tags must be a list: [a, b] or one item per line")
	}
	inner := v[1 : len(v)-1]
	var out []string
	var cur strings.Builder
	var quote rune
	flush := func() error {
		item := strings.TrimSpace(cur.String())
		cur.Reset()
		if item == "" {
			return nil
		}
		s, err := scalar(item, n)
		if err != nil {
			return err
		}
		out = append(out, s)
		return nil
	}
	esc := false
	for _, r := range inner {
		switch {
		case quote != 0:
			cur.WriteRune(r)
			if quote == '"' && r == '\\' && !esc {
				esc = true
				continue
			}
			if r == quote && !esc {
				quote = 0
			}
			esc = false
		case (r == '"' || r == '\'') && strings.TrimSpace(cur.String()) == "":
			quote = r
			cur.WriteRune(r)
		case r == ',':
			if err := flush(); err != nil {
				return nil, err
			}
		default:
			cur.WriteRune(r)
		}
	}
	if quote != 0 {
		return nil, perr(n, "unterminated quote in the tags list")
	}
	if err := flush(); err != nil {
		return nil, err
	}
	return out, nil
}

// Validate checks the fields a note must have. The error text is meant for the
// person or the model that sent the note.
func Validate(d Doc) error {
	t := strings.TrimSpace(d.Title)
	switch {
	case t == "":
		return fmt.Errorf("title is required")
	case strings.ContainsAny(t, "\n\r"):
		return fmt.Errorf("title must be one line")
	case utf8.RuneCountInString(t) > MaxTitle:
		return fmt.Errorf("title is longer than %d characters", MaxTitle)
	}
	if strings.ContainsAny(d.Description, "\n\r") {
		return fmt.Errorf("description must be one line")
	}
	if n := utf8.RuneCountInString(strings.TrimSpace(d.Description)); n > MaxDescription {
		return fmt.Errorf("description is %d characters; the limit is %d", n, MaxDescription)
	}
	if len(d.Tags) > MaxTags {
		return fmt.Errorf("at most %d tags", MaxTags)
	}
	for _, g := range d.Tags {
		switch {
		case strings.TrimSpace(g) == "":
			return fmt.Errorf("a tag is empty")
		case strings.ContainsAny(g, "\n\r"):
			return fmt.Errorf("a tag must be one line")
		case utf8.RuneCountInString(g) > MaxTagLen:
			return fmt.Errorf("a tag is longer than %d characters", MaxTagLen)
		}
	}
	return nil
}

// NormalizeTags trims, drops empty and repeated tags.
func NormalizeTags(tags []string) []string {
	out := []string{}
	for _, g := range tags {
		if g = strings.TrimSpace(g); g != "" && !slices.Contains(out, g) {
			out = append(out, g)
		}
	}
	return out
}

// Clip cuts s to at most n characters (runes), without an ellipsis.
func Clip(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n])
}

// AutoDescription is the description of a note that has none: the first
// non-empty line of the body, trimmed, at most MaxDescription characters.
func AutoDescription(body string) string {
	for _, l := range strings.Split(body, "\n") {
		if l = strings.TrimSpace(l); l != "" {
			return strings.TrimSpace(Clip(l, MaxDescription))
		}
	}
	return ""
}

// Serialize writes the note as Markdown with front matter. Parse(Serialize(d))
// returns d (but for HasFrontMatter).
func Serialize(d Doc) string {
	var b strings.Builder
	b.WriteString("---\n")
	field := func(k, v string) {
		if v != "" {
			b.WriteString(k + ": " + quote(v) + "\n")
		}
	}
	field("id", d.ID)
	b.WriteString("title: " + quote(d.Title) + "\n")
	b.WriteString("description: " + quote(d.Description) + "\n")
	if d.DescriptionAuto {
		b.WriteString("description_auto: true\n")
	}
	items := make([]string, len(d.Tags))
	for i, g := range d.Tags {
		items[i] = quote(g)
	}
	b.WriteString("tags: [" + strings.Join(items, ", ") + "]\n")
	b.WriteString("pinned: " + strconv.FormatBool(d.Pinned) + "\n")
	field("created_at", d.CreatedAt)
	field("updated_at", d.UpdatedAt)
	field("last_read_at", d.LastReadAt)
	if d.ReadCount > 0 {
		b.WriteString("read_count: " + strconv.Itoa(d.ReadCount) + "\n")
	}
	b.WriteString("---\n")
	if d.Body != "" {
		b.WriteString("\n" + d.Body)
	}
	return b.String()
}

// quote returns s as a YAML scalar: plain when that reads back as the same
// text, else double-quoted.
func quote(s string) string {
	if plainOK(s) {
		return s
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(s)
	return strings.TrimRight(buf.String(), "\n")
}

func plainOK(s string) bool {
	if s == "" || s != strings.TrimSpace(s) {
		return false
	}
	switch strings.ToLower(s) {
	case "true", "false", "null", "yes", "no", "on", "off", "~":
		return false
	}
	if strings.ContainsAny(s[:1], "-?:,[]{}#&*!|>'\"%@`") {
		return false
	}
	if strings.Contains(s, ": ") || strings.Contains(s, " #") || strings.HasSuffix(s, ":") || strings.ContainsAny(s, ",[]") {
		return false
	}
	for _, r := range s {
		if unicode.IsControl(r) {
			return false
		}
	}
	return true
}

// Entry is what the index needs of a note.
type Entry struct {
	ID, Title, Description string
	Tags                   []string
	Pinned                 bool
	UpdatedAt, LastReadAt  string
}

// IndexLine is one note in the index: "id · title — description [tags]".
func IndexLine(e Entry) string {
	var b strings.Builder
	b.WriteString(e.ID + " · " + Clip(oneLine(e.Title), 120))
	if d := oneLine(e.Description); d != "" {
		b.WriteString(" — " + Clip(d, MaxDescription))
	}
	if len(e.Tags) > 0 {
		tags := e.Tags
		if len(tags) > 5 {
			tags = tags[:5]
		}
		b.WriteString(" [" + Clip(strings.Join(tags, ", "), 80) + "]")
	}
	return b.String()
}

func oneLine(s string) string { return strings.Join(strings.Fields(s), " ") }

// MoreLine is the last index line when notes did not fit.
func MoreLine(n int) string {
	return fmt.Sprintf("%d more notes — use search_notes", n)
}

// Order sorts entries for the index: pinned first, then by the later of
// last_read_at and updated_at, newest first; equal times keep the later entry
// (the input is in creation order) first.
func Order(entries []Entry) []Entry {
	type item struct {
		e   Entry
		key string
		pos int
	}
	items := make([]item, len(entries))
	for i, e := range entries {
		items[i] = item{e, max(e.LastReadAt, e.UpdatedAt), i}
	}
	slices.SortFunc(items, func(a, b item) int {
		switch {
		case a.e.Pinned != b.e.Pinned:
			if a.e.Pinned {
				return -1
			}
			return 1
		case a.key != b.key:
			return strings.Compare(b.key, a.key)
		}
		return b.pos - a.pos
	})
	out := make([]Entry, len(items))
	for i, it := range items {
		out[i] = it.e
	}
	return out
}

// BuildIndex returns the index lines that fit budget tokens (estimate turns a
// character count into tokens; a line costs its characters plus its newline),
// including the "N more notes" line when some did not fit, and how many notes
// were left out.
func BuildIndex(entries []Entry, budget int64, estimate func(chars int) int64) (lines []string, more int) {
	ordered := Order(entries)
	all := make([]string, len(ordered))
	var total int64
	for i, e := range ordered {
		all[i] = IndexLine(e)
		total += estimate(len(all[i]) + 1)
	}
	if total <= budget {
		return all, 0
	}
	var used int64
	for i, l := range all {
		cost := estimate(len(l) + 1)
		left := len(all) - i
		if used+cost+estimate(len(MoreLine(left))+1) > budget {
			break
		}
		used += cost
		lines = append(lines, l)
	}
	more = len(all) - len(lines)
	return append(lines, MoreLine(more)), more
}

// CheckPinned verifies the pin limits for the bodies (in characters) of the
// notes that would be pinned.
func CheckPinned(bodies []int) error {
	if len(bodies) > MaxPinned {
		return fmt.Errorf("at most %d notes can be pinned; unpin one first", MaxPinned)
	}
	total := 0
	for _, n := range bodies {
		total += n
	}
	if total > MaxPinnedChars {
		return fmt.Errorf("pinned notes together can hold at most %d characters (these would be %d); shorten them or unpin one", MaxPinnedChars, total)
	}
	return nil
}
