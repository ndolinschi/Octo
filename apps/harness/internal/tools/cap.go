package tools

import (
	"fmt"
	"unicode/utf8"
)

// Defaults for what is allowed back into model context. Every cap below is
// resent on each later loop iteration, so they are deliberately small. They are
// overridable through Limits (config: HARNESS_MAX_TOOL_RESULT_BYTES,
// HARNESS_MAX_REPORT_BYTES, HARNESS_READ_FILE_LINES). The UI file API
// (internal/files) is not subject to them.
const (
	// DefaultMaxResultBytes caps one tool result's text.
	DefaultMaxResultBytes = 48 << 10
	// DefaultMaxReportBytes caps a sub-agent's final report as seen by its parent.
	DefaultMaxReportBytes = 32 << 10
	// DefaultReadFileLines is read_file's line limit when the model gives none.
	DefaultReadFileLines = 2000

	// MaxRemoteBodyBytes bounds how much of a remote tool response is read into
	// memory at all, before the result cap applies.
	MaxRemoteBodyBytes = 1 << 20
)

// Hints appended to truncation markers, telling the model how to get the rest.
const (
	ResultHint = "Narrow the request to get the rest: read_file with offset/limit, or filter shell output with head, tail, sed -n or grep."
	ReportHint = "The sub-agent is finished; to get the omitted part, spawn a new sub-agent with a narrower task and ask for a shorter report."
)

// Limits are the caps applied to text that goes back into model context. A
// zero or negative field means its default.
type Limits struct {
	ResultBytes int
	ReportBytes int
	ReadLines   int
}

// Resolved returns l with every unset field replaced by its default.
func (l Limits) Resolved() Limits {
	if l.ResultBytes <= 0 {
		l.ResultBytes = DefaultMaxResultBytes
	}
	if l.ReportBytes <= 0 {
		l.ReportBytes = DefaultMaxReportBytes
	}
	if l.ReadLines <= 0 {
		l.ReadLines = DefaultReadFileLines
	}
	return l
}

// CapResult caps one tool result at l.ResultBytes.
func (l Limits) CapResult(s string) string {
	return Truncate(s, l.Resolved().ResultBytes, ResultHint)
}

// CapReport caps a sub-agent report at l.ReportBytes.
func (l Limits) CapReport(s string) string {
	return Truncate(s, l.Resolved().ReportBytes, ReportHint)
}

// Marker is the text appended when a string is cut to shown of total bytes.
func Marker(shown, total int, hint string) string {
	return fmt.Sprintf("\n\n[truncated: showed the first %d of %d bytes; %d bytes cut. %s]", shown, total, total-shown, hint)
}

// Truncate returns s unchanged when it fits in max bytes; otherwise its first
// bytes (cut on a rune boundary) followed by a marker naming how much was cut
// and hint. The result, marker included, never exceeds max when max leaves room
// for the marker.
func Truncate(s string, max int, hint string) string {
	if len(s) <= max {
		return s
	}
	keep := max - len(Marker(max, len(s), hint))
	if keep < 0 {
		keep = 0
	}
	for keep > 0 && keep < len(s) && !utf8.RuneStart(s[keep]) {
		keep--
	}
	return s[:keep] + Marker(keep, len(s), hint)
}

// CapString caps s at DefaultMaxResultBytes.
func CapString(s string) string { return Truncate(s, DefaultMaxResultBytes, ResultHint) }
