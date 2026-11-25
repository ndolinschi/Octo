package remoteaccess

import (
	"crypto/rand"
	"crypto/subtle"
	"strings"
	"sync"
	"time"
)

// crockford is Crockford's base32 alphabet: no I, L, O, U (nothing to confuse, nothing rude).
const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

// Pairing defaults.
const (
	CodeLength   = 8
	CodeTTL      = 5 * time.Minute
	MaxWrongTry  = 5
	ClaimSpacing = time.Second
	// MaxWrongTotal wrong guesses of one code, from all sources together, burn it (a flood from many addresses).
	MaxWrongTotal = 200
	// maxSources bounds the per-source table of one code; a new source beyond it is told to wait.
	maxSources = 4096
	// firstBackoff is how long a source waits after MaxWrongTry wrong guesses; each further wrong guess doubles it,
	// up to maxBackoff.
	firstBackoff = 30 * time.Second
	maxBackoff   = 15 * time.Minute
)

// Pairing holds the one pairing code the computer shows. A code is single use and expires. Claims are counted per
// source (the address Cloudflare saw, see claimSource): a source's claims are spaced at least ClaimSpacing apart, and
// after MaxWrongTry wrong guesses it waits, longer each time, while the code stays good for everyone else. Only
// MaxWrongTotal wrong guesses in all burn the code.
type Pairing struct {
	mu      sync.Mutex
	code    string
	expires time.Time
	wrong   int // all sources
	locked  bool
	sources map[string]*claimant
	spacing time.Duration
	ttl     time.Duration
	now     func() time.Time
}

// claimant is one source's record for the open code.
type claimant struct {
	last  time.Time
	wrong int
	until time.Time
	wait  time.Duration
}

func newPairing(ttl, spacing time.Duration, now func() time.Time) *Pairing {
	return &Pairing{ttl: ttl, spacing: spacing, now: now, sources: map[string]*claimant{}}
}

// Code is the open code and when it expires ("" when none).
func (p *Pairing) Code() (string, time.Time) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.code == "" || p.now().After(p.expires) {
		return "", time.Time{}
	}
	return p.code, p.expires
}

// Issue replaces any open code with a new one.
func (p *Pairing) Issue() (string, time.Time) {
	b := make([]byte, CodeLength)
	_, _ = rand.Read(b)
	var sb strings.Builder
	for _, c := range b {
		sb.WriteByte(crockford[int(c)%len(crockford)]) // 256 is a multiple of 32: no bias
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	p.code, p.expires, p.wrong, p.locked, p.sources = sb.String(), p.now().Add(p.ttl), 0, false, map[string]*claimant{}
	return p.code, p.expires
}

// Cancel withdraws the open code (and lifts a lock: a new code starts clean).
func (p *Pairing) Cancel() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.code, p.wrong, p.locked, p.sources = "", 0, false, map[string]*claimant{}
}

// NormalizeCode reads a typed code: case, spaces and dashes do not matter, and the letters people confuse with
// digits (O, I, L) count as those digits, as Crockford's base32 says.
func NormalizeCode(s string) string {
	s = strings.ToUpper(s)
	var sb strings.Builder
	for _, r := range s {
		switch {
		case r == '-' || r == ' ' || r == '\t':
			continue
		case r == 'O':
			sb.WriteByte('0')
		case r == 'I' || r == 'L':
			sb.WriteByte('1')
		default:
			sb.WriteRune(r)
		}
	}
	return sb.String()
}

// Claim checks a code typed at source. It returns "" when the code is right (and consumes it), else the catalogue
// code: pairing_rate_limited, pairing_backoff (Wait says how long), pairing_code_expired, pairing_locked or
// pairing_code_invalid.
func (p *Pairing) Claim(input, source string) string {
	p.mu.Lock()
	defer p.mu.Unlock()
	now := p.now()
	c := p.sources[source]
	if c == nil {
		if len(p.sources) >= maxSources {
			return "pairing_rate_limited"
		}
		c = &claimant{}
		p.sources[source] = c
	}
	if now.Before(c.until) {
		return "pairing_backoff"
	}
	if !c.last.IsZero() && now.Sub(c.last) < p.spacing {
		return "pairing_rate_limited"
	}
	c.last = now
	if p.locked {
		return "pairing_locked"
	}
	if p.code == "" {
		return "pairing_code_invalid"
	}
	got := NormalizeCode(input)
	if subtle.ConstantTimeCompare([]byte(got), []byte(p.code)) != 1 {
		p.wrong++
		c.wrong++
		if p.wrong >= MaxWrongTotal {
			p.locked = true
			p.code = ""
			return "pairing_locked"
		}
		if c.wrong >= MaxWrongTry {
			c.wait = min(max(2*c.wait, firstBackoff), maxBackoff)
			c.until = now.Add(c.wait)
			return "pairing_backoff"
		}
		return "pairing_code_invalid"
	}
	if now.After(p.expires) {
		p.code = ""
		return "pairing_code_expired"
	}
	p.code = ""
	p.sources = map[string]*claimant{}
	return ""
}

// Wait is how long source still waits after too many wrong guesses (0: it may try).
func (p *Pairing) Wait(source string) time.Duration {
	p.mu.Lock()
	defer p.mu.Unlock()
	if c := p.sources[source]; c != nil {
		if d := c.until.Sub(p.now()); d > 0 {
			return d
		}
	}
	return 0
}
