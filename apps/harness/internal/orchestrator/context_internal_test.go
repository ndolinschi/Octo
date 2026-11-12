package orchestrator

import "testing"

func TestScaleTo(t *testing.T) {
	for _, tc := range []struct {
		name  string
		parts []int64
		total int64
	}{
		{"exact", []int64{10, 20, 30}, 60},
		{"scale up", []int64{1, 1, 1}, 10},
		{"scale down", []int64{500, 300, 7, 0, 1}, 100},
		{"rounding", []int64{1, 1, 1}, 100},
		{"single", []int64{0, 5, 0}, 3},
	} {
		t.Run(tc.name, func(t *testing.T) {
			out := scaleTo(tc.parts, tc.total)
			var sum int64
			for i, v := range out {
				if v < 0 || (tc.parts[i] == 0 && v != 0) {
					t.Fatalf("out = %v", out)
				}
				sum += v
			}
			if sum != tc.total {
				t.Fatalf("sum(%v) = %d, want %d", out, sum, tc.total)
			}
		})
	}
	// A non-empty part never rounds down to nothing while there is room.
	for total := int64(4); total < 3000; total++ {
		out := scaleTo([]int64{531, 2128, 35, 1, 0}, total)
		var sum int64
		for i, v := range out {
			if v < 0 || (i == 3 && v == 0) {
				t.Fatalf("total %d: out = %v", total, out)
			}
			sum += v
		}
		if sum != total {
			t.Fatalf("total %d: sum = %d (%v)", total, sum, out)
		}
	}
	if out := scaleTo([]int64{0, 0}, 5); out[0]+out[1] != 0 {
		t.Fatalf("nothing to scale: %v", out)
	}
}
