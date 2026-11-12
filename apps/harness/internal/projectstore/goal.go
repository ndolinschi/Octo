package projectstore

import (
	"strings"
	"unicode"
)

// goalPrefixes are the fillers a request starts with that are not part of the
// goal (longest first, matched case-insensitively at the start).
var goalPrefixes = []string{
	"could you please", "can you please", "would you please", "i would like you to", "i want you to", "i need you to",
	"i would like to", "i want to", "i need to", "could you", "can you", "would you", "will you", "let's", "lets",
	"please", "hey,", "hi,", "hello,", "hey", "hi", "hello", "kindly",
	"пожалуйста,", "пожалуйста", "можешь ли ты", "можешь", "можно", "помоги мне", "помоги", "давай", "привет,", "привет",
}

// GoalFromRequest is the minimal rewrite of a request into a goal, by rule and
// without a model: the first line and sentence, fillers ("please", "can you",
// "пожалуйста") and a closing question mark removed, first letter upper-case,
// at most 160 characters. An empty request gives "".
func GoalFromRequest(text string) string {
	t := strings.TrimSpace(text)
	if i := strings.IndexAny(t, "\n\r"); i >= 0 {
		t = t[:i]
	}
	t = strings.Join(strings.Fields(t), " ")
	for changed := true; changed; {
		changed = false
		low := strings.ToLower(t)
		for _, p := range goalPrefixes {
			rest, ok := strings.CutPrefix(low, p)
			if ok && (rest == "" || strings.HasSuffix(p, ",") || !isWordRune(firstRune(rest))) {
				t = strings.TrimLeft(t[len(p):], " ,:-")
				changed = true
				break
			}
		}
	}
	for i, r := range t {
		if (r == '.' || r == '!' || r == '?') && i > 8 && i+1 < len(t) && t[i+1] == ' ' {
			t = t[:i]
			break
		}
	}
	t = strings.TrimRight(t, " ?!.,:;")
	if r := []rune(t); len(r) > 160 {
		t = strings.TrimSpace(string(r[:160])) + "…"
	}
	if t == "" {
		return ""
	}
	r := []rune(t)
	r[0] = unicode.ToUpper(r[0])
	return string(r)
}

func firstRune(s string) rune {
	for _, r := range s {
		return r
	}
	return ' '
}

func isWordRune(r rune) bool { return unicode.IsLetter(r) || unicode.IsDigit(r) }
