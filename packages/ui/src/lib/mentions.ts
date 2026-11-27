import { OCTO_COMMAND_NAMES } from "./slash";

/**
 * Decision 70: what the composer understands in the text, as spans. The highlight is a layer under the text area (the
 * same characters, transparent), so only the spans' positions matter and nothing here changes metrics.
 */

export type HighlightKind = "mention" | "command" | "md-heading" | "md-tag";

export type Span = { kind: "text" | HighlightKind; text: string };

const TRAILING = /[.,;:!?)\]}'"]+$/;
const TOKEN = /(^|\s)([@/])([^\s]+)/g;
const HEADING = /^[ \t]{0,3}#{1,6}(?:[ \t]+[^\n]*)?$/gm;
const HTML_TAG = /<\/?[A-Za-z][A-Za-z0-9:_-]*(?:\s+[^<>]*)?\/?>/g;

/**
 * `@path` (needs a `/`, a file extension, or membership in `options.knownFiles` so a handle like `@maya` stays plain),
 * a known `/command` at the start of the text, plus metric-safe `#`/`###` headings and HTML/XML `<tags>`.
 * Returned spans always concatenate back to `text` character-for-character.
 */
export function composerSpans(
  text: string,
  commands: readonly string[] = OCTO_COMMAND_NAMES,
  options?: { knownFiles?: ReadonlySet<string> | undefined },
): Span[] {
  if (text === "") return [];
  const marks: { start: number; end: number; kind: HighlightKind }[] = [];
  const taken = new Uint8Array(text.length);

  const canClaim = (start: number, end: number) => {
    for (let i = start; i < end; i++) if (taken[i]) return false;
    return true;
  };
  const claim = (start: number, end: number, kind: HighlightKind) => {
    if (start >= end || !canClaim(start, end)) return;
    taken.fill(1, start, end);
    marks.push({ start, end, kind });
  };
  const claimOpen = (start: number, end: number, kind: HighlightKind) => {
    let i = start;
    while (i < end) {
      while (i < end && taken[i]) i++;
      const s = i;
      while (i < end && !taken[i]) i++;
      if (i > s) {
        taken.fill(1, s, i);
        marks.push({ start: s, end: i, kind });
      }
    }
  };

  for (const m of text.matchAll(TOKEN)) {
    const lead = m[1] ?? "";
    const sigil = m[2];
    const raw = m[3] ?? "";
    const body = raw.replace(TRAILING, "");
    const start = m.index + lead.length;
    if (sigil === "@" && ((/[./]/.test(body.replace(/^[./~]+$/, "")) && /[\w]/.test(body)) || (body.length > 0 && options?.knownFiles?.has(body) === true))) {
      claim(start, start + 1 + body.length, "mention");
    } else if (sigil === "/" && text.slice(0, start).trim() === "" && commands.includes(body.toLowerCase()) && body === raw) {
      claim(start, start + 1 + body.length, "command");
    }
  }

  for (const m of text.matchAll(HTML_TAG)) {
    claim(m.index, m.index + m[0].length, "md-tag");
  }
  for (const m of text.matchAll(HEADING)) {
    const lead = m[0].length - m[0].trimStart().length;
    claimOpen(m.index + lead, m.index + m[0].length, "md-heading");
  }

  if (marks.length === 0) return [{ kind: "text", text }];
  marks.sort((a, b) => a.start - b.start);
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
