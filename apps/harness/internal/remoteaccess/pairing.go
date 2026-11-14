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
)

// Pairing holds the one pairing code the computer shows. A code is single use, expires, and is burned by too many
// wrong tries; claims are spaced at least ClaimSpacing apart across the whole listener.
type Pairing struct {
	mu      sync.Mutex
	code    string
	expires time.Time
	wrong   int
	locked  bool
	last    time.Time
	spacing time.Duration
	ttl     time.Duration
	now     func() time.Time
}

func newPairing(ttl, spacing time.Duration, now func() time.Time) *Pairing {
	return &Pairing{ttl: ttl, spacing: spacing, now: now}
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
	p.code, p.expires, p.wrong, p.locked = sb.String(), p.now().Add(p.ttl), 0, false
	return p.code, p.expires
}

// Cancel withdraws the open code (and lifts a lock: a new code starts clean).
func (p *Pairing) Cancel() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.code, p.wrong, p.locked = "", 0, false
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

// Claim checks a typed code. It returns "" when the code is right (and consumes it), else the catalogue code:
// pairing_rate_limited, pairing_code_expired, pairing_locked or pairing_code_invalid.
func (p *Pairing) Claim(input string) string {
	p.mu.Lock()
	defer p.mu.Unlock()
	now := p.now()
	if !p.last.IsZero() && now.Sub(p.last) < p.spacing {
		return "pairing_rate_limited"
	}
	p.last = now
	if p.locked {
		return "pairing_locked"
	}
	if p.code == "" {
		return "pairing_code_invalid"
	}
	got := NormalizeCode(input)
	if subtle.ConstantTimeCompare([]byte(got), []byte(p.code)) != 1 {
		p.wrong++
		if p.wrong >= MaxWrongTry {
			p.locked = true
			p.code = ""
			return "pairing_locked"
		}
		return "pairing_code_invalid"
	}
	if now.After(p.expires) {
		p.code = ""
		return "pairing_code_expired"
	}
	p.code = ""
	return ""
}
