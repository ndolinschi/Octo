package tools

import "unicode/utf8"

const MaxOutputBytes = 1 << 20

const truncatedSuffix = "\n...truncated"

func CapString(s string) string {
	if len(s) <= MaxOutputBytes {
		return s
	}
	return string(CapBytes([]byte(s)))
}

func CapBytes(b []byte) []byte {
	if len(b) <= MaxOutputBytes {
		return b
	}
	n := MaxOutputBytes
	for n > 0 && !utf8.RuneStart(b[n]) {
		n--
	}
	out := make([]byte, n+len(truncatedSuffix))
	copy(out, b[:n])
	copy(out[n:], truncatedSuffix)
	return out
}
