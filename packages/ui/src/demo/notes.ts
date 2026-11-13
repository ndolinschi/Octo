import { BridgeError, NOTE_LIMITS, type Note, type NoteDocument, type NoteInput, type NotePatch } from "@octo/agent-client";
import { charCount, autoDescription, parseTags, pinState } from "../lib/notes";

/** A demo note keeps its body; lists send it without. */
export type DemoNote = Note & { content: string };

let counter = 0;

export function newDemoNote(title: string, content: string, at: number, over: Partial<DemoNote> = {}): DemoNote {
  const iso = new Date(at).toISOString();
  counter += 1;
  return {
    id: `note_${at.toString(36)}${counter.toString(36)}`,
    title,
    description: autoDescription(content),
    description_auto: true,
    tags: [],
    pinned: false,
    content,
    size: charCount(content),
    author: "user",
    created_at: iso,
    updated_at: iso,
    last_read_at: "",
    read_count: 0,
    ...over,
  };
}

/** The atlas project's notes: a pinned rule, a few written ones, and enough more that the 1 500-token index overflows. */
export function seedNotes(now: number): DemoNote[] {
  const HOUR = 3_600_000;
  const notes: DemoNote[] = [
    newDemoNote("Deploy rules", "No deploys on Fridays.\nStaging is `atlas-stg` and needs the VPN. Ask before touching `src/billing/`.", now - 29 * HOUR, {
      description: "Rules that always apply to deploys and to the billing folder",
      description_auto: false,
      tags: ["rules", "deploy"],
      pinned: true,
    }),
  ];
  const subjects = ["Billing", "Auth", "Search", "Webhooks", "Exports", "Rate limits", "Migrations", "Dashboards", "Onboarding", "Observability"];
  const kinds = ["decisions", "open questions", "runbook", "interfaces", "known issues", "glossary", "test plan", "owners", "rollout", "history"];
  for (let i = 0; i < 99; i++) {
    const subject = subjects[i % subjects.length] ?? "Topic";
    const kind = kinds[Math.floor(i / subjects.length) % kinds.length] ?? "notes";
    const body = `# ${subject}: ${kind}\n\nWhat the team settled on for ${subject.toLowerCase()} (${kind}), kept short.\n\n- Point one about ${subject.toLowerCase()}\n- Point two, with a link to the ticket\n- Point three: who to ask\n`;
    const written = i % 4 !== 0;
    notes.push(
      newDemoNote(`${subject}: ${kind}`, body, now - (28 * HOUR - i * 17 * 60_000), {
        description: written ? `What was decided about ${subject.toLowerCase()} ${kind}, and when to read it` : autoDescription(body),
        description_auto: !written,
        tags: [subject.toLowerCase().replace(/ /g, "-"), kind.split(" ")[0] ?? kind],
        author: i % 3 === 0 ? "orchestrator" : "user",
      }),
    );
  }
  return notes;
}

/** The list form of a note: no body. */
export function listed(n: DemoNote): Note {
  const { content: _body, ...rest } = n;
  return rest;
}

function q(s: string): string {
  return s === "" || /[:#[\],"']|^\s|\s$|^(true|false|null)$/i.test(s) ? JSON.stringify(s) : s;
}

export function markdownOf(n: DemoNote): string {
  const head = [`id: ${n.id}`, `title: ${q(n.title)}`, `description: ${q(n.description)}`];
  if (n.description_auto) head.push("description_auto: true");
  head.push(`tags: [${n.tags.map(q).join(", ")}]`, `pinned: ${n.pinned}`, `created_at: ${n.created_at}`, `updated_at: ${n.updated_at}`);
  if (n.last_read_at) head.push(`last_read_at: ${n.last_read_at}`);
  if (n.read_count > 0) head.push(`read_count: ${n.read_count}`);
  return `---\n${head.join("\n")}\n---\n${n.content ? `\n${n.content}` : ""}`;
}

export function docOf(n: DemoNote): NoteDocument {
  return { ...n, markdown: markdownOf(n) };
}

type Fields = { title?: string; description?: string; tags?: string[]; pinned?: boolean; content?: string };

function unquote(v: string): string {
  const t = v.trim();
  return t.startsWith('"') && t.endsWith('"') ? (JSON.parse(t) as string) : t;
}

/** A small front-matter reader for the demo (title, description, tags, pinned). The harness has the strict one. */
function fieldsOf(input: NoteInput): Fields {
  if (input.markdown === undefined) {
    const out: Fields = {};
    if (input.title !== undefined) out.title = input.title;
    if (input.description !== undefined) out.description = input.description;
    if (input.tags !== undefined) out.tags = input.tags;
    if (input.pinned !== undefined) out.pinned = input.pinned;
    if (input.content !== undefined) out.content = input.content;
    return out;
  }
  const src = input.markdown.replace(/\r\n/g, "\n");
  const m = /^---\n([\s\S]*?)\n---\n?\n?([\s\S]*)$/.exec(src);
  if (!m) return { content: src, ...(input.title ? { title: input.title } : {}) };
  const out: Fields = { content: m[2] ?? "" };
  for (const [i, line] of (m[1] ?? "").split("\n").entries()) {
    const at = line.indexOf(":");
    if (at < 0) throw new BridgeError(400, "invalid_request", `markdown: line ${i + 2}: expected key: value`);
    const key = line.slice(0, at).trim();
    const val = line.slice(at + 1).trim();
    if (key === "title") out.title = unquote(val);
    if (key === "description") out.description = unquote(val);
    if (key === "pinned") out.pinned = val === "true";
    if (key === "tags")
      out.tags = parseTags(
        val
          .replace(/^\[|\]$/g, "")
          .split(",")
          .map(unquote)
          .join(","),
      );
  }
  return out;
}

function check(notes: readonly DemoNote[], id: string | undefined, f: Required<Pick<Fields, "title" | "description" | "pinned">> & { size: number }): void {
  const bad = (m: string) => new BridgeError(400, "invalid_request", m);
  if (!f.title.trim()) throw bad("title is required");
  if (charCount(f.description) > NOTE_LIMITS.description)
    throw bad(`description is ${charCount(f.description)} characters; the limit is ${NOTE_LIMITS.description}`);
  if (f.description.includes("\n")) throw bad("description must be one line");
  if (f.pinned) {
    const s = pinState(notes, id === undefined ? { size: f.size } : { id, size: f.size });
    if (!s.canPin) throw bad(s.reason);
  }
}

export function createDemoNote(notes: readonly DemoNote[], input: NoteInput, now: number): DemoNote {
  const f = fieldsOf(input);
  const content = f.content ?? "";
  const description = (f.description ?? "").trim();
  const pinned = f.pinned ?? false;
  check(notes, undefined, { title: f.title ?? "", description, pinned, size: charCount(content) });
  return newDemoNote((f.title ?? "").trim(), content, now, {
    ...(description ? { description, description_auto: false } : {}),
    tags: f.tags ?? [],
    pinned,
  });
}

export function patchDemoNote(notes: readonly DemoNote[], n: DemoNote, patch: NotePatch): void {
  const f = fieldsOf(patch);
  const content = f.content ?? n.content;
  const title = f.title ?? n.title;
  const pinned = f.pinned ?? n.pinned;
  const description = f.description === undefined ? n.description : f.description.trim();
  check(notes, n.id, { title, description, pinned, size: charCount(content) });
  const derive = f.description === "" || (f.description === undefined && n.description_auto && f.content !== undefined);
  Object.assign(n, {
    title: title.trim(),
    content,
    size: charCount(content),
    pinned,
    tags: f.tags ?? n.tags,
    description: derive ? autoDescription(content) : description,
    description_auto: derive ? true : f.description !== undefined ? false : n.description_auto,
    updated_at: new Date().toISOString(),
  });
}
