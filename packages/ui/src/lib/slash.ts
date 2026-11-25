/** B11: one row of the slash menu. */
export type SlashRow = {
  id: string;
  group: "octo" | "agent";
  name: string;
  description: string;
  args?: string | undefined;
  available: boolean;
  reason?: string | undefined;
};
export type SlashGroup = { label: string; rows: SlashRow[] };

/** Slash command names suppressed when their corresponding UI tool tabs (`memory`, `review`, `side`) are disabled. */
export function disabledSlashCommands(flags: { memory: boolean; review: boolean; side?: boolean }): ReadonlySet<string> {
  const out = new Set<string>();
  if (!flags.memory) out.add("memory");
  if (!flags.review) out.add("review");
  if (flags.side === false) out.add("btw");
  return out;
}

/**
 * The names of every Octo command: the ones `chat/slashRun.ts` runs (a harness lists these in `getSlashCommands().octo`). The
 * composer highlights a command typed with one of these names (`lib/mentions.ts`).
 */
export const OCTO_COMMAND_NAMES: readonly string[] = [
  "compact",
  "clear",
  "mode",
  "model",
  "rewind",
  "export",
  "review",
  "context",
  "memory",
  "settings",
  "remember",
  "help",
  "new",
  "btw",
];

/**
 * A command whose argument is optional: Enter runs it (`/new` an empty session, `/btw` opens Side, `/model` the picker, `/review` the tab) and Tab puts
 * its name in the text to add the argument. A required argument (`/mode`, `/remember`, an agent's command) is completed on both.
 */
export function argsOptional(row: Pick<SlashRow, "group" | "name" | "args">): boolean {
  if (row.group !== "octo" || !row.args) return false;
  return row.args.startsWith("[") || row.name === "new" || row.name === "btw" || row.name === "model";
}

/** The word after a `/` at the very start of the text, up to the caret; null when the text does not start with a slash command being typed. */
export function slashQuery(text: string, caret: number): string | null {
  if (caret <= 0 || caret > 64 || text.charCodeAt(0) !== 47) return null;
  const m = /^\/([^\s/]*)$/.exec(text.slice(0, caret));
  return m ? (m[1] ?? "") : null;
}
