import type { ContextBreakdown, ContextOverview } from "@octo/agent-client";
import { formatTokens, timeAgo } from "./format";

export type ContextRowView = {
  id: string;
  label: string;
  tokens: number;
  /** Whole percent; the rows' shares add up to exactly 100. */ percent: number;
  kind: "category" | "free" | "reserved";
};

/** The popover of the context button (decision 65) as data: what to say, in what order, with which marks. */
export type ContextView = {
  source: "harness" | "agent";
  window: number | null;
  used: number;
  free: number | null;
  /** Whole percent of the window in use (of the used tokens when the window is unknown); null when nothing is known. */
  usedPercent: number | null;
  /** True when the numbers are the harness's estimates: every number is then prefixed "≈". */
  approx: boolean;
  /** "history was compacted 2 turns ago", else null. */
  compacted: string | null;
  rows: ContextRowView[];
  lastRequest: { input: number; cached: number; output: number } | null;
  /** Taken from what the UI already knew (the last turn), not from the context endpoint. */
  fromLastTurn: boolean;
};

/** Shares as whole percents that add up to 100 (largest remainder), in the order given. */
export function percentShares(values: readonly number[]): number[] {
  const total = values.reduce((n, v) => n + Math.max(0, v), 0);
  if (total <= 0) return values.map(() => 0);
  const exact = values.map((v) => (Math.max(0, v) / total) * 100);
  const floors = exact.map(Math.floor);
  let left = 100 - floors.reduce((n, v) => n + v, 0);
  const order = exact.map((e, i) => ({ i, r: e - Math.floor(e) })).sort((a, b) => b.r - a.r || a.i - b.i);
  for (const o of order) {
    if (left <= 0) break;
    floors[o.i] = (floors[o.i] ?? 0) + 1;
    left -= 1;
  }
  return floors;
}

const isOverview = (v: ContextOverview | ContextBreakdown): v is ContextOverview => "used" in v;

const PART_LABEL: Record<string, string> = {
  // One name per category, the same as the context meter's (lib/contextMeter.ts).
  system: "Instructions",
  tools: "Tool definitions",
  notes: "Notes and memory",
  messages: "Messages",
  tool_results: "Tool results",
  summary: "Compacted summary",
};

/** Either answer of the harness (the new overview, or the older breakdown) as one view; categories largest first. */
export function contextView(raw: ContextOverview | ContextBreakdown, now = Date.now()): ContextView {
  const o: ContextOverview = isOverview(raw)
    ? raw
    : {
        window: raw.window ?? raw.window_tokens,
        used: raw.used_tokens,
        source: raw.source ?? "harness",
        estimated: raw.estimated,
        ...(raw.free_tokens != null ? { free: raw.free_tokens } : {}),
        ...(raw.reserved_tokens !== undefined ? { reserved: raw.reserved_tokens } : {}),
        ...(raw.compacted_at !== undefined ? { compacted_at: raw.compacted_at } : {}),
        ...(raw.last_request ? { last_request: raw.last_request } : {}),
        categories:
          raw.categories && raw.categories.length > 0
            ? raw.categories
            : raw.parts.map((p) => ({ id: p.key, label: PART_LABEL[p.key] ?? p.key, tokens: p.tokens })),
      };
  const used = Math.max(0, o.used);
  const window = o.window && o.window > 0 ? o.window : null;
  if (o.source === "agent")
    return {
      source: "agent",
      window,
      used,
      free: window ? Math.max(0, window - used) : null,
      usedPercent: window ? Math.round((used / window) * 100) : null,
      approx: false,
      compacted: null,
      rows: [],
      lastRequest: o.last_request ?? null,
      fromLastTurn: false,
    };
  const cats = [...o.categories].filter((c) => c.tokens > 0).sort((a, b) => b.tokens - a.tokens);
  const reserved = Math.max(0, o.reserved ?? 0);
  const free = window ? Math.max(0, o.free ?? window - used - reserved) : null;
  const tokens = [...cats.map((c) => c.tokens), ...(reserved > 0 ? [reserved] : []), ...(free !== null ? [free] : [])];
  const pct = percentShares(window ? tokens : cats.map((c) => c.tokens));
  const rows: ContextRowView[] = cats.map((c, i) => ({ id: c.id, label: c.label, tokens: c.tokens, percent: pct[i] ?? 0, kind: "category" }));
  if (reserved > 0) rows.push({ id: "reserved", label: "Reserved for the answer", tokens: reserved, percent: pct[cats.length] ?? 0, kind: "reserved" });
  if (free !== null) rows.push({ id: "free", label: "Free", tokens: free, percent: pct[tokens.length - 1] ?? 0, kind: "free" });
  const compacted =
    o.compacted_turns_ago !== undefined
      ? `History compacted ${o.compacted_turns_ago === 0 ? "in this request" : o.compacted_turns_ago === 1 ? "1 request ago" : `${o.compacted_turns_ago} requests ago`}`
      : o.compacted_at
        ? `History compacted ${timeAgo(o.compacted_at, now)}`
        : null;
  return {
    source: "harness",
    window,
    used,
    free,
    usedPercent: window ? Math.round((used / window) * 100) : null,
    approx: o.estimated !== false,
    compacted,
    rows,
    lastRequest: o.last_request ?? null,
    fromLastTurn: false,
  };
}

/** What the UI knows without the endpoint (the ring's two numbers): a headline only, labelled "from the last turn". */
export function lastTurnView(used: number, window: number | null): ContextView {
  return {
    source: "harness",
    window,
    used,
    free: window ? Math.max(0, window - used) : null,
    usedPercent: window ? Math.round((used / window) * 100) : null,
    approx: true,
    compacted: null,
    rows: [],
    lastRequest: null,
    fromLastTurn: true,
  };
}

/** "41% of 200k used · 118k free" (with "≈" in front of every number that is an estimate); the agent variant says what it reports. */
export function contextHeadline(v: ContextView): string {
  const a = v.approx ? "≈" : "";
  if (v.source === "agent")
    return v.window
      ? `${formatTokens(v.used)} of ${formatTokens(v.window)} used (reported by the agent)`
      : `${formatTokens(v.used)} used (reported by the agent)`;
  if (v.window === null) return `${a}${formatTokens(v.used)} tokens used`;
  return `${a}${v.usedPercent}% of ${formatTokens(v.window)} used · ${a}${formatTokens(v.free ?? 0)} free`;
}

/** Cached vs. uncached input of the last request: "Last request: 31k read, 24k of it cached (77%)". */
export function cacheLine(v: ContextView): string | null {
  const r = v.lastRequest;
  if (!r || r.input <= 0) return null;
  const share = Math.round((Math.min(r.cached, r.input) / r.input) * 100);
  return `Last request: ${formatTokens(r.input)} read (${share}% from cache), ${formatTokens(r.output)} written`;
}

/** The parts that have a colour in styles.css (`octo-ctx-<id>`); any other category is drawn neutral. */
const CTX_IDS = new Set(["messages", "tool_results", "summary", "notes", "tools", "system"]);

/**
 * The classes of a category's colour key (a 8px square) and of its segment in the stacked bar: the same colour in both
 * (decision 88 b). Free space is an outline and a dim segment, the reserved buffer a neutral one.
 */
export function contextKey(r: Pick<ContextRowView, "id" | "kind">): { key: string; segment: string } {
  if (r.kind === "free") return { key: "border border-line-strong", segment: "bg-active" };
  if (r.kind === "reserved") return { key: "bg-line-strong", segment: "bg-line-strong" };
  const c = CTX_IDS.has(r.id) ? `octo-ctx-${r.id}` : "bg-fg-3";
  return { key: c, segment: c };
}
