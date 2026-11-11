package diff

import "testing"

func TestCount(t *testing.T) {
	cases := []struct {
		name, a, b string
		add, rem   int
	}{
		{"same", "a\nb\n", "a\nb\n", 0, 0},
		{"created", "", "a\nb\nc\n", 3, 0},
		{"emptied", "a\nb\n", "", 0, 2},
		{"one line changed", "a\nb\nc\n", "a\nX\nc\n", 1, 1},
		{"insert", "a\nc\n", "a\nb\nc\n", 1, 0},
		{"delete", "a\nb\nc\n", "a\nc\n", 0, 1},
		{"no final newline", "a\nb", "a\nb\nc", 2, 1},
		{"moved block", "a\nb\nc\nd\n", "c\nd\na\nb\n", 2, 2},
	}
	for _, c := range cases {
		a, r := Count(c.a, c.b)
		if a != c.add || r != c.rem {
			t.Errorf("%s: got +%d -%d, want +%d -%d", c.name, a, r, c.add, c.rem)
		}
	}
}

func TestCountCostBound(t *testing.T) {
	var a, b []byte
	for i := 0; i < 5000; i++ {
		a = append(a, []byte("a"+string(rune('0'+i%10))+"\n")...)
		b = append(b, []byte("b"+string(rune('0'+i%10))+"\n")...)
	}
	add, rem, exact := CountExact(string(a), string(b))
	if exact || add != 5000 || rem != 5000 {
		t.Fatalf("got +%d -%d exact=%v", add, rem, exact)
	}
}
