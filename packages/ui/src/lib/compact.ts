import type { CompactionMarker } from "@octo/agent-client";

/** Parity B7: the marker a compaction leaves in the transcript. */

/** The marker's text once a rewind cut the conversation (parity B5; it shares the compaction marker's line). */
export function rewoundLabel(acpReset: boolean): string {
  return acpReset ? "Rewound to here · agent session reset" : "Rewound to here";
}

/** The marker's text: the harness's label ("history compacted"), capitalised; manual ones say so. */
export function compactionLabel(marker: Pick<CompactionMarker, "label" | "manual">): string {
  const base = marker.label?.trim() || "history compacted";
  const text = `${base.charAt(0).toUpperCase()}${base.slice(1)}`;
  return marker.manual ? `${text} · manual` : text;
}
