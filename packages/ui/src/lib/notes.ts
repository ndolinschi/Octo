import { NOTE_LIMITS, type Note } from "@octo/agent-client";

/** The first non-empty line of a body, at most 200 characters: what the harness derives when nobody wrote a description. */
export function autoDescription(body: string): string {
  const line = body.split("\n").find((l) => l.trim() !== "");
  return line ? Array.from(line.trim()).slice(0, NOTE_LIMITS.description).join("").trim() : "";
}

/** Characters as the harness counts them (code points, not UTF-16 units). */
export const charCount = (s: string): number => Array.from(s).length;

const tokensOf = (chars: number): number => Math.ceil(chars / 4);

function indexLine(n: Note): string {
  const tags = n.tags.length > 0 ? ` [${n.tags.slice(0, 5).join(", ")}]` : "";
  return `${n.id} · ${n.title}${n.description ? ` — ${n.description}` : ""}${tags}`;
}

export type NoteIndex = { listed: Note[]; more: number; tokens: number };

/** The notes the model's index lists, as the harness builds it: pinned first, then by the later of last read and updated; 1 500 tokens. */
export function noteIndex(notes: readonly Note[]): NoteIndex {
  const key = (n: Note) => (n.last_read_at > n.updated_at ? n.last_read_at : n.updated_at);
  const ordered = notes
    .map((n, i) => ({ n, i }))
    .sort((a, b) => Number(b.n.pinned) - Number(a.n.pinned) || key(b.n).localeCompare(key(a.n)) || b.i - a.i)
    .map((x) => x.n);
  const cost = (n: Note) => tokensOf(charCount(indexLine(n)) + 1);
  const total = ordered.reduce((sum, n) => sum + cost(n), 0);
  if (total <= NOTE_LIMITS.indexTokens) return { listed: ordered, more: 0, tokens: total };
  const listed: Note[] = [];
  let used = 0;
  for (const n of ordered) {
    const left = ordered.length - listed.length;
    if (used + cost(n) + tokensOf(`${left} more notes — use search_notes`.length + 1) > NOTE_LIMITS.indexTokens) break;
    used += cost(n);
    listed.push(n);
  }
  const more = ordered.length - listed.length;
  return { listed, more, tokens: used + tokensOf(`${more} more notes — use search_notes`.length + 1) };
}

/** The quiet footer line: what the model sees of the notes. */
/**
 * A note's second line in a list (P3): its description in plain words — an automatic one is the note's first line, which may
 * be a Markdown heading ("# Migrations"), shown without its marks — then its tags. The row truncates the end.
 */
export function noteLine(note: Pick<Note, "description" | "tags">): string {
  const description = note.description.replace(/^\s*#{1,6}\s+/, "").trim() || "No description";
  const tags = note.tags.map((t) => `#${t}`).join(" ");
  return tags ? `${description} · ${tags}` : description;
}

export function indexFooter(notes: readonly Note[]): string {
  const idx = noteIndex(notes);
  const count = idx.listed.length;
  const base = `Agents see an index of ${count} ${count === 1 ? "note" : "notes"} (≈${idx.tokens.toLocaleString("en-US")} tokens); bodies are read on demand`;
  return idx.more > 0 ? `${base}. ${idx.more} more are found by search.` : base;
}

export type PinState = { count: number; chars: number; canPin: boolean; reason: string };

/** Where the pin limits stand with `note` (a draft when `id` is undefined) pinned: how many and how long, and whether it fits. */
export function pinState(notes: readonly Note[], draft: { id?: string; size: number }): PinState {
  const others = notes.filter((n) => n.pinned && n.id !== draft.id);
  const count = others.length + 1;
  const chars = others.reduce((sum, n) => sum + n.size, 0) + draft.size;
  if (count > NOTE_LIMITS.pinned) return { count, chars, canPin: false, reason: `Only ${NOTE_LIMITS.pinned} notes can be pinned. Unpin one first.` };
  if (chars > NOTE_LIMITS.pinnedChars)
    return {
      count,
      chars,
      canPin: false,
      reason: `Pinned notes hold ${NOTE_LIMITS.pinnedChars.toLocaleString("en-US")} characters together; these would be ${chars.toLocaleString("en-US")}. Shorten the note or unpin another.`,
    };
  return { count, chars, canPin: true, reason: "" };
}

/** Notes whose title, description or tags contain every word of the query (bodies are not loaded in the list). */
export function filterNotes(notes: readonly Note[], query: string): Note[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...notes];
  return notes.filter((n) => {
    const hay = `${n.title} ${n.description} ${n.tags.join(" ")}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** Tags typed as "a, b c" become ["a", "b c"]: trimmed, no empties, no repeats. */
export function parseTags(text: string): string[] {
  return [
    ...new Set(
      text
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
    ),
  ];
}

/** A file name for an exported note. */
export function noteFileName(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return `${slug || "note"}.md`;
}

/** The title of an imported file: its name without the extension. */
export function titleFromFileName(name: string): string {
  return name
    .replace(/\.(md|markdown|txt)$/i, "")
    .replace(/[-_]+/g, " ")
    .trim();
}

/** The notes list order: pinned first, then newest change. */
export function sortNotes(notes: readonly Note[]): Note[] {
  return [...notes].sort((a, b) => Number(b.pinned) - Number(a.pinned) || Date.parse(b.updated_at) - Date.parse(a.updated_at));
}
