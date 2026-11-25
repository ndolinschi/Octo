/* The parts of the usage helpers the main bundle needs (tab memory); the rest of `usage.ts` loads with
   the Usage tab, Home and Details. */

/** The Usage tab's controls (kept per tab across remounts). Decision 86: By model | By agent | By day | Limits. */
export type UsageSegment = "model" | "agent" | "day" | "limits";
export type UsagePeriod = "session" | "today" | "7d" | "30d" | "all";
export type UsageView = { segment: UsageSegment; period: UsagePeriod; scope: "project" | "all"; roles: boolean };
export const DEFAULT_USAGE_VIEW: UsageView = { segment: "model", period: "all", scope: "project", roles: false };
/** "Since app start" reads usage since the window opened: the harness has no per-session report. */
export const SESSION_STARTED_AT = Date.now();

const SEGMENTS: readonly unknown[] = ["model", "agent", "day", "limits"];
const PERIODS: readonly unknown[] = ["session", "today", "7d", "30d", "all"];

export function isUsageView(v: unknown): v is UsageView {
  if (typeof v !== "object" || v === null || !("segment" in v) || !("period" in v) || !("scope" in v) || !("roles" in v)) return false;
  const { segment, period, scope, roles } = v;
  return SEGMENTS.includes(segment) && PERIODS.includes(period) && (scope === "project" || scope === "all") && typeof roles === "boolean";
}

// R2: "Since app start", the same words as the period menu (`USAGE_PERIODS`); "This session" read as the chat's session.
const PERIOD_TEXT: Record<UsagePeriod, string> = { session: "Since app start", today: "Today", "7d": "7 days", "30d": "30 days", all: "All time" };

/** The Usage range / scope menu button's text (decision 33): "30 days", or "30 days, all projects". */
export function usageRangeText(view: Pick<UsageView, "period" | "scope">): string {
  return view.scope === "all" ? `${PERIOD_TEXT[view.period]}, all projects` : PERIOD_TEXT[view.period];
}
