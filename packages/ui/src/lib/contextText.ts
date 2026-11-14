import { formatTokens } from "./format";

/* Only the agent header shows the context line: out of `usageView.ts`, which the entry chunk carries whole. */

/** "context 1.8k / 200k" when the agent reported both figures; null otherwise (never a guessed window). */
export function contextText(used: number | null | undefined, size: number | null | undefined): string | null {
  if (typeof used !== "number" || typeof size !== "number" || size <= 0) return null;
  return `context ${formatTokens(used)} / ${formatTokens(size)}`;
}
