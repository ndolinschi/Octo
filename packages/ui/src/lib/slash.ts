import type { OctoSlashCommand, SlashCommands } from "@octo/agent-client";

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

/** The Octo commands a harness without `getSlashCommands` still gets (the UI-side ones only). */
export const OCTO_FALLBACK: OctoSlashCommand[] = [
  { name: "mode", description: "Choose Agent, Ask or Plan for the next message", args: "ask|plan|agent", available: true, endpoint: "ui:mode" },
  { name: "model", description: "Choose the model", available: true, endpoint: "ui:model" },
  { name: "memory", description: "Open what the project remembers", available: true, endpoint: "ui:memory" },
  { name: "settings", description: "Open the project's settings", available: true, endpoint: "ui:settings" },
  { name: "help", description: "What these commands do", available: true, endpoint: "ui:help" },
];

/** Addition 9: `/new`, run by the UI itself (a new session, `lib/newSession.ts`); added when a harness does not list it. */
export const NEW_COMMAND: OctoSlashCommand = {
  name: "new",
  description: "Start a new session; with text, sends it there",
  args: "text",
  available: true,
  endpoint: "ui:new",
};

/** Slash command names suppressed when their corresponding UI tool tabs (`memory`, `review`) are disabled. */
export function disabledSlashCommands(flags: { memory: boolean; review: boolean }): ReadonlySet<string> {
  const out = new Set<string>();
  if (!flags.memory) out.add("memory");
  if (!flags.review) out.add("review");
  return out;
}

/** The Octo commands of the menu and of `octoCommandFor`: the harness's (or the fallback) and `/new`, minus UI-disabled ones. */
export function octoCommands(cmds: SlashCommands | null, disabled?: ReadonlySet<string>): OctoSlashCommand[] {
  const list = cmds?.octo ?? OCTO_FALLBACK;
  const all = list.some((c) => c.name === NEW_COMMAND.name) ? list : [...list, NEW_COMMAND];
  return disabled && disabled.size > 0 ? all.filter((c) => !disabled.has(c.name)) : all;
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
];

/**
 * A command whose argument is optional: Enter runs it (`/new` an empty session, `/model` the picker, `/review` the tab) and Tab puts
 * its name in the text to add the argument. A required argument (`/mode`, `/remember`, an agent's command) is completed on both.
 */
export function argsOptional(row: Pick<SlashRow, "group" | "name" | "args">): boolean {
  if (row.group !== "octo" || !row.args) return false;
  return row.args.startsWith("[") || row.name === NEW_COMMAND.name || row.name === "model";
}

/** The word after a `/` at the very start of the text, up to the caret; null when the text does not start with a slash command being typed. */
export function slashQuery(text: string, caret: number): string | null {
  const m = /^\/([^\s/]*)$/.exec(text.slice(0, caret));
  return m ? (m[1] ?? "") : null;
}

/** `/name rest` split into its parts; null for text that is not a slash command. */
export function parseSlash(text: string): { name: string; args: string } | null {
  const m = /^\/([a-z][\w-]*)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  return m ? { name: (m[1] ?? "").toLowerCase(), args: (m[2] ?? "").trim() } : null;
}

/** An Octo command named by `text` that the UI runs itself instead of sending (null for an agent's command or plain text). */
export function octoCommandFor(text: string, cmds: SlashCommands | null, disabled?: ReadonlySet<string>): { command: OctoSlashCommand; args: string } | null {
  const parsed = parseSlash(text);
  if (!parsed) return null;
  const command = octoCommands(cmds, disabled).find((c) => c.name === parsed.name);
  return command?.available ? { command, args: parsed.args } : null;
}
