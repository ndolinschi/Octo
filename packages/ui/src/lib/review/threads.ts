import type { ReviewComment, ReviewThread } from "@octo/agent-client";

/** Replies shown before the rest fold into "N more replies" (decision 78: folded after two). */
export const REPLIES_SHOWN = 2;

export type FileThreads = {
  /** Threads that sit at a line of the current diff, by line. */
  inline: ReviewThread[];
  /** Outdated threads (the code moved) and threads without a usable line: listed apart, never at a wrong line. */
  apart: ReviewThread[];
};

/** The threads of one file, split into those drawn at their line and those listed apart. */
export function threadsOfFile(threads: readonly ReviewThread[], path: string): FileThreads {
  const mine = threads.filter((t) => t.path === path);
  const inline = mine.filter((t) => !t.outdated && t.line !== undefined).sort((a, b) => (a.line ?? 0) - (b.line ?? 0) || a.id.localeCompare(b.id));
  const apart = mine.filter((t) => t.outdated || t.line === undefined);
  return { inline, apart };
}

/** The root comment, the replies that stay visible, and how many fold. */
export function visibleComments<T>(comments: readonly T[], expanded: boolean): { shown: T[]; hidden: number } {
  const [root, ...replies] = comments;
  if (root === undefined) return { shown: [], hidden: 0 };
  if (expanded || replies.length <= REPLIES_SHOWN) return { shown: [root, ...replies], hidden: 0 };
  // The latest replies are the live part of the conversation; the folded ones are the middle.
  return { shown: [root, ...replies.slice(replies.length - REPLIES_SHOWN)], hidden: replies.length - REPLIES_SHOWN };
}

/** One dim line for a resolved or outdated thread: who started it and the start of what they said. */
export function threadSummary(t: ReviewThread, max = 80): string {
  const first = t.comments[0];
  if (!first) return "Empty thread";
  const text = first.body.replace(/\s+/g, " ").trim();
  return `${first.author}: ${text.length > max ? `${text.slice(0, max - 1)}…` : text}`;
}

export function isReply(c: Pick<ReviewComment, "kind" | "in_reply_to">): boolean {
  return c.kind === "reply" && c.in_reply_to !== undefined;
}

/** Pending replies per thread id. */
export function repliesByThread(comments: readonly ReviewComment[]): Map<string, ReviewComment[]> {
  const out = new Map<string, ReviewComment[]>();
  for (const c of comments) {
    if (!isReply(c) || c.state !== "pending" || c.in_reply_to === undefined) continue;
    const list = out.get(c.in_reply_to);
    if (list) list.push(c);
    else out.set(c.in_reply_to, [c]);
  }
  return out;
}

/** "2 threads, 1 unresolved" for a file row's tooltip. */
export function threadCountText(threads: number, unresolved: number): string {
  if (threads === 0) return "";
  const t = `${threads} ${threads === 1 ? "thread" : "threads"}`;
  return unresolved > 0 ? `${t}, ${unresolved} unresolved` : `${t}, all resolved`;
}

/** A row of the file's accessible thread list: the thread and where it sits, in words. */
export type ThreadRow = { thread: ReviewThread; where: string; /** Drawn at its line in the diff (Enter scrolls there). */ drawn: boolean };

/**
 * The rows of the thread list outside Monaco (the diff's zones are a visual copy, hidden from assistive technology): the
 * threads drawn at a line and those listed apart, in one line order, so the list, the zones and `n` / `p` agree.
 */
export function threadRows(drawn: readonly ReviewThread[], apart: readonly ReviewThread[]): ThreadRow[] {
  const at = (t: ReviewThread) => t.line ?? t.original_line ?? 0;
  const rows = [...drawn.map((t) => ({ thread: t, drawn: true })), ...apart.map((t) => ({ thread: t, drawn: false }))];
  rows.sort((a, b) => at(a.thread) - at(b.thread) || a.thread.id.localeCompare(b.thread.id));
  return rows.map((r) => ({ ...r, where: threadWhere(r.thread, r.drawn) }));
}

/** "Line 42", "Lines 40–42, removed side", "Outdated, was line 30", "File". */
export function threadWhere(t: ReviewThread, drawn: boolean): string {
  if (t.outdated) return t.original_line ? `Outdated, was line ${t.original_line}` : "Outdated";
  if (t.line === undefined) return "File";
  const lines = t.start_line !== undefined && t.start_line < t.line ? `Lines ${t.start_line}–${t.line}` : `Line ${t.line}`;
  return t.side === "old" ? `${lines}, removed side${drawn ? "" : " (not shown in one column)"}` : lines;
}

/** The first sentence of a comment, on one line, cut at `max` characters. */
export function firstPhrase(body: string, max = 60): string {
  const text = body.replace(/\s+/g, " ").trim();
  const m = /^(.+?[.!?])(\s|$)/.exec(text);
  const s = m?.[1] ?? text;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** The list's collapsed line: "4 threads", or "4 threads, 1 not at a line". */
export function threadsLabel(rows: readonly ThreadRow[]): string {
  const n = rows.length;
  const apart = rows.filter((r) => !r.drawn).length;
  const t = `${n} ${n === 1 ? "thread" : "threads"}`;
  return apart > 0 && apart < n ? `${t}, ${apart} not at a line` : t;
}

/** `n` / `p`: the next (or previous) thread id after `current`; null past either end. No current: the first (or last). */
export function stepThread(ids: readonly string[], current: string | null, dir: 1 | -1): string | null {
  if (ids.length === 0) return null;
  const i = current === null ? -1 : ids.indexOf(current);
  if (i < 0) return (dir === 1 ? ids[0] : ids[ids.length - 1]) ?? null;
  return ids[i + dir] ?? null;
}

/** The total of unresolved threads over all files. */
export function unresolvedTotal(unresolvedByPath: Readonly<Record<string, number>>): number {
  return Object.values(unresolvedByPath).reduce((a, b) => a + b, 0);
}
