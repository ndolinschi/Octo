package projectstore

import (
	"strings"
	"unicode"
)

// The Russian Snowball stemmer (the "Russian" algorithm of snowballstem.org),
// written out here because the harness takes no outside module for it, plus a
// fold of ё to е and the removal of a fleeting vowel, so that "скобок" and
// "скобками" meet. It is used on both sides of the stemmed search index: the
// words of a document when it is indexed and the words of a query.

var (
	ruVowels = "аеиоуыэюя"

	ruPerfGerund1 = []string{"вшись", "вши", "в"} // preceded by а or я
	ruPerfGerund2 = []string{"ившись", "ывшись", "ивши", "ывши", "ив", "ыв"}
	ruReflexive   = []string{"ся", "сь"}
	ruAdjective   = []string{"ими", "ыми", "его", "ого", "ему", "ому", "ее", "ие", "ые", "ое", "ей", "ий", "ый", "ой", "ем", "им", "ым", "ом", "их", "ых", "ую", "юю", "ая", "яя", "ою", "ею"}
	ruParticiple1 = []string{"ем", "нн", "вш", "ющ", "щ"} // preceded by а or я
	ruParticiple2 = []string{"ивш", "ывш", "ующ"}
	ruVerb1       = []string{"ете", "йте", "нно", "ешь", "ла", "на", "ли", "ем", "ло", "но", "ет", "ют", "ны", "ть", "й", "л", "н"} // preceded by а or я
	ruVerb2       = []string{"ейте", "уйте", "ила", "ыла", "ена", "ите", "или", "ыли", "ило", "ыло", "ено", "ует", "уют", "ены", "ить", "ыть", "ишь", "ей", "уй", "ил", "ыл", "им", "ым", "ен", "ят", "ит", "ыт", "ую", "ю"}
	ruNoun        = []string{"иями", "иях", "иям", "ией", "ями", "ами", "ией", "ием", "ия", "ье", "ье", "ие", "ию", "ью", "ья", "ев", "ов", "еи", "ии", "ей", "ой", "ий", "ям", "ем", "ам", "ом", "ах", "ях", "ея", "ея", "а", "е", "и", "й", "о", "у", "ы", "ь", "ю", "я"}
	ruSuperlative = []string{"ейше", "ейш"}
	ruDeriv       = []string{"ость", "ост"}
)

// longestSuffix returns the longest of list that ends word and lies wholly in
// the region starting at rune index from ("" when none does).
func longestSuffix(word []rune, from int, list []string) string {
	best, bestLen := "", 0
	for _, s := range list {
		n := len([]rune(s))
		if n > bestLen && len(word)-n >= from && string(word[len(word)-n:]) == s {
			best, bestLen = s, n
		}
	}
	return best
}

func ruIsVowel(r rune) bool { return strings.ContainsRune(ruVowels, r) }

// ruRegions returns the start of RV (after the first vowel) and of R2.
func ruRegions(w []rune) (rv, r2 int) {
	rv, r2 = len(w), len(w)
	for i, r := range w {
		if ruIsVowel(r) {
			rv = i + 1
			break
		}
	}
	// R1: after the first non-vowel that follows a vowel; R2 the same inside R1.
	r1 := len(w)
	for i := 1; i < len(w); i++ {
		if !ruIsVowel(w[i]) && ruIsVowel(w[i-1]) {
			r1 = i + 1
			break
		}
	}
	for i := r1 + 1; i < len(w); i++ {
		if !ruIsVowel(w[i]) && ruIsVowel(w[i-1]) {
			r2 = i + 1
			break
		}
	}
	return rv, r2
}

// stripAfterAYa removes the longest suffix of list that is preceded by а or я
// (the "group 1" endings of the algorithm); ok says one was removed.
func stripAfterAYa(w []rune, rv int, list []string) ([]rune, bool) {
	s := longestSuffix(w, rv+1, list)
	if s == "" {
		return w, false
	}
	k := len(w) - len([]rune(s))
	if k > 0 && (w[k-1] == 'а' || w[k-1] == 'я') && k-1 >= rv {
		return w[:k], true
	}
	return w, false
}

func strip(w []rune, rv int, list []string) ([]rune, bool) {
	s := longestSuffix(w, rv, list)
	if s == "" {
		return w, false
	}
	return w[:len(w)-len([]rune(s))], true
}

// adjectival removes an adjective ending and, before it, a participle one.
func adjectival(w []rune, rv int) ([]rune, bool) {
	w2, ok := strip(w, rv, ruAdjective)
	if !ok {
		return w, false
	}
	if w3, ok := stripAfterAYa(w2, rv, ruParticiple1); ok {
		return w3, true
	}
	if w3, ok := strip(w2, rv, ruParticiple2); ok {
		return w3, true
	}
	return w2, true
}

// StemRU stems one lower-case Russian word (ё already folded to е).
func StemRU(word string) string {
	w := []rune(word)
	rv, r2 := ruRegions(w)
	if rv >= len(w) {
		return word // no vowel: nothing to stem
	}
	// Step 1: perfective gerund; else reflexive, then adjectival, verb or noun.
	if w2, ok := stripAfterAYa(w, rv, ruPerfGerund1); ok {
		w = w2
	} else if w2, ok := strip(w, rv, ruPerfGerund2); ok {
		w = w2
	} else {
		if w2, ok := strip(w, rv, ruReflexive); ok {
			w = w2
		}
		if w2, ok := adjectival(w, rv); ok {
			w = w2
		} else if w2, ok := stripAfterAYa(w, rv, ruVerb1); ok {
			w = w2
		} else if w2, ok := strip(w, rv, ruVerb2); ok {
			w = w2
		} else if w2, ok := strip(w, rv, ruNoun); ok {
			w = w2
		}
	}
	// Step 2: a final "и".
	if n := len(w); n > rv && w[n-1] == 'и' {
		w = w[:n-1]
	}
	// Step 3: a derivational ending in R2.
	if w2, ok := strip(w, max(r2, rv), ruDeriv); ok {
		w = w2
	}
	// Step 4: "нн" becomes "н"; a superlative goes (and "нн" again); a final "ь" goes.
	if n := len(w); n >= 2 && w[n-1] == 'н' && w[n-2] == 'н' {
		w = w[:n-1]
	} else {
		if w2, ok := strip(w, rv, ruSuperlative); ok {
			w = w2
			if n := len(w); n >= 2 && w[n-1] == 'н' && w[n-2] == 'н' {
				w = w[:n-1]
			}
		}
		if n := len(w); n > rv && w[n-1] == 'ь' {
			w = w[:n-1]
		}
	}
	return string(w)
}

// dropFleeting removes the fleeting vowel of a stem that ends consonant, о or
// е, consonant ("скобок" -> "скобк", "порог" -> "порг"), so the forms with and
// without it share a stem. Applied alike to documents and queries.
func dropFleeting(s string) string {
	w := []rune(s)
	n := len(w)
	if n >= 5 && (w[n-2] == 'о' || w[n-2] == 'е') && !ruIsVowel(w[n-1]) && !ruIsVowel(w[n-3]) && w[n-1] != 'й' {
		return string(append(w[:n-2:n-2], w[n-1]))
	}
	return s
}

func isCyrillic(s string) bool {
	for _, r := range s {
		if unicode.Is(unicode.Cyrillic, r) {
			return true
		}
	}
	return false
}

// FoldRU lower-cases and folds ё to е.
func FoldRU(s string) string {
	return strings.NewReplacer("ё", "е", "Ё", "е").Replace(strings.ToLower(s))
}

// StemWord is the stem a word is indexed and searched under: a Cyrillic word is
// folded and stemmed, any other word is just lower-cased.
func StemWord(w string) string {
	w = FoldRU(w)
	if !isCyrillic(w) {
		return w
	}
	return dropFleeting(StemRU(w))
}

// StemText turns text into the space-separated stems of its words.
func StemText(s string) string {
	words := FieldsWords(s)
	out := make([]string, 0, len(words))
	for _, w := range words {
		out = append(out, StemWord(w))
	}
	return strings.Join(out, " ")
}

// FieldsWords splits text into words (letters, digits, underscore).
func FieldsWords(s string) []string {
	return strings.FieldsFunc(s, func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) && r != '_' })
}
