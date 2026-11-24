import type { ContentBlock } from "@octo/agent-client";
import { createContext, useContext } from "react";
import type { TranscriptViewMode } from "../../lib/transcriptView";

export type ToolResult = Extract<ContentBlock, { type: "tool_result" }>;
export type ToolState = "running" | "done" | "error" | "interrupted";

export type TranscriptCtx = {
  results: Map<string, ToolResult>;
  agentRunning: boolean;
  now: number;
  /** `compact`: the transcript in a pane narrower than the conversation's own floor (Sessions tab): smaller type, tighter bubbles, time-only reply meta. */
  density: "regular" | "compact";
  /** Transcript detail level (`Ctrl+O`): normal (summaries), thinking (thinking expanded), or verbose (all tool steps expanded). */
  viewMode: TranscriptViewMode;
  /** The Sessions tab selects an agent's session in place; absent elsewhere (a delegation row then opens the Sessions tab). */
  onOpenSession?: ((agentId: string) => void) | undefined;
  /** Decision 101: takes the reader to the one "needs you" card (approvals and forms at the transcript's end); absent where there is none. */
  revealNeeds?: (() => void) | undefined;
};

export const TranscriptContext = createContext<TranscriptCtx>({
  results: new Map(),
  agentRunning: false,
  now: 0,
  density: "regular",
  viewMode: "normal",
});

export function useTranscript() {
  return useContext(TranscriptContext);
}

export function toolState(ctx: TranscriptCtx, toolUseId: string): ToolState {
  const result = ctx.results.get(toolUseId);
  if (result) return result.is_error ? "error" : "done";
  return ctx.agentRunning ? "running" : "interrupted";
}
