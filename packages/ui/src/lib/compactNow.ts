import type { CompactResult, CompactSentToAgent } from "@octo/agent-client";
import { formatTokens } from "./format";

/** Parity B7: "Compact now" in the context popover (its own chunk; the marker's label is in `compact.ts`). */

/** The line under the button once it worked: what was replaced, and by how much. */
export function compactedLine(r: Pick<CompactResult, "message_count" | "summary_tokens"> | CompactSentToAgent): string {
  if ("sent_to_agent" in r) return "Sent /compact to the agent. It compacts its own history.";
  const n = r.message_count;
  const what = n > 0 ? `${n} ${n === 1 ? "message" : "messages"}` : "the history";
  const size = r.summary_tokens > 0 ? ` into a summary of about ${formatTokens(r.summary_tokens)} tokens` : "";
  return `Compacted ${what}${size}.`;
}

/** Why compacting did not happen, as a sentence with a next step; null for an error the caller words itself. */
export function compactError(code: string | null): string | null {
  switch (code) {
    case "nothing_to_compact":
      return "Nothing to compact yet: fewer than two messages since the last compaction.";
    case "compact_unsupported":
      return "This agent compacts its own history. Octo cannot do it for it.";
    case "turn_in_progress":
      return "A turn is running. Compact when it has finished.";
    case "builtin_loop_unavailable":
      return "The built-in loop is not available (no API key), so there is nothing to compact.";
    default:
      return null;
  }
}
