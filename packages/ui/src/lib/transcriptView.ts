import { useSyncExternalStore } from "react";
import { choiceCodec, loadPref, PREFS, writePref } from "./storage";

/**
 * Transcript detail modes (Claude Code Desktop parity, `Ctrl+O`):
 * - `normal`: tool calls collapsed into summaries, full text responses
 * - `thinking`: tool calls collapsed, reasoning/thinking blocks expanded
 * - `verbose`: every tool group, step, and thinking block expanded
 */
export const TRANSCRIPT_VIEWS = ["normal", "thinking", "verbose"] as const;
export type TranscriptViewMode = (typeof TRANSCRIPT_VIEWS)[number];

export const transcriptViewCodec = choiceCodec(TRANSCRIPT_VIEWS, "normal");

export const TRANSCRIPT_VIEW_LABEL: Record<TranscriptViewMode, string> = {
  normal: "Normal",
  thinking: "Thinking",
  verbose: "Verbose",
};

export const TRANSCRIPT_VIEW_DETAIL: Record<TranscriptViewMode, string> = {
  normal: "Tool calls collapsed into summaries",
  thinking: "Summaries plus expanded thinking",
  verbose: "Every tool step and thinking expanded",
};

export function nextTranscriptView(current: TranscriptViewMode): TranscriptViewMode {
  const i = TRANSCRIPT_VIEWS.indexOf(current);
  return TRANSCRIPT_VIEWS[(i + 1) % TRANSCRIPT_VIEWS.length] ?? "normal";
}

let cached: TranscriptViewMode | null = null;
const listeners = new Set<() => void>();

export function getTranscriptView(): TranscriptViewMode {
  cached ??= loadPref(PREFS.transcriptView, transcriptViewCodec);
  return cached;
}

export function setTranscriptView(next: TranscriptViewMode): void {
  if (cached === next) return;
  cached = next;
  writePref(PREFS.transcriptView, transcriptViewCodec.stringify(next));
  for (const l of listeners) l();
}

export function cycleTranscriptView(): TranscriptViewMode {
  const next = nextTranscriptView(getTranscriptView());
  setTranscriptView(next);
  return next;
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useTranscriptView(): TranscriptViewMode {
  return useSyncExternalStore(subscribe, getTranscriptView, () => "normal");
}
