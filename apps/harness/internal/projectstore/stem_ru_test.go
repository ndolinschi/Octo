package projectstore

import "testing"

func TestStemWordMeetsInflectedForms(t *testing.T) {
	for _, tc := range []struct{ a, b string }{
		{"калькуляторами", "калькулятор"},
		{"скобками", "скобок"},
		{"молдове", "Молдовы"},
		{"Кишинев", "Кишинёв"},
		{"бюджета", "бюджет"},
		{"бюджетами", "бюджету"},
		{"проекты", "проекта"},
		{"программами", "программа"},
		{"читаю", "читали"},
		{"красивый", "красивая"},
		{"настройками", "настройка"},
		{"файлов", "файлы"},
		{"ошибки", "ошибкой"},
	} {
		if x, y := StemWord(tc.a), StemWord(tc.b); x != y {
			t.Errorf("%q -> %q, %q -> %q: want one stem", tc.a, x, tc.b, y)
		}
	}
	for _, tc := range []struct{ a, b string }{
		{"бюджет", "проект"}, {"молдова", "кишинев"}, {"скобка", "стена"},
	} {
		if StemWord(tc.a) == StemWord(tc.b) {
			t.Errorf("%q and %q share a stem %q", tc.a, tc.b, StemWord(tc.a))
		}
	}
}

func TestStemWordLeavesOtherScriptsAndShortWords(t *testing.T) {
	for in, want := range map[string]string{"Budget": "budget", "ABC123": "abc123", "я": "я", "да": "да", "go": "go"} {
		if got := StemWord(in); got != want {
			t.Errorf("StemWord(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestSnowballRussianKnownStems(t *testing.T) {
	// Reference stems of the Snowball Russian algorithm (before the fleeting-vowel fold).
	for in, want := range map[string]string{
		"вавиловка": "вавиловк", "вагнера": "вагнер", "вагона": "вагон", "вагоне": "вагон", "вагонов": "вагон",
		"абсолютно": "абсолютн", "абсолютный": "абсолютн", "красавица": "красавиц", "красивая": "красив",
		"бегущий": "бегущ", "книгами": "книг", "книге": "книг", "книги": "книг",
	} {
		if got := StemRU(in); got != want {
			t.Errorf("StemRU(%q) = %q, want %q", in, got, want)
		}
	}
}
