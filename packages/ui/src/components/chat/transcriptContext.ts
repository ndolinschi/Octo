import type { ContentBlock } from "@octo/agent-client";
import { createContext, useContext } from "react";

export type ToolResult = Extract<ContentBlock, { type: "tool_result" }>;
export type ToolState = "running" | "done" | "error" | "interrupted";

export type TranscriptCtx = {
  results: Map<string, ToolResult>;
  agentRunning: boolean;
  now: number;
  /** `compact`: the transcript in a pane narrower than the conversation's own floor (Sessions tab): smaller type, tighter bubbles, time-only reply meta. */
  density: "regular" | "compact";
  /** The Sessions tab selects an agent's session in place; absent elsewhere (a delegation row then opens the Sessions tab). */
  onOpenSession?: ((agentId: string) => void) | undefined;
};

export const TranscriptContext = createContext<TranscriptCtx>({
  results: new Map(),
  agentRunning: false,
  now: 0,
  density: "regular",
});

export function useTranscript() {
  return useContext(TranscriptContext);
}

export function toolState(ctx: TranscriptCtx, toolUseId: string): ToolState {
  const result = ctx.results.get(toolUseId);
  if (result) return result.is_error ? "error" : "done";
  return ctx.agentRunning ? "running" : "interrupted";
}
