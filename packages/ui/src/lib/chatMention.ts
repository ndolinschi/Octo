/**
 * G4 (2026-11-18): the composer's file mention for "Add to chat": `@path`, with a line or a line range when it comes from the
 * editor (`@src/auth/refresh.ts:9-14`). The same `@path` the "+" menu inserts; the range is part of the token, so the
 * composer highlights it as one mention.
 */
export type LineSpan = { startLine: number; startColumn: number; endLine: number; endColumn: number };

/** The lines a selection covers: a selection that ends at column 1 of a later line does not take that line. */
export function selectedLines(sel: LineSpan): { from: number; to: number } {
  const to = sel.endColumn === 1 && sel.endLine > sel.startLine ? sel.endLine - 1 : sel.endLine;
  return { from: Math.min(sel.startLine, to), to: Math.max(sel.startLine, to) };
}

export function chatMention(path: string, lines?: { from: number; to: number }): string {
  const clean = path.replace(/^\/+/, "");
  if (!lines) return `@${clean}`;
  return lines.from === lines.to ? `@${clean}:${lines.from}` : `@${clean}:${lines.from}-${lines.to}`;
}

/** The draft after "Add to chat": the mention at the end, one space from what was there, and a space after it to type on. */
export function appendMention(draft: string, mention: string): string {
  const head = draft.replace(/\s+$/, "");
  return `${head}${head ? " " : ""}${mention} `;
}
