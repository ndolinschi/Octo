package remoteaccess

import (
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
)

type clock struct {
	mu sync.Mutex
	t  time.Time
}

func newClock() *clock { return &clock{t: time.Date(2026, 11, 14, 12, 0, 0, 0, time.UTC)} }

func (c *clock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *clock) add(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

func TestCodeShape(t *testing.T) {
	p := newPairing(CodeTTL, 0, newClock().now)
	seen := map[string]bool{}
	for range 200 {
		c, _ := p.Issue()
		if len(c) != CodeLength {
			t.Fatalf("code %q has length %d", c, len(c))
		}
		for _, r := range c {
			if !strings.ContainsRune(crockford, r) {
				t.Fatalf("code %q has %q, not in Crockford's alphabet", c, r)
			}
		}
		seen[c] = true
	}
	if len(seen) < 195 {
		t.Fatalf("only %d distinct codes of 200", len(seen))
	}
	if FormatCode("ABCDEFGH") != "ABCD-EFGH" {
		t.Fatal("format")
	}
}

func TestClaimSingleUseAndNormalised(t *testing.T) {
	clk := newClock()
	p := newPairing(CodeTTL, 0, clk.now)
	code, _ := p.Issue()
	typed := strings.ToLower(code[:4] + " - " + code[4:])
	typed = strings.NewReplacer("0", "o", "1", "l").Replace(typed)
	if got := p.Claim(typed, "a"); got != "" {
		t.Fatalf("right code typed loosely = %q", got)
	}
	if got := p.Claim(code, "a"); got != "pairing_code_invalid" {
		t.Fatalf("second use = %q, want pairing_code_invalid", got)
	}
}

func TestClaimExpires(t *testing.T) {
	clk := newClock()
	p := newPairing(CodeTTL, 0, clk.now)
	code, exp := p.Issue()
	if !exp.Equal(clk.now().Add(5 * time.Minute)) {
		t.Fatalf("expires %v", exp)
	}
	clk.add(5*time.Minute + time.Second)
	if c, _ := p.Code(); c != "" {
		t.Fatal("an expired code is still shown")
	}
	if got := p.Claim(code, "a"); got != "pairing_code_expired" {
		t.Fatalf("expired = %q", got)
	}
}

func TestNewCodeReplacesOld(t *testing.T) {
	p := newPairing(CodeTTL, 0, newClock().now)
	old, _ := p.Issue()
	fresh, _ := p.Issue()
	if old == fresh {
		t.Skip("two equal random codes")
	}
	if got := p.Claim(old, "a"); got != "pairing_code_invalid" {
		t.Fatalf("old code = %q", got)
	}
	if got := p.Claim(fresh, "a"); got != "" {
		t.Fatalf("new code = %q", got)
	}
}

// Wrong guesses count per source: the source that guessed wrong waits, longer each time, and the code stays good for
// everyone else, so nobody can burn a code by guessing (security review finding 8). Only a flood of wrong guesses
// from many sources burns it.
func TestWrongCodesBackOffPerSource(t *testing.T) {
	clk := newClock()
	p := newPairing(CodeTTL, 0, clk.now)
	code, _ := p.Issue()
	for i := 1; i < MaxWrongTry; i++ {
		if got := p.Claim("ZZZZZZZZ", "evil"); got != "pairing_code_invalid" {
			t.Fatalf("wrong try %d = %q", i, got)
		}
	}
	if got := p.Claim("ZZZZZZZZ", "evil"); got != "pairing_backoff" {
		t.Fatalf("5th wrong try = %q", got)
	}
	if got := p.Claim(code, "evil"); got != "pairing_backoff" {
		t.Fatalf("the right code from the source that is waiting = %q", got)
	}
	if wait := p.Wait("evil"); wait != firstBackoff {
		t.Fatalf("wait = %v", wait)
	}
	clk.add(firstBackoff)
	if got := p.Claim("ZZZZZZZZ", "evil"); got != "pairing_backoff" {
		t.Fatalf("a wrong try after the wait = %q", got)
	}
	if wait := p.Wait("evil"); wait != 2*firstBackoff {
		t.Fatalf("second wait = %v, want it doubled", wait)
	}
	if got := p.Claim(code, "phone"); got != "" {
		t.Fatalf("the right code from another source = %q", got)
	}
}

func TestManyWrongSourcesBurnTheCode(t *testing.T) {
	p := newPairing(CodeTTL, 0, newClock().now)
	code, _ := p.Issue()
	got := ""
	for i := 0; i < MaxWrongTotal; i++ {
		got = p.Claim("ZZZZZZZZ", fmt.Sprintf("bot-%d", i))
	}
	if got != "pairing_locked" {
		t.Fatalf("wrong try %d = %q", MaxWrongTotal, got)
	}
	if got := p.Claim(code, "phone"); got != "pairing_locked" {
		t.Fatalf("right code after the burn = %q", got)
	}
	code2, _ := p.Issue()
	if got := p.Claim(code2, "phone"); got != "" {
		t.Fatalf("a new code after the burn = %q", got)
	}
}

func TestClaimsAreSpaced(t *testing.T) {
	clk := newClock()
	p := newPairing(CodeTTL, time.Second, clk.now)
	code, _ := p.Issue()
	if got := p.Claim("ZZZZZZZZ", "a"); got != "pairing_code_invalid" {
		t.Fatal(got)
	}
	if got := p.Claim(code, "a"); got != "pairing_rate_limited" {
		t.Fatalf("second claim in the same second = %q", got)
	}
	clk.add(time.Second)
	if got := p.Claim(code, "a"); got != "" {
		t.Fatalf("after a second = %q", got)
	}
}
