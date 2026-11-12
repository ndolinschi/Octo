import type { CompactionMarker } from "@octo/agent-client";
import { compactionLabel } from "../../lib/compact";
import { formatTokens } from "../../lib/format";

/**
 * Where the orchestrator's history was compacted (decision 37): everything above was replaced by a summary in its
 * context. A centred 12px line between hairlines, like the time separator; the summary's size in the tooltip. A rewind
 * (parity B5) leaves the same kind of line where it cut the conversation. Its own chunk: markers are rare.
 */
export function CompactedMarker({ marker }: { marker: CompactionMarker }) {
  const size = marker.summary_tokens ? ` into a summary of about ${formatTokens(marker.summary_tokens)} tokens` : "";
  const label = compactionLabel(marker);
  const cut = label.startsWith("Rewound");
  const count = marker.message_count ? `${marker.message_count} messages were ` : "Everything above was ";
  return (
    <div
      data-compacted={cut ? undefined : ""}
      data-rewound={cut ? "" : undefined}
      role="separator"
      aria-label={label}
      title={
        cut
          ? `The conversation was cut back here on ${new Date(marker.at).toLocaleString()}. The requests after it and the files they changed are gone.${label.includes("session reset") ? " The agent's own session was reset; its next turn starts a new one with a recap." : ""}`
          : `${count}compacted${size} on ${new Date(marker.at).toLocaleString()}. Everything after it works from that summary; the full text stays here.`
      }
      className="flex h-4 items-center gap-3 text-xs text-fg-3"
    >
      <span aria-hidden className="h-px flex-1 bg-line" />
      {label}
      <span aria-hidden className="h-px flex-1 bg-line" />
    </div>
  );
}
