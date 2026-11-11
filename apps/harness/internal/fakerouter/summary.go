package fakerouter

import "net/http"

// SummaryText is the summary of every compaction the fake produces.
const SummaryText = "COMPACTED-SUMMARY: the user wants the work split across sub-agents; sub-agents have reported findings."

// writeSummary answers like the real router's compaction: the upstream Messages
// JSON with stop_reason "compaction", never a stream, whatever the client asked.
func writeSummary(w http.ResponseWriter, model string, asText bool) {
	block := map[string]any{"type": "compaction", "content": SummaryText}
	if asText {
		block = map[string]any{"type": "text", "text": SummaryText}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"id": "msg_summary", "type": "message", "role": "assistant", "model": model,
		"content": []any{block}, "stop_reason": "compaction", "stop_sequence": nil,
		"usage": map[string]any{"input_tokens": 200, "output_tokens": 40, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0},
	})
}
