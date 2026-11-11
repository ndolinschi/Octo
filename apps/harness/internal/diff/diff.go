// Package diff counts the lines added and removed between two texts.
//
// It is a line diff (Myers, O(ND)) after trimming the common head and tail.
// Past MaxCost edits it stops looking for the shortest script and reports the
// whole differing middle as removed and added, which overstates but never
// understates a change; Exact says which happened.
package diff

import "strings"

// MaxCost bounds the Myers search (edit script length, added + removed).
const MaxCost = 4000

// Lines splits text into lines, each keeping its newline; "" has no lines.
func Lines(s string) []string {
	if s == "" {
		return nil
	}
	l := strings.SplitAfter(s, "\n")
	if l[len(l)-1] == "" {
		l = l[:len(l)-1]
	}
	return l
}

// Count returns the lines added and removed going from a to b.
func Count(a, b string) (added, removed int) {
	added, removed, _ = CountExact(a, b)
	return added, removed
}

// CountExact is Count that also reports whether the numbers are the minimum
// edit script (false once the cost bound was hit).
func CountExact(a, b string) (added, removed int, exact bool) {
	if a == b {
		return 0, 0, true
	}
	x, y := Lines(a), Lines(b)
	for len(x) > 0 && len(y) > 0 && x[0] == y[0] {
		x, y = x[1:], y[1:]
	}
	for len(x) > 0 && len(y) > 0 && x[len(x)-1] == y[len(y)-1] {
		x, y = x[:len(x)-1], y[:len(y)-1]
	}
	if len(x) == 0 || len(y) == 0 {
		return len(y), len(x), true
	}
	d, ok := shortest(x, y)
	if !ok {
		return len(y), len(x), false
	}
	// d = added + removed and added - removed = len(y) - len(x).
	added = (d + len(y) - len(x)) / 2
	return added, d - added, true
}

// shortest returns the length of the shortest edit script, or false past MaxCost.
func shortest(a, b []string) (int, bool) {
	n, m := len(a), len(b)
	maxD := min(n+m, MaxCost)
	off := maxD + 1
	v := make([]int, 2*maxD+3)
	for d := 0; d <= maxD; d++ {
		for k := -d; k <= d; k += 2 {
			var x int
			if k == -d || (k != d && v[off+k-1] < v[off+k+1]) {
				x = v[off+k+1]
			} else {
				x = v[off+k-1] + 1
			}
			y := x - k
			for x < n && y < m && a[x] == b[y] {
				x++
				y++
			}
			v[off+k] = x
			if x >= n && y >= m {
				return d, true
			}
		}
	}
	return 0, false
}
