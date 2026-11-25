import type { OctoSlashCommand, SlashCommands } from "@octo/agent-client";

/**
 * Octo slash-command definitions and parsing, loaded on demand when `/` is typed or submitted
 * (kept out of `lib/slash.ts` so the initial entry chunk stays lean).
 */

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

/** Claude Code Desktop parity: `/btw [question]` opens the side-question panel and asks without interrupting the current session. */
export const BTW_COMMAND: OctoSlashCommand = {
  name: "btw",
  description: "Ask a side question without interrupting this session",
  args: "question",
  available: true,
  endpoint: "ui:btw",
};

/** The Octo commands of the menu and of `octoCommandFor`: the harness's (or the fallback), `/new`, and `/btw`, minus UI-disabled ones. */
export function octoCommands(cmds: SlashCommands | null, disabled?: ReadonlySet<string>): OctoSlashCommand[] {
  const list = cmds?.octo ?? OCTO_FALLBACK;
  const extras = [NEW_COMMAND, BTW_COMMAND].filter((cmd) => !list.some((c) => c.name === cmd.name));
  const all = extras.length > 0 ? [...list, ...extras] : list;
  return disabled && disabled.size > 0 ? all.filter((c) => !disabled.has(c.name)) : all;
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
