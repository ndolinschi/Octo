import type { CommandSuggestion, ProjectCommand } from "@octo/agent-client";

/** The harness's limits (apps/harness/docs/commands.md), checked here so the form says what is wrong before saving. */
export const MAX_COMMANDS = 50;
export const MAX_PINNED = 2;
export const MAX_NAME = 60;
export const MAX_COMMAND_BYTES = 4096;

function hasForbiddenChar(name: string): boolean {
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (code < 32 || name[i] === "/" || name[i] === "\\") return true;
  }
  return false;
}

/** One sentence per problem, or null when the list can be saved. */
export function commandsProblem(list: readonly ProjectCommand[]): string | null {
  if (list.length > MAX_COMMANDS) return `A project holds at most ${MAX_COMMANDS} commands. Remove one first.`;
  const seen = new Set<string>();
  for (const c of list) {
    const name = c.name.trim();
    if (!name) return "Every command needs a name.";
    if (name.length > MAX_NAME) return `“${name.slice(0, 20)}…” is longer than ${MAX_NAME} characters. Shorten the name.`;
    if (hasForbiddenChar(name)) return `“${name}” can only use letters, digits, spaces and dashes.`;
    const key = name.toLowerCase();
    if (seen.has(key)) return `Two commands are named “${name}”. Names must differ.`;
    seen.add(key);
    if (!c.command.trim()) return `“${name}” has no command line.`;
    if (new TextEncoder().encode(c.command).length > MAX_COMMAND_BYTES) return `The command of “${name}” is too long (max ${MAX_COMMAND_BYTES} characters).`;
    const cwd = c.cwd ?? "";
    if (cwd.startsWith("/") || /(^|\/)\.\.(\/|$)/.test(cwd)) return `The folder of “${name}” must stay inside the project: use a path inside it.`;
  }
  if (list.filter((c) => c.pinned).length > MAX_PINNED) return `Only ${MAX_PINNED} commands can be buttons in the header; the rest stay in the Run menu.`;
  return null;
}

/** A name for a new command that does not clash (case-insensitively) with the ones there. */
export function uniqueName(base: string, list: readonly Pick<ProjectCommand, "name">[]): string {
  const taken = new Set(list.map((c) => c.name.trim().toLowerCase()));
  const root = base.trim().slice(0, MAX_NAME - 4) || "Command";
  if (!taken.has(root.toLowerCase())) return root;
  for (let n = 2; ; n++) {
    const next = `${root} ${n}`;
    if (!taken.has(next.toLowerCase())) return next;
  }
}

/** A suggestion becomes a command; its folder is the label the harness reported. */
export function commandFromSuggestion(s: CommandSuggestion, list: readonly Pick<ProjectCommand, "name">[]): ProjectCommand {
  return { name: uniqueName(s.name, list), command: s.command, ...(s.cwd ? { cwd: s.cwd } : {}) };
}

/** Suggestions not yet in the project, grouped by their source file in a stable order. */
export function openSuggestions(list: readonly CommandSuggestion[]): CommandSuggestion[] {
  const rank = { "package.json": 0, Makefile: 1, justfile: 2 } as const;
  return list.filter((s) => !s.configured).sort((a, b) => rank[a.source] - rank[b.source]);
}

/** Pinned first (as the top row shows them), then the rest in the order the project holds them. */
export function menuOrder(list: readonly ProjectCommand[]): ProjectCommand[] {
  return [...list.filter((c) => c.pinned), ...list.filter((c) => !c.pinned)];
}

/** Pins `name` when there is room, else the oldest pin steps down: never more than `MAX_PINNED`. */
export function withPinned(list: readonly ProjectCommand[], name: string, pinned: boolean): ProjectCommand[] {
  const next = list.map((c) => (c.name === name ? { ...c, pinned } : c));
  if (!pinned) return next.map((c) => (c.name === name ? withoutPin(c) : c));
  const pins = next.filter((c) => c.pinned);
  if (pins.length <= MAX_PINNED) return next;
  const drop = pins.find((c) => c.name !== name);
  return next.map((c) => (c.name === drop?.name ? withoutPin(c) : c));
}

function withoutPin(c: ProjectCommand): ProjectCommand {
  const { pinned: _pinned, ...rest } = c;
  return rest;
}

/** The review's offered names after command `from` was renamed to `to` (case-insensitive match; the place in the list is kept). */
export function renameOffered(names: readonly string[], from: string, to: string): string[] {
  const key = from.toLowerCase();
  const out: string[] = [];
  for (const n of names) {
    const next = n.toLowerCase() === key ? to : n;
    if (!out.some((o) => o.toLowerCase() === next.toLowerCase())) out.push(next);
  }
  return out;
}

/** Mechanical globs from a textarea: one per line, trimmed, no blanks, no repeats. */
export function parseGlobs(text: string): string[] {
  return [
    ...new Set(
      text
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean),
    ),
  ];
}
