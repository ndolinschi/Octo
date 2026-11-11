package agent

import "testing"

func TestCompactionSummary(t *testing.T) {
	for _, tc := range []struct {
		name    string
		trigger string
		body    string
		want    string
		handled bool
		wantErr bool
	}{
		{"compaction block", "compact", `{"stop_reason":"compaction","content":[{"type":"compaction","content":" Goal: ship. "}]}`, "Goal: ship.", true, false},
		{"block wins over text", "compact", `{"stop_reason":"compaction","content":[{"type":"text","text":"x"},{"type":"compaction","content":"S"}]}`, "S", true, false},
		{"text blocks as fallback", "compact", `{"stop_reason":"compaction","content":[{"type":"text","text":"A"},{"type":"text","text":"B"}]}`, "AB", true, false},
		{"context window exceeded is a failure", "compact", `{"stop_reason":"model_context_window_exceeded","content":[{"type":"text","text":"x"}]}`, "", true, true},
		{"empty summary is a failure", "compact", `{"stop_reason":"compaction","content":[{"type":"compaction","content":" "}]}`, "", true, true},
		{"unreadable body is a failure", "compact", `not json`, "", true, true},
		{"other trigger is a normal reply", "classify", `{"stop_reason":"end_turn","content":[{"type":"text","text":"hi"}]}`, "", false, false},
		{"compact_not_applied is a normal reply", "compact_not_applied", `{"stop_reason":"end_turn","content":[]}`, "", false, false},
		{"no trigger is a normal reply", "", `{}`, "", false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, handled, err := compactionSummary(tc.trigger, tc.body)
			if got != tc.want || handled != tc.handled || (err != nil) != tc.wantErr {
				t.Fatalf("compactionSummary = %q, %v, %v; want %q, %v, err %v", got, handled, err, tc.want, tc.handled, tc.wantErr)
			}
		})
	}
}
