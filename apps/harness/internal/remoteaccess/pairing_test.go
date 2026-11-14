package remoteaccess

import (
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
	if got := p.Claim(typed); got != "" {
		t.Fatalf("right code typed loosely = %q", got)
	}
	if got := p.Claim(code); got != "pairing_code_invalid" {
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
	if got := p.Claim(code); got != "pairing_code_expired" {
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
	if got := p.Claim(old); got != "pairing_code_invalid" {
		t.Fatalf("old code = %q", got)
	}
	if got := p.Claim(fresh); got != "" {
		t.Fatalf("new code = %q", got)
	}
}

func TestWrongCodesLock(t *testing.T) {
	p := newPairing(CodeTTL, 0, newClock().now)
	code, _ := p.Issue()
	for i := 1; i < MaxWrongTry; i++ {
		if got := p.Claim("ZZZZZZZZ"); got != "pairing_code_invalid" {
			t.Fatalf("wrong try %d = %q", i, got)
		}
	}
	if got := p.Claim("ZZZZZZZZ"); got != "pairing_locked" {
		t.Fatalf("5th wrong try = %q", got)
	}
	if got := p.Claim(code); got != "pairing_locked" {
		t.Fatalf("right code after the lock = %q", got)
	}
	code2, _ := p.Issue()
	if got := p.Claim(code2); got != "" {
		t.Fatalf("a new code after the lock = %q", got)
	}
}

func TestClaimsAreSpaced(t *testing.T) {
	clk := newClock()
	p := newPairing(CodeTTL, time.Second, clk.now)
	code, _ := p.Issue()
	if got := p.Claim("ZZZZZZZZ"); got != "pairing_code_invalid" {
		t.Fatal(got)
	}
	if got := p.Claim(code); got != "pairing_rate_limited" {
		t.Fatalf("second claim in the same second = %q", got)
	}
	clk.add(time.Second)
	if got := p.Claim(code); got != "" {
		t.Fatalf("after a second = %q", got)
	}
}
