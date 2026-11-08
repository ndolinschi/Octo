package tools

const MaxOutputBytes = 1 << 20

const truncatedSuffix = "\n...truncated"

func CapString(s string) string {
	if len(s) <= MaxOutputBytes {
		return s
	}
	return s[:MaxOutputBytes] + truncatedSuffix
}

func CapBytes(b []byte) []byte {
	if len(b) <= MaxOutputBytes {
		return b
	}
	out := make([]byte, MaxOutputBytes+len(truncatedSuffix))
	copy(out, b[:MaxOutputBytes])
	copy(out[MaxOutputBytes:], truncatedSuffix)
	return out
}
