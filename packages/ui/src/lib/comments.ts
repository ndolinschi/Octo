import { fileName } from "./files";

/**
 * Code comments on the wire: appended to a message as a fenced `octo-comments` block the model
 * can read (spec §5), and split back out for rendering. Pure functions, no Monaco.
 */

/** A pending comment on lines `start`–`end` (1-based, inclusive) of a project file. */
export type CodeComment = { id: string; folder: string; path: string; start: number; end: number; text: string; created: number };

/** One comment as sent: header range plus the quoted lines captured at send time. */
export type SentComment = { folder: string; path: string; start: number; end: number; quote: string[]; truncated: boolean; text: string };

const MAX_QUOTED_LINES = 6;
const LANG = "octo-comments";

function range(start: number, end: number): string {
  return end > start ? `${start}-${end}` : `${start}`;
}

/** The fenced block for `comments` (in order), quoting at most six lines each, then `> …`. */
export function formatComments(comments: { folder: string; path: string; start: number; end: number; lines: string[]; text: string }[]): string {
  const entries = comments.map((c) => {
    const quoted = c.lines.slice(0, MAX_QUOTED_LINES).map((l) => `> ${l}`.trimEnd());
    if (c.lines.length > MAX_QUOTED_LINES) quoted.push("> \u2026");
    return [`${c.folder}/${c.path}:${range(c.start, c.end)}`, ...quoted, c.text.trim()].join("\n");
  });
  const body = entries.join("\n\n");
  // A fence longer than any backtick run inside, so comment text can't close it.
  const longest = Math.max(0, ...(body.match(/`+/g) ?? []).map((r) => r.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${LANG}\n${body}\n${fence}`;
}

/** Message text with the comments block appended (or the block alone when there is no prose). */
export function withComments(prose: string, block: string): string {
  const text = prose.trim();
  return text ? `${text}\n\n${block}` : block;
}

const HEADER = /^(.+?):(\d+)(?:-(\d+))?$/;
const BLOCK = /(^|\n)(`{3,})octo-comments[ \t]*\n([\s\S]*?)\n\2[ \t]*(?=\n|$)/g;

type Entry = SentComment & { textLines: string[] };

function parseEntries(body: string): SentComment[] {
  const out: Entry[] = [];
  const all = body.split("\n");
  for (let i = 0; i < all.length; i++) {
    const line = all[i];
    const header = HEADER.exec(line);
    if (header && line.includes("/") && (i === 0 || all[i - 1].trim() === "")) {
      const full = header[1];
      const slash = full.indexOf("/");
      out.push({
        folder: full.slice(0, slash),
        path: full.slice(slash + 1),
        start: Number(header[2]),
        end: Number(header[3] ?? header[2]),
        quote: [],
        truncated: false,
        text: "",
        textLines: [],
      });
      continue;
    }
    const c = out[out.length - 1];
    if (!c) continue;
    if (!c.textLines.length && /^>( |$)/.test(line)) {
      if (line === "> \u2026") c.truncated = true;
      else c.quote.push(line.replace(/^> ?/, ""));
      continue;
    }
    c.textLines.push(line);
  }
  return out.map(({ textLines, ...c }) => ({ ...c, text: textLines.join("\n").trim() }));
}

/** Splits a user message into its prose and the comments of any `octo-comments` blocks. */
export function splitComments(text: string): { prose: string; comments: SentComment[] } {
  if (!text.includes(LANG)) return { prose: text, comments: [] };
  const comments: SentComment[] = [];
  const prose = text
    .replace(BLOCK, (_m, lead: string, _fence: string, body: string) => {
      comments.push(...parseEntries(body));
      return lead;
    })
    .trim();
  return { prose, comments };
}

/** "1 comment on refresh.ts", "3 comments on refresh.ts and 1 other file". */
function commentsSummary(comments: { path: string; folder: string }[]): string {
  const n = comments.length;
  const files = new Set(comments.map((c) => `${c.folder}/${c.path}`));
  const first = fileName(comments[0]?.path ?? "");
  const head = `${n} ${n === 1 ? "comment" : "comments"} on ${first}`;
  const others = files.size - 1;
  return others > 0 ? `${head} and ${others} other ${others === 1 ? "file" : "files"}` : head;
}

/** What a request is called in the sidebar, palette and pinned prompt: its prose, else a summary of its comments. */
export function requestTitle(text: string): string {
  const { prose, comments } = splitComments(text);
  if (prose) return prose;
  return comments.length ? commentsSummary(comments) : text;
}

/** "line 12", "lines 12–14". */
export function linesLabel(start: number, end: number): string {
  return end > start ? `lines ${start}–${end}` : `line ${start}`;
}
