import { OCTO_COMMAND_NAMES } from "./slash";

/**
 * Decision 70: what the composer understands in the text, as spans. The highlight is a layer under the text area (the
 * same characters, transparent), so only the spans' positions matter and nothing here changes metrics.
 */

export type Span = { kind: "text" | "mention" | "command"; text: string };

const TRAILING = /[.,;:!?)\]}'"]+$/;
const TOKEN = /(^|\s)([@/])([^\s]+)/g;

/**
 * `@path` (needs a `/` or a file extension, so a handle like `@maya` stays plain) or a known `/command` at the start of the text,
 * the only place a command runs (`parseSlash`); a `/word` anywhere else stays plain. `commands`: the names that count (the
 * Octo commands by default; a caller with the project's live list may pass its names).
 */
export function composerSpans(text: string, commands: readonly string[] = OCTO_COMMAND_NAMES): Span[] {
  const marks: { start: number; end: number; kind: "mention" | "command" }[] = [];
  for (const m of text.matchAll(TOKEN)) {
    const lead = m[1] ?? "";
    const sigil = m[2];
    const raw = m[3] ?? "";
    const body = raw.replace(TRAILING, "");
    const start = m.index + lead.length;
    if (sigil === "@" && /[./]/.test(body.replace(/^[./~]+$/, "")) && /[\w]/.test(body)) {
      marks.push({ start, end: start + 1 + body.length, kind: "mention" });
    } else if (sigil === "/" && text.slice(0, start).trim() === "" && commands.includes(body.toLowerCase()) && body === raw) {
      marks.push({ start, end: start + 1 + body.length, kind: "command" });
    }
  }
  if (marks.length === 0) return text === "" ? [] : [{ kind: "text", text }];
  const out: Span[] = [];
  let at = 0;
  for (const mark of marks) {
    if (mark.start > at) out.push({ kind: "text", text: text.slice(at, mark.start) });
    out.push({ kind: mark.kind, text: text.slice(mark.start, mark.end) });
    at = mark.end;
  }
  if (at < text.length) out.push({ kind: "text", text: text.slice(at) });
  return out;
}

/** True when any span is highlighted (a text with none renders no layer content). */
export function hasHighlights(spans: readonly Span[]): boolean {
  return spans.some((s) => s.kind !== "text");
}
