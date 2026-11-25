import type { MemoryHit, Note } from "@octo/agent-client";

export type HitGroupId = "exchanges" | "knowledge" | "files" | "notes";

export const HIT_GROUPS: readonly { id: HitGroupId; label: string }[] = [
  { id: "exchanges", label: "Requests" },
  { id: "knowledge", label: "Knowledge" },
  { id: "files", label: "Files" },
  { id: "notes", label: "Notes" },
];

/** Where a hit opens: an exchange in its session, a task or fact in Knowledge, a file, a request in the chat, a note. */
export type HitTarget =
  | { to: "task"; taskId: string; factId: string | null }
  | { to: "file"; path: string }
  | { to: "message"; messageId: number }
  | { to: "session"; sessionId: string; exchangeId: string }
  | { to: "note"; noteId: string };

/**
 * A hit as the results list shows it (decision 93 b): line 1 is the item's own name; line 2 is the passage that matched
 * (one field, a window around the first match) or, when the match was in the name, the item's usual second line; the
 * date is the right tail.
 */
export type UiHit = {
  key: string;
  /** What the hit is (its row's glyph): the harness's hit kinds, and the notes the UI searches itself. */
  kind: MemoryHit["kind"] | "note";
  group: HitGroupId;
  name: string;
  /** The word the name marks (the first query word found in it), "" for none. */
  nameWord: string;
  /** The matching passage; null when the match was in the name (or no field matched). */
  passage: string | null;
  passageWord: string;
  /** The usual second line (a fact's task, a note's description, a task's goal); "" for none. Shown when `passage` is null. */
  context: string;
  date: string;
  superseded: boolean;
  target: HitTarget | null;
};

/** A fact id as hits spell it: `<taskId>/<factId>`. */
export function splitFactId(id: string): { taskId: string; factId: string } | null {
  const i = id.indexOf("/");
  return i > 0 && i < id.length - 1 ? { taskId: id.slice(0, i), factId: id.slice(i + 1) } : null;
}

function targetOf(hit: MemoryHit): HitTarget | null {
  switch (hit.kind) {
    case "task":
      return { to: "task", taskId: hit.id, factId: null };
    case "fact": {
      const ref = splitFactId(hit.id);
      const taskId = hit.task_id ?? ref?.taskId;
      return taskId ? { to: "task", taskId, factId: ref?.factId ?? null } : null;
    }
    case "file":
      return { to: "file", path: hit.id };
    case "exchange":
      return hit.session_id ? { to: "session", sessionId: hit.session_id, exchangeId: hit.id } : null;
    case "message": {
      const n = Number(hit.id);
      return Number.isInteger(n) ? { to: "message", messageId: n } : null;
    }
  }
}

const GROUP_OF: Record<MemoryHit["kind"], HitGroupId> = { exchange: "exchanges", message: "exchanges", task: "knowledge", fact: "knowledge", file: "files" };

/** Markdown marks out of a snippet: a row shows plain words, never "## " or "**". */
export function plainText(text: string): string {
  return text
    .replace(/```/g, " ")
    .replace(/^\s*#{1,6}\s+/gm, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|`)/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

/** A line break in a snippet is where one field ended and the next began; text shown on one line drops it. */
const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

const SENTENCE_END = /(?<=[.!?])[ \t]+(?=[A-Z0-9“"(])|\n+/;

/** The first sentence of a text: a row's usual second line. */
export function firstSentence(text: string): string {
  return text.split(SENTENCE_END)[0]?.trim() ?? "";
}

/**
 * One field's matching passage: the sentence of `text` that holds `word`, cut to `max` characters around it. A hit's
 * snippet may run several fields together; a sentence never crosses one, so the row shows one field only.
 */
export function passageAround(text: string, word: string, max = 96): string {
  const lower = word.toLowerCase();
  const parts = text.trim().split(SENTENCE_END);
  const sentence = (word ? parts.find((x) => x.toLowerCase().includes(lower)) : undefined) ?? parts[0] ?? text;
  return windowAround(sentence.replace(/^\s*[-*+•]\s+/, ""), word, max);
}

/** The snippet without the item's own name at its start (a harness snippet often begins with the title). */
export function afterName(name: string, snippet: string): string {
  const flat = snippet.replace(/^…\s*/, "").trim();
  if (name !== "" && flat.toLowerCase().startsWith(name.toLowerCase())) return flat.slice(name.length).replace(/^[\s.:;,\-–—]+/, "");
  return flat;
}

export function toUiHit(hit: MemoryHit, q: string): UiHit {
  const base = {
    key: `${hit.kind}:${hit.id}`,
    kind: hit.kind,
    group: GROUP_OF[hit.kind],
    date: hit.date,
    superseded: hit.superseded === true,
    target: targetOf(hit),
  };
  const snippet = plainText(hit.snippet);
  if (hit.kind === "fact") {
    // A fact is its own text; the harness sends the task's title as the hit's title.
    const word = matchWord(snippet, q);
    return { ...base, name: windowAround(oneLine(snippet), word, 80), nameWord: word, passage: null, passageWord: "", context: oneLine(plainText(hit.title)) };
  }
  const name = oneLine(plainText(hit.title));
  const nameWord = matchWord(name, q);
  const rest = afterName(name, snippet);
  if (nameWord !== "")
    return { ...base, name, nameWord, passage: null, passageWord: "", context: hit.kind === "task" || hit.kind === "file" ? firstSentence(rest) : "" };
  const passageWord = matchWord(rest, q);
  return { ...base, name, nameWord: "", passage: rest === "" ? null : passageAround(rest, passageWord), passageWord, context: "" };
}

/** One hit per item: the first of each key stays. */
export function dedupeHits(hits: readonly UiHit[]): UiHit[] {
  const seen = new Set<string>();
  return hits.filter((h) => (seen.has(h.key) ? false : (seen.add(h.key), true)));
}

const words = (q: string) =>
  q
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w !== "");

/** Notes the harness's memory search does not cover: every word of the query in the title, description or a tag. Newest first. */
export function noteHits(notes: readonly Note[], q: string, limit = 5): UiHit[] {
  const ws = words(q);
  if (ws.length === 0) return [];
  return notes
    .filter((n) => {
      const text = `${n.title}\n${n.description}\n${n.tags.join(" ")}`.toLowerCase();
      return ws.every((w) => text.includes(w));
    })
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .slice(0, limit)
    .map((n) => {
      const nameWord = matchWord(n.title, q);
      const inDescription = nameWord === "" ? matchWord(n.description, q) : "";
      return {
        key: `note:${n.id}`,
        kind: "note" as const,
        group: "notes" as const,
        name: n.title,
        nameWord,
        passage: inDescription ? passageAround(n.description, inDescription) : null,
        passageWord: inDescription,
        context: n.description,
        date: n.updated_at,
        superseded: false,
        target: { to: "note" as const, noteId: n.id },
      };
    });
}

export type HitGroup = { id: HitGroupId; label: string; hits: UiHit[] };

/** Hits by kind in the fixed order Exchanges, Knowledge, Files, Notes; empty groups are left out; current before superseded, stable. */
export function groupHits(hits: readonly UiHit[]): HitGroup[] {
  return HIT_GROUPS.map((g) => {
    const mine = hits.filter((h) => h.group === g.id);
    return { ...g, hits: [...mine.filter((h) => !h.superseded), ...mine.filter((h) => h.superseded)] };
  }).filter((g) => g.hits.length > 0);
}

/** The first query word found in `text`: the part a row marks. "" when none is. */
export function matchWord(text: string, q: string): string {
  const lower = text.toLowerCase();
  return words(q).find((w) => lower.includes(w)) ?? "";
}

/**
 * The part of a snippet a one-line row can show: at most `max` characters with the matched word inside, an ellipsis on
 * each cut side. A row truncates its text at the end, so the match sits near the start of the window — at most `LEAD`
 * characters after it — and a short row still shows it (B33: a window that ended at the text's end put a late match past
 * the row's ellipsis).
 */
export function windowAround(text: string, word: string, max = 72): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const at = word ? flat.toLowerCase().indexOf(word.toLowerCase()) : -1;
  if (at < 0) return flat;
  // Start at a word boundary within the lead, so the window does not open mid-word.
  let from = Math.max(0, at - LEAD);
  if (from > 0) {
    const space = flat.indexOf(" ", from);
    if (space >= 0 && space < at) from = space + 1;
  }
  const cut = flat.slice(from, from + max).trim();
  return `${from > 0 ? "…" : ""}${cut}${from + max < flat.length ? "…" : ""}`;
}

/** Characters of context kept before a match in a cut snippet. */
const LEAD = 16;

/** A query is sent from this length on (one letter matches nearly everything). */
export const MIN_QUERY = 2;
export const searchable = (q: string): boolean => q.trim().length >= MIN_QUERY;

/** The harness answers at most this many hits. */
export const HIT_LIMIT = 10;

export function emptyText(q: string, message: string | undefined): string {
  const lead = message && message.trim() !== "" ? message.trim().charAt(0).toUpperCase() + message.trim().slice(1) : "Nothing in memory matches";
  return `${lead} “${q.trim()}”`;
}
