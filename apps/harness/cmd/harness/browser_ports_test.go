package main

import "testing"

// The Browser tab's proxy must not reach Octo's own services on this computer: the bridge, the router the harness
// talks to, and the remote-access listener (security review finding 10).
func TestProxyBlockedPorts(t *testing.T) {
	for _, c := range []struct {
		base string
		want []int
	}{
		{"", []int{8790}},
		{"http://127.0.0.1:8791", []int{8790, 8791}},
		{"http://localhost:9000/v1", []int{8790, 9000}},
		{"http://[::1]:7000", []int{8790, 7000}},
		{"http://127.0.0.1", []int{8790, 80}},
		{"https://api.anthropic.com", []int{8790}},
		{"http://192.168.1.4:8791", []int{8790}},
	} {
		got := proxyBlockedPorts(8790, c.base)
		if len(got) != len(c.want) {
			t.Errorf("%q: %v, want %v", c.base, got, c.want)
			continue
		}
		for i := range got {
			if got[i] != c.want[i] {
				t.Errorf("%q: %v, want %v", c.base, got, c.want)
			}
		}
	}
}
