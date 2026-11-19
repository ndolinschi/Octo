/**
 * A plan card says "Plan" once (polish item 10). When the plan's text opens with its own "Plan…" line — a heading
 * (`# Plan: x`) or a bold line (`**Plan: x**`) — that line becomes the card's title and leaves the body; otherwise the
 * title is "Plan" and the text is shown whole.
 */
export function planTitle(text: string): { title: string; body: string } {
  const lines = text.split("\n");
  const first = lines.findIndex((l) => l.trim() !== "");
  const line = first < 0 ? "" : (lines[first] ?? "").trim();
  const m = /^(?:#{1,6}\s+(.+?)\s*#*|\*\*(.+?)\*\*|__(.+?)__)$/.exec(line);
  const inner = (m?.[1] ?? m?.[2] ?? m?.[3] ?? "").trim();
  if (!/^plan\b/i.test(inner)) return { title: "Plan", body: text };
  return {
    title: inner,
    body: lines
      .slice(first + 1)
      .join("\n")
      .replace(/^\s*\n/, ""),
  };
}
