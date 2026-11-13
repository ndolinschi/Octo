import type { ContextBreakdown, ContextItem, ContextLargeMessage, ContextOverview } from "@octo/agent-client";
import { contextView, type ContextRowView, type ContextView } from "./contextView";

/**
 * The context window report as data (decision 88): the headline view of `contextView`, plus what is inside each
 * category (`items`, largest first, folded to {@link ITEM_FOLD} with "Show all N"), the rows that could be in the window
 * and are not (`not_loaded`: memory files, what loading would add), and the five largest messages with a way to open them.
 * A harness that predates decision 88 sends none of these; the report is then the headline and the category rows.
 */
export const ITEM_FOLD = 5;

export type ReportItem = {
  id: string;
  /** What the row says: "Harness tools · read_file" when the harness names a heading, else the label. */
  title: string;
  tokens: number;
  loaded: boolean;
  /** Where "Open" goes, or null when the row is not a file (or the harness offers no open action). */
  open: OpenTarget | null;
};

/** A memory file (`/memories/a.md` is the memory file `a.md`) or a file of the project (`<folder label>:<path>`: the path). */
export type OpenTarget = { to: "memory-file"; path: string } | { to: "file"; path: string };

export type ReportSection = ContextRowView & {
  items: ReportItem[];
};

export type LargeMessageView = { messageId: number; role: "user" | "assistant"; tokens: number; preview: string; roleLabel: string };

export type WindowReportView = {
  view: ContextView;
  sections: ReportSection[];
  /** Rows that could be in the window and are not, largest first; `tokens` is what loading would add. */
  notLoaded: ReportItem[];
  largest: LargeMessageView[];
  /** The compaction buffer in tokens, or null when the harness knows none (then no row). */
  buffer: number | null;
};

const MEMORY_PREFIX = /^\/?memor(?:y|ies)\//;

/** Where "Open" goes for an item whose `actions` include "open" and that names a `path`; null otherwise. */
export function openTarget(item: Pick<ContextItem, "path" | "actions">): OpenTarget | null {
  if (!item.path || !item.actions?.includes("open")) return null;
  if (MEMORY_PREFIX.test(item.path)) return { to: "memory-file", path: item.path.replace(MEMORY_PREFIX, "") };
  const colon = item.path.indexOf(":");
  // Instruction files are `<folder label>:<path>`; a Windows drive letter is not a label.
  const path = colon > 1 ? item.path.slice(colon + 1) : item.path;
  return path === "" ? null : { to: "file", path };
}

function reportItem(i: ContextItem): ReportItem {
  return { id: i.id, title: i.group ? `${i.group} · ${i.label}` : i.label, tokens: i.tokens, loaded: i.loaded, open: openTarget(i) };
}

const largestFirst = (a: { tokens: number }, b: { tokens: number }) => b.tokens - a.tokens;

function breakdownOf(raw: ContextOverview | ContextBreakdown): {
  not_loaded?: ContextItem[];
  buffer_tokens?: number;
  largest_messages?: ContextLargeMessage[];
} {
  return "not_loaded" in raw || "largest_messages" in raw || "buffer_tokens" in raw ? raw : {};
}

export function windowReportView(raw: ContextOverview | ContextBreakdown, now = Date.now()): WindowReportView {
  const view = contextView(raw, now);
  const cats = "categories" in raw && raw.categories ? raw.categories : [];
  const sections = view.rows.map<ReportSection>((r) => {
    const cat = r.kind === "category" ? cats.find((c) => c.id === r.id) : undefined;
    return {
      ...r,
      items: [...(cat?.items ?? [])]
        .filter((i) => i.tokens > 0)
        .sort(largestFirst)
        .map(reportItem),
    };
  });
  const extra = breakdownOf(raw);
  return {
    view,
    sections,
    notLoaded: [...(extra.not_loaded ?? [])].sort(largestFirst).map(reportItem),
    largest: [...(extra.largest_messages ?? [])].sort(largestFirst).map((m) => ({
      messageId: m.message_id,
      role: m.role,
      tokens: m.tokens,
      preview: m.preview,
      roleLabel: m.role === "user" ? "You" : "Assistant",
    })),
    buffer: extra.buffer_tokens && extra.buffer_tokens > 0 ? extra.buffer_tokens : null,
  };
}

/** The items shown now: all when `all`, else the first {@link ITEM_FOLD}; `hidden` is what "Show all N" adds. */
export function foldItems<T>(items: readonly T[], all: boolean, limit = ITEM_FOLD): { shown: T[]; hidden: number } {
  if (all || items.length <= limit) return { shown: [...items], hidden: 0 };
  return { shown: items.slice(0, limit), hidden: items.length - limit };
}
