package secrets

import "strings"

// Stream redacts a text stream chunk by chunk. A value split across two chunks
// is still caught: the last MaxValueLen-1 bytes of a chunk are held back until
// the next one arrives (or Flush). Values stored while the stream runs count
// from the next chunk on.
type Stream struct {
	m    *Manager
	pid  string
	hold string
}

// NewStream starts a redacting stream for a project.
func (m *Manager) NewStream(pid string) *Stream { return &Stream{m: m, pid: pid} }

// Write takes a chunk and returns the text that is safe to publish now.
func (s *Stream) Write(chunk string) string {
	n := s.m.MaxValueLen(s.pid)
	if n == 0 && s.hold == "" {
		return chunk
	}
	text := s.m.Redact(s.pid, s.hold+chunk)
	keep := max(n-1, 0)
	if len(text) <= keep {
		s.hold = text
		return ""
	}
	cut := len(text) - keep
	// Never cut inside a UTF-8 sequence.
	for cut > 0 && cut < len(text) && text[cut]&0xC0 == 0x80 {
		cut--
	}
	s.hold = text[cut:]
	return text[:cut]
}

// Flush returns what is still held back.
func (s *Stream) Flush() string {
	out := s.m.Redact(s.pid, s.hold)
	s.hold = ""
	return strings.TrimRight(out, "\x00")
}
