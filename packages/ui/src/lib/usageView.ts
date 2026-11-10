import { formatTokens } from "./format";

/* The parts of the usage helpers the main bundle needs (tab memory, the agent header); the rest of `usage.ts` loads with
   the Usage tab, Home and Details. */

/** The Usage tab's controls (kept per tab across remounts). */
export type UsageView = { segment: "tokens" | "cost" | "limits"; days: 7 | 30 | 90; scope: "project" | "all" };
export const USAGE_DAYS = [7, 30, 90] as const;
export const DEFAULT_USAGE_VIEW: UsageView = { segment: "tokens", days: 30, scope: "project" };

export function isUsageView(v: unknown): v is UsageView {
  if (typeof v !== "object" || v === null || !("segment" in v) || !("days" in v) || !("scope" in v)) return false;
  const { segment, days, scope } = v;
  return (
    (segment === "tokens" || segment === "cost" || segment === "limits") &&
    (days === 7 || days === 30 || days === 90) &&
    (scope === "project" || scope === "all")
  );
}

/** "context 1.8k / 200k" when the agent reported both figures; null otherwise (never a guessed window). */
export function contextText(used: number | null | undefined, size: number | null | undefined): string | null {
  if (typeof used !== "number" || typeof size !== "number" || size <= 0) return null;
  return `context ${formatTokens(used)} / ${formatTokens(size)}`;
}
