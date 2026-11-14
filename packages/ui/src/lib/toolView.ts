import { acpCall } from "./tools";
import type { StepState, TurnEnd } from "./transcript";

/*
 * retest3 G1/G2: a tool call as an action with its outcome. Pure view models for the opened call's body (its own chunk, with
 * `ToolDetail`): which renderer, the command and its output tail, the exit in words, the file and lines a read covered, an
 * edit's line diff, a tidy key–value view of anything else, and one plain line for a call a stop or a refusal cut short.
 */

export type ToolKind = "shell" | "read" | "edit" | "search" | "fetch" | "other";

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Rec) : {});
const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** The arguments an agent passed: a built-in call's input, an ACP call's `raw_input`. */
export function callArgs(name: string, input: unknown): Rec {
  return acpCall(name, input) ? rec(rec(input).raw_input) : rec(input);
}

/** Which body renders a call: built-in `bash` and ACP `execute` are commands, `read_file` / ACP `read` reads, edits and writes edits. */
export function toolKind(name: string, input: unknown): ToolKind {
  const acp = acpCall(name, input) !== null;
  if (acp) {
    if (name === "execute") return "shell";
    if (name === "read") return "read";
    if (name === "edit") return "edit";
    if (name === "search") return "search";
    if (name === "fetch") return "fetch";
    return "other";
  }
  if (name === "bash") return "shell";
  if (name === "read_file") return "read";
  if (name === "write_file" || name === "edit") return "edit";
  if (name === "grep" || name === "glob" || name === "list_dir" || /search/i.test(name)) return "search";
  if (/fetch/i.test(name)) return "fetch";
  return "other";
}

// --- how a call that did not finish reads ----------------------------------------------------------------------------

/** The harness's interruption texts (built-in `interruptedResult`, an ACP orchestrator's close of an open call). */
const HARNESS_INTERRUPTED = /^(interrupted: the tool call did not complete|the agent stopped before this tool call finished)\.?$/i;
/** An ACP agent's answer for a call a person declined or stopped (Claude Code's "The user doesn't want to proceed…", and the like). */
const AGENT_REFUSAL = /doesn't want to proceed|tool use was rejected|^rejected\b|^cancell?ed\b|interrupted by (the )?user/i;
/** The harness's answer to a built-in agent's call a person denied (v7 §2): `Denied by the user[: note]`. */
const HARNESS_DENIED = /^denied by the user(?::\s*(.*))?$/is;

/**
 * Whether an error result is a person's refusal rather than a failure: the agent's refusal text and the harness's deny. `lib/transcript`'s
 * `isInterruption` counts the agent's text only in a turn known to be stopped; a refusal in any other turn is a decline, never a failure.
 * (Candidate for `lib/transcript.ts` as `isRefusal`; kept here while another change edits that module.)
 */
export function isRefusal(result: { content: unknown; is_error: boolean } | undefined): boolean {
  if (!result?.is_error || typeof result.content !== "string") return false;
  const text = result.content.trim();
  return AGENT_REFUSAL.test(text) || HARNESS_DENIED.test(text);
}

/** `stepState` with a refusal read as stopped (the row's glyph and word: never "failed" for what a person declined). */
export function viewState(state: StepState, result: { content: unknown; is_error: boolean } | undefined): StepState {
  return state === "error" && isRefusal(result) ? "stopped" : state;
}

/** "11:39" in the reader's clock; empty when the time is unknown. */
export function clockTime(iso: string | null | undefined, locale?: string): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  return Number.isNaN(t) ? "" : new Date(t).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
}

/**
 * One plain line for a call a stop, a refusal or an interruption cut short — never the agent's or the harness's own text (that
 * stays under Raw). `at`: when the result was stored ("" when unknown).
 */
export function stoppedLine(result: { content: unknown; is_error: boolean } | undefined, end: TurnEnd, at: string): string {
  const when = at ? ` at ${at}` : "";
  const text = typeof result?.content === "string" ? result.content.trim() : "";
  const denied = HARNESS_DENIED.exec(text);
  if (denied) return `Declined by you${when}${denied[1]?.trim() ? ` — “${denied[1].trim()}”` : ""}. It did not run.`;
  if (end === "cancelled") return `Stopped by you${when}.`;
  if (result && AGENT_REFUSAL.test(text)) return `Declined${when}. It did not run.`;
  if (end === "failed") return `Interrupted${when} — the request ended before this finished.`;
  if (result && HARNESS_INTERRUPTED.test(text)) return `Stopped${when} before it finished.`;
  return "Stopped before it finished.";
}

// --- commands ----------------------------------------------------------------------------------------------------------

/** The command line of a shell call: `bash`'s `command`, an ACP `execute` call's `raw_input.command` or else its title. */
export function commandOf(name: string, input: unknown): string {
  const args = callArgs(name, input);
  const cmd = str(args.command) || str(args.cmd);
  if (cmd) return cmd;
  const acp = acpCall(name, input);
  return acp ? acp.title.replace(/^run\s+/i, "") : "";
}

/** The exit code a command's output names last ("exit status 2", "exit code 1", "Exit code: 2"); null when it names none. */
export function exitCode(text: string): number | null {
  const all = [...text.matchAll(/exit (?:status|code)[:\s]+(-?\d+)/gi)];
  const last = all.at(-1)?.[1];
  return last === undefined ? null : Number(last);
}

/** The exit in words: "Exited 0", "Failed (exit 2)", "Failed", "Stopped", "Running". */
export function exitLabel(state: StepState, output: string): string {
  if (state === "running") return "Running";
  if (state === "stopped") return "Stopped";
  const code = exitCode(output);
  if (state === "error") return code !== null && code !== 0 ? `Failed (exit ${code})` : "Failed";
  return `Exited ${code ?? 0}`;
}

/** The last `n` lines of a text (a trailing newline adds none) and how many come before them. */
export function tailLines(text: string, n: number): { lines: string[]; hidden: number; total: number } {
  const all = splitLines(text);
  const lines = all.slice(Math.max(0, all.length - n));
  return { lines, hidden: all.length - lines.length, total: all.length };
}

export function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** Milliseconds between two ISO times; null when either is missing or the order is wrong. */
export function spanMs(from: string | null | undefined, to: string | null | undefined): number | null {
  if (!from || !to) return null;
  const ms = Date.parse(to) - Date.parse(from);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

// --- reads -----------------------------------------------------------------------------------------------------------

export type ReadTarget = { path: string; folder: string; start: number | null; end: number | null };

/** The file a read covered and its lines: `read_file`'s `path` / `offset` / `limit`, an ACP read's location and `raw_input`. */
export function readTarget(name: string, input: unknown): ReadTarget | null {
  const args = callArgs(name, input);
  const acp = acpCall(name, input);
  const loc = acp?.locations[0];
  const path = str(args.path) || str(args.file_path) || loc?.path || "";
  if (!path) return null;
  const offset = num(args.offset) ?? loc?.line ?? null;
  const limit = num(args.limit);
  const start = offset !== null && offset > 0 ? offset : limit !== null ? 1 : null;
  return { path, folder: str(rec(input).folder), start, end: start !== null && limit !== null && limit > 0 ? start + limit - 1 : null };
}

/** "src/x.ts:1–40", "src/x.ts:12", "src/x.ts". */
export function readLabel(t: Pick<ReadTarget, "path" | "start" | "end">): string {
  if (t.start === null) return t.path;
  return t.end !== null && t.end !== t.start ? `${t.path}:${t.start}–${t.end}` : `${t.path}:${t.start}`;
}

// --- edits -------------------------------------------------------------------------------------------------------------

export type DiffRow = { kind: "add" | "del" | "context"; text: string; old: number | null; new: number | null };

/** Above this many cells the middle of a diff is shown as all removed, then all added (the transcript must stay fast). */
const LCS_CELLS = 250_000;

/** A line diff of two texts: common ends trimmed, the middle by longest common subsequence (bounded), numbered from 1. */
export function lineDiff(before: string, after: string): DiffRow[] {
  const a = splitLines(before);
  const b = splitLines(after);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const rows: DiffRow[] = [];
  for (let i = 0; i < head; i++) rows.push({ kind: "context", text: a[i] ?? "", old: i + 1, new: i + 1 });
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  for (const op of middle(midA, midB)) {
    if (op.kind === "context") rows.push({ kind: "context", text: op.text, old: head + op.i + 1, new: head + op.j + 1 });
    else if (op.kind === "del") rows.push({ kind: "del", text: op.text, old: head + op.i + 1, new: null });
    else rows.push({ kind: "add", text: op.text, old: null, new: head + op.j + 1 });
  }
  for (let k = tail; k > 0; k--) rows.push({ kind: "context", text: a[a.length - k] ?? "", old: a.length - k + 1, new: b.length - k + 1 });
  return rows;
}

type Op = { kind: DiffRow["kind"]; text: string; i: number; j: number };

function middle(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  if (n * m > LCS_CELLS || n === 0 || m === 0)
    return [...a.map((text, i): Op => ({ kind: "del", text, i, j: 0 })), ...b.map((text, j): Op => ({ kind: "add", text, i: 0, j }))];
  const w = m + 1;
  const t = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      t[i * w + j] = a[i] === b[j] ? (t[(i + 1) * w + j + 1] ?? 0) + 1 : Math.max(t[(i + 1) * w + j] ?? 0, t[i * w + j + 1] ?? 0);
  const out: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) out.push({ kind: "context", text: a[i++] ?? "", i: i - 1, j: j++ });
    // Removals before additions on a tie, as diffs usually read.
    else if (i < n && (j === m || (t[(i + 1) * w + j] ?? 0) >= (t[i * w + j + 1] ?? 0))) out.push({ kind: "del", text: a[i] ?? "", i: i++, j });
    else out.push({ kind: "add", text: b[j] ?? "", i, j: j++ });
  }
  return out;
}

export function diffCounts(rows: readonly DiffRow[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const r of rows) {
    if (r.kind === "add") added++;
    else if (r.kind === "del") removed++;
  }
  return { added, removed };
}

/** Rows shifted to where the snippet sits in its file (`line`: the file line of the snippet's first line). */
export function placeRows(rows: readonly DiffRow[], line: number): DiffRow[] {
  const d = line - 1;
  return rows.map((r) => ({ ...r, old: r.old === null ? null : r.old + d, new: r.new === null ? null : r.new + d }));
}

/** The first changed line in the new text (an added line, else the line after a removal); null when nothing changed. */
export function firstChangedLine(rows: readonly DiffRow[]): number | null {
  for (let k = 0; k < rows.length; k++) {
    const r = rows[k];
    if (!r || r.kind === "context") continue;
    if (r.new !== null) return r.new;
    for (let q = k + 1; q < rows.length; q++) {
      const n = rows[q]?.new;
      if (n !== null && n !== undefined) return n;
    }
    for (let q = k - 1; q >= 0; q--) {
      const n = rows[q]?.new;
      if (n !== null && n !== undefined) return n + 1;
    }
    return 1;
  }
  return null;
}

/**
 * The compact preview: from `context` rows before the first change, at most `max` rows; changes far apart lose the context in
 * between (a gap row says how many lines it skips). `rest`: the changed rows left out.
 */
export function previewRows(rows: readonly DiffRow[], max = 12, context = 2): { rows: (DiffRow | { kind: "gap"; lines: number })[]; rest: number } {
  const keep = new Array<boolean>(rows.length).fill(false);
  rows.forEach((r, i) => {
    if (r.kind === "context") return;
    for (let k = Math.max(0, i - context); k <= Math.min(rows.length - 1, i + context); k++) keep[k] = true;
  });
  const out: (DiffRow | { kind: "gap"; lines: number })[] = [];
  let shown = 0;
  let skipped = 0;
  let last = -1;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    if (!keep[i]) continue;
    if (shown >= max) break;
    if (last >= 0 && i > last + 1) out.push({ kind: "gap", lines: i - last - 1 });
    out.push(r);
    shown++;
    last = i;
  }
  for (let i = last + 1; i < rows.length; i++) if (rows[i]?.kind !== "context") skipped++;
  return { rows: out, rest: skipped };
}

/** Every row of a full diff with long unchanged runs folded to a gap (the "Show all" view), capped at `cap` rows. */
export function foldedRows(rows: readonly DiffRow[], context = 3, cap = 2000): { rows: (DiffRow | { kind: "gap"; lines: number })[]; cut: number } {
  const all = previewRows(rows, Number.POSITIVE_INFINITY, context).rows;
  return { rows: all.slice(0, cap), cut: Math.max(0, all.length - cap) };
}

export type EditView = {
  path: string;
  folder: string;
  rows: DiffRow[];
  added: number;
  removed: number;
  /** Line numbers are the file's (a whole new file, a diff of whole texts); otherwise they count from the snippet's first line. */
  placed: boolean;
  /** The snippet's first new line, to find where it sits in the file (`placeRows`). */
  needle: string;
};

/** "diff /abs/path\n-old\n+new" (how the harness flattens an ACP diff content item) into before and after. */
export function parseAcpDiff(text: string): { path: string; before: string; after: string }[] {
  const out: { path: string; before: string[]; after: string[] }[] = [];
  for (const line of splitLines(text)) {
    const head = /^diff (.+)$/.exec(line);
    if (head?.[1]) out.push({ path: head[1], before: [], after: [] });
    else if (out.length && line.startsWith("-")) out.at(-1)?.before.push(line.slice(1));
    else if (out.length && line.startsWith("+")) out.at(-1)?.after.push(line.slice(1));
  }
  return out.map((d) => ({ path: d.path, before: d.before.join("\n"), after: d.after.join("\n") }));
}

/** An edit's line diff: built-in `edit` (old → new string), `write_file` (all added), an ACP edit (its diff result or its raw input). */
export function editView(name: string, input: unknown, result: string): EditView | null {
  const args = callArgs(name, input);
  const acp = acpCall(name, input);
  const folder = str(rec(input).folder);
  const path = str(args.path) || str(args.file_path) || acp?.locations[0]?.path || "";
  const view = (before: string, after: string, placed: boolean, p = path): EditView => {
    const rows = lineDiff(before, after);
    const changed = rows.find((r) => r.kind === "add") ?? rows.find((r) => r.kind !== "context");
    return { path: p, folder, rows, ...diffCounts(rows), placed, needle: placed ? "" : (changed?.text ?? splitLines(after)[0] ?? "") };
  };
  if (acp) {
    const [d] = parseAcpDiff(result);
    const line = acp.locations[0]?.line;
    if (d) {
      const v = view(d.before, d.after, d.before === "", d.path || path);
      // An ACP agent's location names the line the edit starts at: the snippet's numbers become the file's.
      return !v.placed && line ? { ...v, rows: placeRows(v.rows, line), placed: true } : v;
    }
  }
  if (typeof args.old_string === "string" && typeof args.new_string === "string") return path ? view(args.old_string, args.new_string, false) : null;
  const content = typeof args.content === "string" ? args.content : null;
  if (content !== null && path) return view("", content, true);
  return null;
}

// --- everything else ---------------------------------------------------------------------------------------------------

export type Pair = { key: string; value: string; mono: boolean };

const PAIR_MAX = 240;

/** The input as tidy key–value rows (nested values as compact JSON, long values cut); `title` / `locations` of an ACP call are the row's. */
export function inputPairs(name: string, input: unknown): Pair[] {
  const args = callArgs(name, input);
  return Object.entries(args).flatMap(([key, v]): Pair[] => {
    if (v === undefined || v === null || v === "") return [];
    const text = typeof v === "string" ? v : JSON.stringify(v);
    const cut = text.length > PAIR_MAX ? `${text.slice(0, PAIR_MAX - 1)}…` : text;
    return [{ key: key.replace(/_/g, " "), value: cut, mono: typeof v !== "string" || /[/\\]|^\S+$/.test(v) }];
  });
}

/** How many results a search answered: a JSON array's length, else its non-empty lines; null for nothing countable. */
export function resultCount(text: string): number | null {
  const t = text.trim();
  if (!t) return 0;
  if (t.startsWith("[")) {
    try {
      const v: unknown = JSON.parse(t);
      if (Array.isArray(v)) return v.length;
    } catch {
      // Not JSON after all: counted by lines below.
    }
  }
  const m = /^(\d+) (?:matches|results|files)\b/i.exec(t);
  if (m?.[1]) return Number(m[1]);
  return splitLines(t).filter((l) => l.trim()).length;
}

/** One line for a search, fetch or unknown call: what it looked for, where, and how many results. */
export function callSummary(kind: ToolKind, name: string, input: unknown, result: string | null, shorten: (path: string) => string = (p) => p): string {
  const args = callArgs(name, input);
  const what = str(args.pattern) || str(args.query) || str(args.q) || str(args.glob);
  const where = shorten(str(args.path)) || str(args.folder) || str(args.team);
  const url = str(args.url);
  const n = result === null ? null : resultCount(result);
  const count = n === null ? "" : ` · ${n} result${n === 1 ? "" : "s"}`;
  if (kind === "fetch" && url) return `Fetched ${url}`;
  if (what) return `Searched for “${what}”${where ? ` in ${where}` : ""}${count}`;
  if (kind === "search" && where) return `Listed ${where}${count}`;
  return "";
}

/** The call as JSON for the "Raw" view: the input as the agent passed it. */
export function rawInput(name: string, input: unknown): string {
  const acp = acpCall(name, input);
  const v = acp ? rec(input).raw_input : input;
  if (v === undefined || v === null) return "";
  return JSON.stringify(v, null, 2);
}

/** A collapsed row's verb for an ACP command ("git push" reads "Ran git push", "Run x" reads "Ran x"). */
export function acpCommandRow(title: string): { verb: string; arg: string } {
  const t = title.trim();
  return { verb: "Ran", arg: t.replace(/^run\s+/i, "") };
}

type Msg = { created_at: string; content: readonly { type: string; id?: string; tool_use_id?: string }[] };

/** When a call was announced and when its result was stored, from the loaded transcripts (any agent's); null when not loaded. */
export function callTimes(transcripts: Iterable<readonly Msg[] | undefined>, id: string): { start: string | null; end: string | null } {
  let start: string | null = null;
  let end: string | null = null;
  for (const list of transcripts) {
    if (!list) continue;
    for (const m of list)
      for (const b of m.content) {
        if (b.type === "tool_use" && b.id === id) start = m.created_at;
        else if (b.type === "tool_result" && b.tool_use_id === id) end = m.created_at;
      }
    if (start || end) break;
  }
  return { start, end };
}

/** The orchestrator request a call at `at` belongs to (the id changes are recorded under): its last prompt sent at or before then. */
export function turnIdAt(
  orchestrator: readonly { id: number; role: string; created_at: string; content: readonly { type: string }[] }[],
  at: string | null,
): number | null {
  if (!at) return null;
  const t = Date.parse(at);
  let id: number | null = null;
  for (const m of orchestrator) {
    if (Date.parse(m.created_at) > t) break;
    if (m.role === "user" && m.content.some((b) => b.type === "text")) id = m.id;
  }
  return id;
}

const GROUP: Record<string, [string, string, string]> = {
  command: ["ran", "command", "commands"],
  read: ["read", "file", "files"],
  edit: ["edited", "file", "files"],
  write: ["wrote", "file", "files"],
  list: ["listed", "folder", "folders"],
  search: ["ran", "search", "searches"],
  fetch: ["fetched", "page", "pages"],
  delete: ["deleted", "file", "files"],
  move: ["moved", "file", "files"],
  save_note: ["saved", "note", "notes"],
  delete_note: ["deleted", "note", "notes"],
  other: ["called", "tool", "tools"],
};

function groupKey(name: string, input: unknown): string {
  const acp = acpCall(name, input) !== null;
  if (acp && (name === "delete" || name === "move")) return name;
  if (name === "write_file") return "write";
  if (name === "list_dir") return "list";
  if (!acp && (name === "save_note" || name === "delete_note")) return name;
  const kind = toolKind(name, input);
  return kind === "shell" ? "command" : kind;
}

/**
 * The summary of a run of tool calls, built-in and ACP alike ("Ran 3 commands, read 1 file, edited 2 files"): one phrase per
 * kind of action, in the order they first ran (an ACP command and a built-in one are both commands).
 */
export function groupSummary(uses: readonly { name: string; input: unknown }[]): string {
  const counts = new Map<string, number>();
  for (const u of uses) {
    const key = groupKey(u.name, u.input);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const text = [...counts]
    .map(([key, n]) => {
      const [verb, one, many] = GROUP[key] ?? GROUP.other ?? ["called", "tool", "tools"];
      return `${verb} ${n} ${n === 1 ? one : many}`;
    })
    .join(", ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}
